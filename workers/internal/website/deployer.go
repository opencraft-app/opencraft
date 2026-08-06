package website

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/tencentyun/cos-go-sdk-v5"
)

// cosClient 包装 COS 客户端 + 元信息
type cosClient struct {
	bucket string
	region string
	envID  string
	client *cos.Client
}

// Deployer 部署执行器
type Deployer struct {
	ctlBaseURL           string
	httpClient           *http.Client
	maxArtifactBytes     int64
	maxFiles             int
	maxUncompressedBytes int64
	uploadsPerMinute     int64
	rateLimitRedis       *redis.Client
	internalToken        string
}

func NewDeployer() *Deployer {
	d := &Deployer{
		ctlBaseURL: getEnv("CTL_BASE_URL", "http://ctl-api.ctl.svc.cluster.local"),
		httpClient: &http.Client{Timeout: 30 * time.Second},
		// 这些上限只是 worker 侧的兜底防御，精确的按套餐校验由 ctl 在创建发布时完成。
		// 因此默认值必须不小于最大套餐允许的额度，否则会出现
		// 「ctl 放行、worker 拒绝」的部署失败：当前最大套餐允许50MB 制品 / 500 文件。
		maxArtifactBytes: getPositiveInt64Env("WEBSITE_MAX_ARTIFACT_BYTES", 64*1024*1024),
		maxFiles:         int(getPositiveInt64Env("WEBSITE_MAX_FILES", 500)),
		// 解压后总量上限用于防解压炸弹。条目是流式上传的，不随此值放大内存占用；
		// 真正影响峰值内存的是 maxArtifactBytes（zip 需要整体载入才能随机读取条目），
		// 峰值约为 MAX_CONCURRENCY × maxArtifactBytes。
		maxUncompressedBytes: getPositiveInt64Env("WEBSITE_MAX_UNCOMPRESSED_BYTES", 256*1024*1024),
		uploadsPerMinute:     getPositiveInt64Env("WEBSITE_COS_UPLOADS_PER_MINUTE", 8000),
	}

	// TCB 环境通过 COS Service API 动态发现，无需静态配置
	// 首次调用 selectTCBEnv / getTCBEnvByID 时自动触发发现
	return d
}

func (d *Deployer) SetRateLimitRedisClient(client *redis.Client) {
	d.rateLimitRedis = client
}

func (d *Deployer) SetInternalToken(token string) {
	d.internalToken = token
}

func (d *Deployer) newInternalRequest(method, url string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	if d.internalToken != "" {
		req.Header.Set("X-Internal-Token", d.internalToken)
	}
	return req, nil
}

