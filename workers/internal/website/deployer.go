package website

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
		ctlBaseURL:           getEnv("CTL_BASE_URL", "http://ctl-api.ctl.svc.cluster.local"),
		httpClient:           &http.Client{Timeout: 30 * time.Second},
		maxArtifactBytes:     getPositiveInt64Env("WEBSITE_MAX_ARTIFACT_BYTES", 10*1024*1024),
		maxFiles:             int(getPositiveInt64Env("WEBSITE_MAX_FILES", 500)),
		maxUncompressedBytes: getPositiveInt64Env("WEBSITE_MAX_UNCOMPRESSED_BYTES", 50*1024*1024),
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
	baseURL := fmt.Sprintf("https://%s-%s.tcloudbaseapp.com", env.EnvID, env.AppID)
	if op.ReleaseID == "" {
		return fmt.Sprintf("%s/sites/%s/releases/", baseURL, op.SiteID)
	}
	return fmt.Sprintf("%s/sites/%s/releases/%s/index.html", baseURL, op.SiteID, op.ReleaseID)
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
	default:
		return fmt.Errorf("unknown operation type: %s", op.OperationType)
	}
}

// executeCreate 创建站点 — 一期只标记成功，目录在deploy时创建
func (d *Deployer) executeCreate(op Operation) error {
	cloudPath := fmt.Sprintf("sites/%s/releases/", op.SiteID)
	publicURL := d.getSitePublicURL(op)
	return d.completeOperation(op, cloudPath, publicURL)
}

// executeDeploy 部署站点 — 从制品COS下载zip → 并发上传到CloudBase静态托管COS
func (d *Deployer) executeDeploy(op Operation) error {
	siteCos := d.getCosForEnv(op.TCBEnvID)
	if siteCos == nil {
		return d.failOperation(op, "CloudBase COS not configured for env: "+op.TCBEnvID)
	}

	// 1. 从 CloudBase COS 下载 zip（带重试，等待用户上传完成）
	artifactKey := fmt.Sprintf("_artifacts/%s/%s.zip", op.SiteID, op.ReleaseID)
	var resp *cos.Response
	var dlErr error
	maxRetries := 6
	for attempt := 0; attempt < maxRetries; attempt++ {
		resp, dlErr = siteCos.client.Object.Get(context.Background(), artifactKey, nil)
		if dlErr == nil {
			break
		}
		if attempt < maxRetries-1 {
			log.Printf("download artifact attempt %d/%d failed: %v, retrying in 10s...", attempt+1, maxRetries, dlErr)
			time.Sleep(10 * time.Second)
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

	// 2. 解压
	prefix := fmt.Sprintf("sites/%s/releases/%s/", op.SiteID, op.ReleaseID)
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return d.failOperation(op, fmt.Sprintf("unzip artifact: %v", err))
	}
	if err := validateZipEntries(zipReader.File, d.maxFiles, d.maxUncompressedBytes); err != nil {
		return d.failOperation(op, fmt.Sprintf("invalid website archive: %v", err))
	}

	// 3. 并发上传到 CloudBase COS
	// 使用 semaphore 限制并发数，避免单次部署中 COS 请求过多
	// 每个部署最多 5 个并发上传，20 个 deployer 副本 = 100 并发，远低于 10,000/min 限制
	maxConcurrency := 5
	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup
	var uploadErrors []error
	var errMu sync.Mutex

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/") {
			continue
		}

		// 安全：清理路径，防止路径穿越
		cleanName := strings.TrimPrefix(filepath.Clean("/"+file.Name), "/")
		cosKey := prefix + cleanName

		rc, err := file.Open()
		if err != nil {
			return d.failOperation(op, fmt.Sprintf("open zip entry %s: %v", file.Name, err))
		}

		wg.Add(1)
		sem <- struct{}{} // 获取信号量
		go func(key string, reader io.ReadCloser) {
			defer wg.Done()
			defer func() { <-sem }() // 释放信号量
			defer reader.Close()

			uploadCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := d.waitForUploadSlot(uploadCtx, siteCos.envID); err != nil {
				errMu.Lock()
				uploadErrors = append(uploadErrors, fmt.Errorf("rate limit %s: %v", key, err))
				errMu.Unlock()
				return
			}
			_, err := siteCos.client.Object.Put(uploadCtx, key, reader, nil)
			if err != nil {
				errMu.Lock()
				uploadErrors = append(uploadErrors, fmt.Errorf("upload %s: %v", key, err))
				errMu.Unlock()
			}
		}(cosKey, rc)
	}

	wg.Wait()

	if len(uploadErrors) > 0 {
		return d.failOperation(op, fmt.Sprintf("upload failed, %d errors, first: %v", len(uploadErrors), uploadErrors[0]))
	}

	// 4. 清理制品 zip（部署成功后删除，避免 COS 存储浪费）
	_, _ = siteCos.client.Object.Delete(context.Background(), artifactKey)

	// 5. 回调 ctl 标记成功
	cloudPath := prefix
	publicURL := d.getSitePublicURL(op)
	return d.completeOperation(op, cloudPath, publicURL)
}

// executeDelete 删除站点 — 清理 CloudBase COS 上的站点文件和制品 zip
// COS 清理失败不阻断操作完成（站点 DB 状态已是 deleted），孤儿文件由 cron 清理
func (d *Deployer) executeDelete(op Operation) error {
	siteCos := d.getCosForEnv(op.TCBEnvID)
	if siteCos != nil {
		// 站点文件
		prefix := fmt.Sprintf("sites/%s/", op.SiteID)
		if err := d.deleteCosPrefix(siteCos, prefix, op); err != nil {
			log.Printf("delete site files failed (non-fatal): %v, orphan cleanup needed for %s", err, prefix)
		}
		// 制品 zip
		artPrefix := fmt.Sprintf("_artifacts/%s/", op.SiteID)
		if err := d.deleteCosPrefix(siteCos, artPrefix, op); err != nil {
			log.Printf("delete artifacts failed (non-fatal): %v, orphan cleanup needed for %s", err, artPrefix)
		}
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

// failOperation 回调ctl标记操作失败
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
	return nil
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