// ClaimOperation makes ctl's durable lease transition before this worker touches COS.
func (d *Deployer) ClaimOperation(opID string) (*Operation, bool, error) {
	workerID, err := os.Hostname()
	if err != nil || workerID == "" {
		workerID = "website-deployer"
	}
	body, _ := json.Marshal(map[string]interface{}{
		"worker_id":     workerID,
		"lease_seconds": 900,
	})
	req, err := d.newInternalRequest(http.MethodPost, d.ctlBaseURL+"/internal/ctl/websites/operations/"+opID+"/claim", bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("claim request %s: %w", opID, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("claim operation %s: %w", opID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("claim operation %s status %d", opID, resp.StatusCode)
	}
	var result struct {
		Code string `json:"code"`
		Data struct {
			Claimed   bool       `json:"claimed"`
			Operation *Operation `json:"operation"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, false, fmt.Errorf("decode claim operation %s: %w", opID, err)
	}
	return result.Data.Operation, result.Data.Claimed, nil
}

// getCosForEnv 根据 TCB 环境ID 动态发现并创建 COS 客户端
func (d *Deployer) getCosForEnv(envID string) *cosClient {
	env := getTCBEnvByID(envID)
	if env == nil {
		return nil
	}
	return newCosClientFromEnv(env)
}

// getSitePublicURL 返回 TCB 静态托管原生 URL，不经过 Vela 代理。
func (d *Deployer) getSitePublicURL(op Operation) string {
	env := getTCBEnvByID(op.TCBEnvID)
	if env == nil || env.EnvID == "" || env.AppID == "" {
		return ""
	}
	return fmt.Sprintf("https://%s-%s.tcloudbaseapp.com/%sindex.html",
		env.EnvID, env.AppID, sitePublishedPrefix(op.SiteID))
}

// 站点在 CloudBase 静态托管桶里的目录布局：
//
//	sites/{siteID}/current/            对外服务的稳定目录，公开 URL 只指向这里
//	sites/{siteID}/releases/{relID}/   单次发布的暂存目录，成功后同步到 current/
//	_artifacts/{siteID}/{relID}.zip    上传的制品，保留用于套餐续费后恢复站点
//
// 之所以引入 current/ 这一层：早期实现把公开 URL 直接指向
// releases/{releaseID}/index.html，导致每次重新发布 URL 都变，
// 用户此前分享出去的链接会指向旧版本，且旧目录永不清理、存储单调增长。
func sitePublishedPrefix(siteID string) string {
	return fmt.Sprintf("sites/%s/current/", siteID)
}

func siteReleasePrefix(siteID, releaseID string) string {
	return fmt.Sprintf("sites/%s/releases/%s/", siteID, releaseID)
}

func siteArtifactKey(siteID, releaseID string) string {
	return fmt.Sprintf("_artifacts/%s/%s.zip", siteID, releaseID)
}

// contentTypeForKey 按扩展名推断 Content-Type。
//
// COS 在请求未携带 Content-Type 时按 application/octet-stream 存储，
// 浏览器会把 index.html 当附件下载而不是渲染页面，站点等于不可用。
// 因此上传时必须显式指定。
func contentTypeForKey(key string) string {
	ext := strings.ToLower(filepath.Ext(key))
	// 固定常见静态资源类型，不依赖运行环境的 mime 数据库（容器镜像里通常很不全）。
	switch ext {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "application/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".xml":
		return "application/xml; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// GetOperation 通过 HTTP API 获取单条 operation 详情（BLPOP 后专用，替代全量轮询）
func (d *Deployer) GetOperation(opID string) (*Operation, error) {
	req, err := d.newInternalRequest(http.MethodGet, d.ctlBaseURL+"/internal/ctl/websites/operations/"+opID, nil)
	if err != nil {
		return nil, fmt.Errorf("get operation request %s: %w", opID, err)
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get operation %s: %w", opID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get operation %s status %d", opID, resp.StatusCode)
	}

	var result struct {
		Code string    `json:"code"`
		Data Operation `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode operation %s: %w", opID, err)
	}
	return &result.Data, nil
}

// PollOperations 轮询待执行操作（fallback 用，主路径走 Redis BLPOP）
func (d *Deployer) PollOperations() ([]Operation, error) {
	req, err := d.newInternalRequest(http.MethodGet, d.ctlBaseURL+"/internal/ctl/websites/operations?status=created", nil)
	if err != nil {
		return nil, fmt.Errorf("poll operations request: %w", err)
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("poll operations: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("poll operations status %d", resp.StatusCode)
	}

	var result struct {
		Code string `json:"code"`
		Data struct {
			Operations []Operation `json:"operations"`
			Count      int         `json:"count"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode operations: %w", err)
	}
	return result.Data.Operations, nil
}

// Execute 执行一个操作
func (d *Deployer) Execute(op Operation) error {
	switch op.OperationType {
	case "create":
		return d.executeCreate(op)
	case "deploy":
		return d.executeDeploy(op)
	case "delete":
		return d.executeDelete(op)
	case "suspend":
		return d.executeSuspend(op)
	case "resume":
		return d.executeResume(op)
	default:
		return fmt.Errorf("unknown operation type: %s", op.OperationType)
	}
}

// executeCreate 创建站点 — 一期只登记稳定地址，实际内容在 deploy 时写入。
func (d *Deployer) executeCreate(op Operation) error {
	return d.completeOperation(op, sitePublishedPrefix(op.SiteID), d.getSitePublicURL(op))
}

// executeDeploy 部署站点：等待用户上传制品 → 发布到 current/。
func (d *Deployer) executeDeploy(op Operation) error {
	return d.publishRelease(op, true)
}

// executeResume 套餐续费后恢复站点：从保留的制品重新发布。
// 制品必须已存在，不需要像deploy 那样等待上传。
func (d *Deployer) executeResume(op Operation) error {
	if op.ReleaseID == "" {
		// 站点从未成功发布过内容，没有可恢复的制品，直接收敛为成功。
		return d.completeOperation(op, sitePublishedPrefix(op.SiteID), d.getSitePublicURL(op))
	}
	return d.publishRelease(op, false)
}

// publishRelease 是 deploy 与 resume 的共同实现。
//
// 流程：下载制品 → 校验 → 上传到 releases/{releaseID}/ 暂存 → 同步到 current/。
// 先写暂存目录再同步，是为了让上传中途失败不会破坏正在对外服务的 current/。
func (d *Deployer) publishRelease(op Operation, waitForArtifact bool) error {
	siteCos := d.getCosForEnv(op.TCBEnvID)
	if siteCos == nil {
		return d.failOperation(op, "CloudBase COS not configured for env: "+op.TCBEnvID)
	}

	// 1. 下载制品。deploy 场景下 Agent 可能还在上传，需要给它一个窗口。
	artifactKey := siteArtifactKey(op.SiteID, op.ReleaseID)
	maxRetries := 1
	if waitForArtifact {
		maxRetries = int(getPositiveInt64Env("WEBSITE_ARTIFACT_WAIT_ATTEMPTS", 6))
	}
	artifactWait := time.Duration(getPositiveInt64Env("WEBSITE_ARTIFACT_WAIT_SECONDS", 10)) * time.Second

	var resp *cos.Response
	var dlErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		resp, dlErr = siteCos.client.Object.Get(context.Background(), artifactKey, nil)
		if dlErr == nil {
			break
		}
		if attempt < maxRetries-1 {
			log.Printf("download artifact attempt %d/%d failed: %v, retrying in %s...",
				attempt+1, maxRetries, dlErr, artifactWait)
			time.Sleep(artifactWait)
		}
	}
	if dlErr != nil {
		return d.failOperation(op, fmt.Sprintf("download artifact after %d attempts: %v", maxRetries, dlErr))
	}
	defer resp.Body.Close()
	zipData, err := io.ReadAll(io.LimitReader(resp.Body, d.maxArtifactBytes+1))
	if err != nil {
		return d.failOperation(op, fmt.Sprintf("read artifact: %v", err))
	}
	if int64(len(zipData)) > d.maxArtifactBytes {
		return d.failOperation(op, fmt.Sprintf("artifact exceeds %d byte limit", d.maxArtifactBytes))
	}

	// 2. 解压并校验（防zip-slip / 文件数 / 解压炸弹，并要求根目录有 index.html）
	stagingPrefix := siteReleasePrefix(op.SiteID, op.ReleaseID)
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return d.failOperation(op, fmt.Sprintf("unzip artifact: %v", err))
	}
	if err := validateZipEntries(zipReader.File, d.maxFiles, d.maxUncompressedBytes); err != nil {
		return d.failOperation(op, fmt.Sprintf("invalid website archive: %v", err))
	}

	// 3. 并发上传到暂存目录。
	// semaphore 限制单次部署的并发数，配合 Redis 令牌桶保护整个环境的 COS 配额。
	maxConcurrency := 5
	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup
	var uploadErrors []error
	var errMu sync.Mutex
	relativeNames := make([]string, 0, len(zipReader.File))

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/") {
			continue
		}

		// 安全：清理路径，防止路径穿越
		cleanName := strings.TrimPrefix(filepath.Clean("/"+file.Name), "/")
		relativeNames = append(relativeNames, cleanName)
		cosKey := stagingPrefix + cleanName

		reader, size, err := openZipEntryForUpload(file)
		if err != nil {
			return d.failOperation(op, fmt.Sprintf("open zip entry %s: %v", file.Name, err))
		}

		wg.Add(1)
		sem <- struct{}{} // 获取信号量
		go func(key string, body io.ReadCloser, size int64) {
			defer wg.Done()
			defer func() { <-sem }() // 释放信号量
			defer body.Close()

			uploadCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := d.waitForUploadSlot(uploadCtx, siteCos.envID); err != nil {
				errMu.Lock()
				uploadErrors = append(uploadErrors, fmt.Errorf("rate limit %s: %v", key, err))
				errMu.Unlock()
				return
			}
			putOpt := &cos.ObjectPutOptions{
				ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
					// 必须显式给出 Content-Type：COS 在缺省时按 application/octet-stream 存储，
					// 浏览器会把 index.html 当附件下载而不是渲染页面，站点等于不可用。
					ContentType: contentTypeForKey(key),
					// zip 的解压流不是 LenReader，SDK 拿不到长度，
					// 不显式给出会退化成分块传输（COS 的 PUT Object 不接受分块）。
					ContentLength: size,
				},
			}
			if _, err := siteCos.client.Object.Put(uploadCtx, key, body, putOpt); err != nil {
				errMu.Lock()
				uploadErrors = append(uploadErrors, fmt.Errorf("upload %s: %v", key, err))
				errMu.Unlock()
			}
		}(cosKey, reader, size)
	}

	wg.Wait()

	if len(uploadErrors) > 0 {
		return d.failOperation(op, fmt.Sprintf("upload failed, %d errors, first: %v", len(uploadErrors), uploadErrors[0]))
	}

	// 4.暂存目录已完整，切换对外服务的 current/。
	// 失败时故意保留暂存目录，便于人工从完整副本恢复。
	if err := d.syncToCurrent(siteCos, op, stagingPrefix, relativeNames); err != nil {
		return d.failOperation(op, fmt.Sprintf("publish to current: %v", err))
	}

	// 5. 清理暂存目录。制品 zip 必须保留：它是套餐续费后恢复站点的唯一数据源，
	// 最终随 Pass 销毁时的 delete 操作一起清除。
	if err := d.deleteCosPrefix(siteCos, stagingPrefix, op); err != nil {
		//暂存目录只占存储、不影响对外服务，清理失败不应让整次发布失败。
		log.Printf("warning: cleanup staging prefix %s failed: %v", stagingPrefix, err)
	}

	return d.completeOperation(op, sitePublishedPrefix(op.SiteID), d.getSitePublicURL(op))
}

// syncToCurrent 把暂存目录的内容搬到对外服务的 current/ 目录，并清掉上一版的残留文件。
//
// 用同桶 CopyObject 而不是重新上传：zip entry 的 reader 只能读一次，
// 且同桶复制是服务端元数据操作，比二次上传更快更省。
func (d *Deployer) syncToCurrent(siteCos *cosClient, op Operation, stagingPrefix string, relativeNames []string) error {
	publishedPrefix := sitePublishedPrefix(op.SiteID)
	// COS 复制源必须是「桶域名 + / + key」的形式，不带 scheme。
	sourceHost := fmt.Sprintf("%s.cos.%s.myqcloud.com", siteCos.bucket, siteCos.region)

	desired := make(map[string]struct{}, len(relativeNames))
	var copyErrors []error
	var errMu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)

	for _, name := range relativeNames {
		desired[publishedPrefix+name] = struct{}{}

		wg.Add(1)
		sem <- struct{}{}
		go func(name string) {
			defer wg.Done()
			defer func() { <-sem }()

			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := d.waitForUploadSlot(ctx, siteCos.envID); err != nil {
				errMu.Lock()
				copyErrors = append(copyErrors, fmt.Errorf("rate limit %s: %v", name, err))
				errMu.Unlock()
				return
			}
			source := sourceHost + "/" + stagingPrefix + name
			copyOpt := &cos.ObjectCopyOptions{
				ObjectCopyHeaderOptions: &cos.ObjectCopyHeaderOptions{
					ContentType: contentTypeForKey(name),
					// 覆盖式复制时必须声明 REPLACED，否则 Content-Type 会沿用源对象。
					XCosMetadataDirective: "Replaced",
				},
			}
			if _, _, err := siteCos.client.Object.Copy(ctx, publishedPrefix+name, source, copyOpt); err != nil {
				errMu.Lock()
				copyErrors = append(copyErrors, fmt.Errorf("copy %s: %v", name, err))
				errMu.Unlock()
			}
		}(name)
	}
	wg.Wait()

	if len(copyErrors) > 0 {
		return fmt.Errorf("%d copy errors, first: %v", len(copyErrors), copyErrors[0])
	}

	// 清掉上一版留下、本版不再包含的文件，避免旧资源继续对外可访问。
	stale, err := d.listCosKeys(siteCos, publishedPrefix)
	if err != nil {
		return fmt.Errorf("list published objects: %w", err)
	}
	var toDelete []cos.Object
	for _, key := range stale {
		if _, keep := desired[key]; !keep {
			toDelete = append(toDelete, cos.Object{Key: key})
		}
	}
	for start := 0; start < len(toDelete); start += 1000 {
		end := start + 1000
		if end > len(toDelete) {
			end = len(toDelete)
		}
		if _, _, err := siteCos.client.Object.DeleteMulti(context.Background(),
			&cos.ObjectDeleteMultiOptions{Objects: toDelete[start:end]}); err != nil {
			return fmt.Errorf("delete stale published objects: %w", err)
		}
	}
	return nil
}

// listCosKeys 列出指定前缀下的所有对象键。
func (d *Deployer) listCosKeys(client *cosClient, prefix string) ([]string, error) {
	var keys []string
	var marker string
	for {
		opt := &cos.BucketGetOptions{Prefix: prefix, MaxKeys: 1000}
		if marker != "" {
			opt.Marker = marker
		}
		result, _, err := client.client.Bucket.Get(context.Background(), opt)
		if err != nil {
			return nil, fmt.Errorf("list objects (%s): %v", prefix, err)
		}
		for _, item := range result.Contents {
			keys = append(keys, item.Key)
		}
		if !result.IsTruncated {
			return keys, nil
		}
		marker = result.NextMarker
	}
}

// executeSuspend 套餐到期下线站点。
//
// v2 移除了平台反向代理，用户拿到的是 CloudBase 原生 URL，平台不在访问路径上，
// 所以「下线」只能通过真正删除线上文件实现，改 DB 状态是不够的。
// 制品 zip 必须保留，它是续费后恢复站点的唯一数据源。
func (d *Deployer) executeSuspend(op Operation) error {
	siteCos := d.getCosForEnv(op.TCBEnvID)
	if siteCos == nil {
		return d.failOperation(op, "CloudBase COS not configured for env: "+op.TCBEnvID)
	}

	prefix := fmt.Sprintf("sites/%s/", op.SiteID)
	if err := d.deleteCosPrefix(siteCos, prefix, op); err != nil {
		return d.failOperation(op, fmt.Sprintf("take site offline under %s: %v", prefix, err))
	}
	return d.completeOperation(op, "", "")
}

// executeDelete removes both published files and uploaded artifacts. It only
// completes after COS confirms cleanup, so ctl does not release the user's
// site quota while a public object may still exist.
func (d *Deployer) executeDelete(op Operation) error {
	siteCos := d.getCosForEnv(op.TCBEnvID)
	if siteCos == nil {
		return d.failOperation(op, "CloudBase COS not configured for env: "+op.TCBEnvID)
	}

	// Published files first: a failed delete must leave the site in deleting
	// state and let ctl schedule the next durable retry.
	prefix := fmt.Sprintf("sites/%s/", op.SiteID)
	if err := d.deleteCosPrefix(siteCos, prefix, op); err != nil {
		return d.failOperation(op, fmt.Sprintf("delete site files under %s: %v", prefix, err))
	}

	artPrefix := fmt.Sprintf("_artifacts/%s/", op.SiteID)
	if err := d.deleteCosPrefix(siteCos, artPrefix, op); err != nil {
		return d.failOperation(op, fmt.Sprintf("delete artifacts under %s: %v", artPrefix, err))
	}

	return d.completeOperation(op, "", "")
}

// deleteCosPrefix 批量删除指定前缀下的所有COS对象
func (d *Deployer) deleteCosPrefix(client *cosClient, prefix string, op Operation) error {
	var marker string
	for {
		opt := &cos.BucketGetOptions{
			Prefix:  prefix,
			MaxKeys: 1000,
		}
		if marker != "" {
			opt.Marker = marker
		}
		result, _, err := client.client.Bucket.Get(context.Background(), opt)
		if err != nil {
			return fmt.Errorf("list objects (%s): %v", prefix, err)
		}

		if len(result.Contents) == 0 {
			break
		}

		var objects []cos.Object
		for _, item := range result.Contents {
			objects = append(objects, cos.Object{Key: item.Key})
		}
		_, _, err = client.client.Object.DeleteMulti(context.Background(), &cos.ObjectDeleteMultiOptions{Objects: objects})
		if err != nil {
			return fmt.Errorf("batch delete (%s): %v", prefix, err)
		}

		if !result.IsTruncated {
			break
		}
		marker = result.NextMarker
	}
	return nil
}

// completeOperation 回调ctl标记操作成功
func (d *Deployer) completeOperation(op Operation, cloudPath, publicURL string) error {
	body, _ := json.Marshal(map[string]string{
		"cloud_path":  cloudPath,
		"public_url":  publicURL,
		"lease_token": op.LeaseToken,
	})
	req, err := d.newInternalRequest(http.MethodPost,
		d.ctlBaseURL+"/internal/ctl/websites/operations/"+op.OperationID+"/complete",
		bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("complete request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("complete operation status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// ErrOperationFailedAndReported 表示操作本身失败，但失败状态已成功回报给 ctl。
//
// 用一个哨兵错误把它和「回报动作本身也失败」区分开：
// 前者由 ctl 决定是否重试，worker 无需再做什么；
// 后者会让操作留在 running 直到租约过期，需要在日志里显式暴露。
var ErrOperationFailedAndReported = errors.New("operation failed and the failure was reported to ctl")

// failOperation 回调 ctl 标记操作失败
func (d *Deployer) failOperation(op Operation, errMsg string) error {
	body, _ := json.Marshal(map[string]string{
		"error_message": errMsg,
		"lease_token":   op.LeaseToken,
	})
	req, err := d.newInternalRequest(http.MethodPost,
		d.ctlBaseURL+"/internal/ctl/websites/operations/"+op.OperationID+"/fail",
		bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("fail request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fail operation: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("fail operation status %d: %s", resp.StatusCode, string(body))
	}
	// 失败已被ctl 记录，向上层回报哨兵错误，避免调用方把它当成执行成功。
	return fmt.Errorf("%w: %s", ErrOperationFailedAndReported, errMsg)
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getPositiveInt64Env(key string, defaultVal int64) int64 {
	value, err := strconv.ParseInt(getEnv(key, ""), 10, 64)
	if err != nil || value <= 0 {
		return defaultVal
	}
	return value
}

var uploadTokenBucketScript = redis.NewScript(`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local values = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(values[1])
local updated_at = tonumber(values[2])
if not tokens then tokens = capacity end
if not updated_at then updated_at = now end
tokens = math.min(capacity, tokens + math.max(0, now - updated_at) * refill_per_ms)
if tokens < 1 then
  redis.call('HSET', key, 'tokens', tokens, 'updated_at', now)
  redis.call('PEXPIRE', key, 120000)
  return 0
end
redis.call('HSET', key, 'tokens', tokens - 1, 'updated_at', now)
redis.call('PEXPIRE', key, 120000)
return 1
`)

// waitForUploadSlot applies one shared token bucket per CloudBase environment.
// It protects the vendor quota even when deployment work is spread across pods.
func (d *Deployer) waitForUploadSlot(ctx context.Context, envID string) error {
	if d.rateLimitRedis == nil || d.uploadsPerMinute <= 0 {
		return nil
	}
	if envID == "" {
		envID = "default"
	}
	key := "website:cos:upload-rate:" + envID
	refillPerMS := float64(d.uploadsPerMinute) / float64(time.Minute.Milliseconds())
	for {
		allowed, err := uploadTokenBucketScript.Run(ctx, d.rateLimitRedis, []string{key}, d.uploadsPerMinute, refillPerMS, time.Now().UnixMilli()).Int()
		if err != nil {
			return err
		}
		if allowed == 1 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// openZipEntryForUpload 返回可直接交给 COS 的流式reader 及其长度。
//
// 用流式而不是先读进内存，是因为 worker 会并发处理多个部署任务
// （MAX_CONCURRENCY），逐条目缓冲会让峰值内存随并发线性放大直至 OOM。
//
// 长度取zip 头里的 UncompressedSize64：解压流不是 LenReader，
// SDK 无法自行推断长度。空条目必须单独走bytes.Reader——
// SDK 在「拿不到长度且 ContentLength 为 0」时会直接报错。
func openZipEntryForUpload(file *zip.File) (io.ReadCloser, int64, error) {
	size := int64(file.UncompressedSize64)
	if size == 0 {
		return io.NopCloser(bytes.NewReader(nil)), 0, nil
	}
	rc, err := file.Open()
	if err != nil {
		return nil, 0, err
	}
	return rc, size, nil
}

func validateZipEntries(files []*zip.File, maxFiles int, maxUncompressedBytes int64) error {
	if maxFiles <= 0 || maxUncompressedBytes <= 0 {
		return fmt.Errorf("invalid archive limits")
	}
	var fileCount int
	var totalUncompressed int64
	hasIndex := false
	for _, file := range files {
		if file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/") {
			continue
		}
		if file.Name == "" || strings.Contains(file.Name, "\\\\") || strings.HasPrefix(file.Name, "/") {
			return fmt.Errorf("invalid archive path %q", file.Name)
		}
		cleanName := strings.TrimPrefix(filepath.Clean("/"+file.Name), "/")
		if cleanName == "." || cleanName != file.Name || strings.HasPrefix(cleanName, "../") {
			return fmt.Errorf("invalid archive path %q", file.Name)
		}
		fileCount++
		if fileCount > maxFiles {
			return fmt.Errorf("archive contains more than %d files", maxFiles)
		}
		if file.UncompressedSize64 > uint64(maxUncompressedBytes-totalUncompressed) {
			return fmt.Errorf("archive exceeds %d uncompressed bytes", maxUncompressedBytes)
		}
		totalUncompressed += int64(file.UncompressedSize64)
		if cleanName == "index.html" {
			hasIndex = true
		}
	}
	if !hasIndex {
		return fmt.Errorf("archive must contain index.html")
	}
	return nil
}
