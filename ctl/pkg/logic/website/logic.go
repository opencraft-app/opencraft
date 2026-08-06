// Package website 静态建站业务逻辑
package website

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tencentyun/cos-go-sdk-v5"

	"ctl/pkg/errcode"
	"ctl/pkg/model/bundle"
	"ctl/pkg/model/idgen"
	"ctl/pkg/model/pass"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"

	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ---- 返回类型 ----

type Capability struct {
	MaxSites            int   `json:"max_sites"`
	UsedSites           int   `json:"used_sites"`
	MonthlyTrafficBytes int64 `json:"monthly_traffic_bytes"`
	UsedTrafficBytes    int64 `json:"used_traffic_bytes"`
	StorageBytes        int64 `json:"storage_bytes"`
	MaxArtifactSize     int64 `json:"max_artifact_size"`
	MaxFiles            int   `json:"max_files"`
}

type CreateSiteResult struct {
	SiteID      string `json:"site_id"`
	OperationID string `json:"operation_id"`
}

type CreateReleaseRequest struct {
	ArtifactHash string `json:"artifact_hash"`
	ArtifactSize int64  `json:"artifact_size"`
	FileCount    int    `json:"file_count"`
}

type CreateReleaseResult struct {
	ReleaseID    string `json:"release_id"`
	OperationID  string `json:"operation_id"`
	Version      int    `json:"version"`
	UploadURL    string `json:"upload_url"`
	UploadMethod string `json:"upload_method"`
}

type DeleteSiteResult struct {
	OperationID string `json:"operation_id"`
}

// SiteStatusView 是站点网关判定「是否对外服务」所需的最小视图。
//
// 站点网关是公网直连组件，这里只暴露它真正需要的两个字段。
type SiteStatusView struct {
	SiteID string `json:"site_id"`
	Status string `json:"status"`
}

// ---- Logic 接口 ----

type Logic interface {
	GetCapability(userID string) (*Capability, error)
	CreateSite(userID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error)
	ListSites(userID string, page, pageSize int) ([]*website.SiteEntity, int64, error)
	GetSite(userID, siteID string) (*website.SiteEntity, error)
	CreateRelease(userID, siteID string, req CreateReleaseRequest) (*CreateReleaseResult, error)
	ListReleases(userID, siteID string, page, pageSize int) ([]*website.ReleaseEntity, int64, error)
	GetOperation(userID, operationID string) (*website.OperationEntity, error)
	GetOperationInternal(operationID string) (*website.OperationEntity, error)
	GetSiteInternal(siteID string) (*SiteStatusView, error)
	ListPendingOperations(status string, limit int) ([]*website.OperationEntity, error)
	ClaimOperation(operationID, workerID string, leaseTTL time.Duration) (*website.OperationEntity, bool, error)
	CompleteOperation(operationID, leaseToken, cloudPath, publicURL string) error
	FailOperation(operationID, leaseToken, errorMessage string) error
	DeleteSite(userID, siteID string) (*DeleteSiteResult, error)
	// Pass 生命周期联动
	OnPassIsolated(userID string) error
	OnPassRenewed(userID string) error
}

// ---- 实现 ----

type logic struct {
	siteDao      website.SiteDao
	releaseDao   website.ReleaseDao
	operationDao website.OperationDao
	passDao      pass.Dao
	bundleDao    bundle.Dao
	quotaDao     quota.Dao
	idgenDao     idgen.Dao
	logger       *zap.Logger
}

const (
	retryBaseDelay = 30 * time.Second
	retryMaxDelay  = 15 * time.Minute
	// maxOperationAttempts 限制可重试操作（delete/suspend/resume）的尝试次数。
	// 达到上限后转dead 死信终态并停止重试，避免环境长期不可达时无限循环。
	maxOperationAttempts = 10
	// maxErrorMessageLen 与 website_operations.error_message 的列宽(2048)对齐留余量。
	// 不截断会在 MySQL strict mode 下触发 1406，导致失败回调本身失败、操作卡在 running。
	maxErrorMessageLen = 1024
)

// truncateErrorMessage 保证错误信息可安全落库。
func truncateErrorMessage(msg string) string {
	if len(msg) <= maxErrorMessageLen {
		return msg
	}
	// 按 rune 边界截断，避免把多字节字符切坏导致写入非法 utf8mb4。
	truncated := msg[:maxErrorMessageLen]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated + "...(truncated)"
}

func NewLogic() Logic {
	return &logic{
		siteDao:      website.NewSiteDao(),
		releaseDao:   website.NewReleaseDao(),
		operationDao: website.NewOperationDao(),
		passDao:      pass.NewDao(),
		bundleDao:    bundle.NewDao(),
		quotaDao:     quota.NewDao(),
		idgenDao:     idgen.NewDao(),
		logger:       resource.ZapLogger,
	}
}

func isOperationClaimable(status string, leaseExpiresAt *time.Time, now time.Time) bool {
	return status == website.OpStatusCreated ||
		(status == website.OpStatusRunning && leaseExpiresAt != nil && leaseExpiresAt.Before(now))
}

func isCurrentOperationGeneration(operationGeneration, siteGeneration int64) bool {
	return operationGeneration == siteGeneration
}

// shouldRetryFailedOperation 判断失败操作是否应被重新调度。
//
// 可重试的都是「系统触发、用户无法自助重试」的清理/状态收敛类操作：
//   - delete：站点目录必须删净才能释放席位，失败不能就此放弃
//   - suspend：套餐到期必须真正下线，失败会造成已过期站点仍然对外可访问
//   - resume：套餐续费必须恢复站点，失败会造成用户已付费但站点仍不可访问
//
// create/deploy 不重试：它们由用户发起，失败后由用户自己重新操作，
// 且 deploy 的制品上传窗口有时效，盲目重试没有意义。
func shouldRetryFailedOperation(operationType string) bool {
	switch operationType {
	case website.OpTypeDelete, website.OpTypeSuspend, website.OpTypeResume:
		return true
	default:
		return false
	}
}

func nextRetryAt(now time.Time, attempt int) time.Time {
	if attempt < 1 {
		attempt = 1
	}
	delay := retryBaseDelay
	for i := 1; i < attempt && delay < retryMaxDelay; i++ {
		delay *= 2
	}
	if delay > retryMaxDelay {
		delay = retryMaxDelay
	}
	return now.UTC().Add(delay)
}

// ---- 辅助函数 ----

// isDuplicateKeyError 判断是否为唯一索引冲突。
// GORM 只在开启 TranslateError 时返回 ErrDuplicatedKey，因此同时兜底匹配 MySQL 原始错误。
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate entry") || strings.Contains(msg, "Error 1062")
}

func (l *logic) getActivePass(userID string) (*pass.Entity, error) {
	passes, err := l.passDao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("list passes: %w", err)
	}
	for _, p := range passes {
		if p.Status == pass.StatusActive && p.ExpiredTime.After(time.Now()) {
			return p, nil
		}
	}
	return nil, errcode.ErrWebsitePassInactive
}

func (l *logic) getBundleQuota(bundleID string) (*website.BundleStaticSiteQuota, error) {
	b, err := l.bundleDao.GetByBundleID(bundleID)
	if err != nil {
		return nil, fmt.Errorf("get bundle: %w", err)
	}
	if b.StaticSiteQuota == "" {
		return nil, errcode.ErrWebsiteNoQuota
	}
	var q website.BundleStaticSiteQuota
	if err := json.Unmarshal([]byte(b.StaticSiteQuota), &q); err != nil {
		return nil, fmt.Errorf("unmarshal static_site_quota: %w", err)
	}
	if q.MaxSites <= 0 {
		return nil, errcode.ErrWebsiteNoQuota
	}
	return &q, nil
}

func (l *logic) generateID(name, prefix string) (string, error) {
	// 8 字节随机 hex，16 字符，防枚举 + 防碰撞
	b := make([]byte, 8)
	if _, err := crand.Read(b); err != nil {
		return "", fmt.Errorf("generate random id: %w", err)
	}
	return fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(b)), nil
}

// notifyDeployer LPUSH 操作 ID 到 Redis，通知 deployer 立即处理
func (l *logic) notifyDeployer(operationID string) {
	if resource.RedisMainClient == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := resource.RedisMainClient.LPush(ctx, "website:operations:pending", operationID).Err(); err != nil {
		l.logger.Warn("notify deployer LPUSH failed", zap.String("op", operationID), zap.Error(err))
	}
}

// findSiteQuotaRow 查找该用户的建站配额行，故意不按 resource_key 过滤。
//
// resource_key 存的是初始化时的 bundle_id，用户换套餐后它与当前 bundle_id 不一致。
// 若查询带上当前 bundle_id，换过套餐的用户永远查不到既有行，
// 于是每换一次套餐就多插一行配额，同一用户出现多行建站配额后
// 席位统计和归还都会失真（一次删站可能归还多个席位）。
func (l *logic) findSiteQuotaRow(userID string) (*quota.Entity, error) {
	var entity quota.Entity
	err := resource.GormDB.Table(quota.TableName).
		Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ?",
			userID, website.ResourceNameWebsiteSite).
		Order("id" + " ASC").
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &entity, nil
}

func (l *logic) ensureQuotaInitialized(userID, bundleID string, q *website.BundleStaticSiteQuota) error {
	existing, err := l.findSiteQuotaRow(userID)
	if err != nil {
		return fmt.Errorf("select site quota: %w", err)
	}
	if existing != nil {
		// 检测套餐变更：quota行中的resource_key存储了初始化时的bundle_id
		if existing.ResourceKey != bundleID {
			// 套餐变更：重新计算配额
			usedSites, err := l.siteDao.CountActiveByUserID(userID)
			if err != nil {
				return fmt.Errorf("count sites for quota reconcile: %w", err)
			}
			newTotal := int64(q.MaxSites)
			newAvailable := newTotal - usedSites
			if newAvailable < 0 {
				newAvailable = 0 // 超额情况：用户已有站点数超过新套餐上限
			}
			result := resource.GormDB.Table(quota.TableName).
				Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ?",
					userID, website.ResourceNameWebsiteSite, existing.ResourceKey).
				Updates(map[string]interface{}{
					quota.ColumnResourceKey:            bundleID,
					quota.ColumnResourceQuotaTotal:     newTotal,
					quota.ColumnResourceQuotaAvailable: newAvailable,
				})
			if result.Error != nil {
				return fmt.Errorf("reconcile quota on bundle change: %w", result.Error)
			}
			l.logger.Info("website quota reconciled on bundle change",
				zap.String("user_id", userID),
				zap.String("old_bundle", existing.ResourceKey),
				zap.String("new_bundle", bundleID),
				zap.Int64("new_total", newTotal),
				zap.Int64("new_available", newAvailable),
			)
		}
		return nil
	}
	// 首次初始化：resource_key存储bundle_id用于后续套餐变更检测
	entity := &quota.Entity{
		UserID:                 userID,
		ResourceName:           website.ResourceNameWebsiteSite,
		ResourceKey:            bundleID,
		ResourceQuotaAvailable: int64(q.MaxSites),
		ResourceQuotaTotal:     int64(q.MaxSites),
	}
	return resource.GormDB.Table(quota.TableName).Create(entity).Error
}

// ---- 安全校验 ----

// validateArtifactHash 校验制品哈希格式
func validateArtifactHash(hash string) bool {
	if hash == "" {
		return false
	}
	// 接受 sha256:xxx 或纯hex
	if strings.HasPrefix(hash, "sha256:") {
		hash = strings.TrimPrefix(hash, "sha256:")
	}
	if len(hash) != 64 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

// validateFilePath 防路径穿越
func validateFilePath(path string) bool {
	cleaned := filepath.Clean(path)
	if strings.Contains(cleaned, "..") || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "\\") {
		return false
	}
	return true
}

// ---- GetCapability ----

func (l *logic) GetCapability(userID string) (*Capability, error) {
	p, err := l.getActivePass(userID)
	if err != nil {
		return nil, err
	}

	q, err := l.getBundleQuota(p.BundleID)
	if err != nil {
		return nil, err
	}

	if err := l.ensureQuotaInitialized(userID, p.BundleID, q); err != nil {
		l.logger.Warn("ensure quota init failed", zap.Error(err))
	}

	usedSites, err := l.siteDao.CountActiveByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("count sites: %w", err)
	}

	return &Capability{
		MaxSites:            q.MaxSites,
		UsedSites:           int(usedSites),
		MonthlyTrafficBytes: q.MonthlyTrafficBytes,
		UsedTrafficBytes:    0, // 一期不做流量监控
		StorageBytes:        q.StorageBytes,
		MaxArtifactSize:     q.MaxArtifactSize,
		MaxFiles:            q.MaxFiles,
	}, nil
}

// ---- CreateSite（含幂等性）----

func (l *logic) CreateSite(userID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error) {
	p, err := l.getActivePass(userID)
	if err != nil {
		return nil, err
	}
	if p.BundleID != bundleID {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "bundle_id does not match current pass")
	}

	bundleQuota, err := l.getBundleQuota(bundleID)
	if err != nil {
		return nil, err
	}

	// 懒初始化配额：确保用户配额记录存在
	if err := l.ensureQuotaInitialized(userID, bundleID, bundleQuota); err != nil {
		l.logger.Warn("ensure quota init failed", zap.Error(err))
	}

	// 幂等：同一用户 + 同一幂等键只允许一个存活站点。
	// 这里的预检查用于快速返回；真正的并发保护由
	// website_sites 的 uk_user_idempotency 唯一索引兜底（见下方Create 冲突处理）。
	if idempotencyKey != "" {
		existing, err := l.siteDao.GetByIdempotencyKey(userID, idempotencyKey)
		if err != nil {
			return nil, fmt.Errorf("check idempotency: %w", err)
		}
		if existing != nil {
			// 返回已存在的站点信息（幂等成功）
			return &CreateSiteResult{
				SiteID:      existing.SiteID,
				OperationID: "", // 原始操作ID已不可恢复，返回空
			}, nil
		}
	}

	siteID, err := l.generateID("website_site", "ws")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		if err := l.allocSiteQuotaTx(tx, userID); err != nil {
			return err
		}

		site := &website.SiteEntity{
			SiteID:              siteID,
			PassID:              p.PassID,
			BundleID:            bundleID,
			Name:                name,
			Status:              website.SiteStatusCreating,
			OperationGeneration: 1,
		}
		if idempotencyKey != "" {
			key := idempotencyKey
			site.IdempotencyKey = &key
		}
		site.UserID = userID
		if err := tx.Table(website.SitesTable).Create(site).Error; err != nil {
			return fmt.Errorf("create site: %w", err)
		}

		op := &website.OperationEntity{
			OperationID:    operationID,
			SiteID:         siteID,
			OperationType:  website.OpTypeCreate,
			Status:         website.OpStatusCreated,
			SiteGeneration: 1,
		}
		op.UserID = userID
		if err := tx.Table(website.OperationsTable).Create(op).Error; err != nil {
			return fmt.Errorf("create operation: %w", err)
		}

		return nil
	})
	if err != nil {
		// 并发重试撞上 uk_user_idempotency 唯一索引：说明另一个请求已经建好了站点，
		// 按幂等语义返回既有站点，而不是把冲突当失败抛给调用方。
		if idempotencyKey != "" && isDuplicateKeyError(err) {
			existing, lookupErr := l.siteDao.GetByIdempotencyKey(userID, idempotencyKey)
			if lookupErr == nil && existing != nil {
				l.logger.Info("website site create deduplicated by idempotency key",
					zap.String("site_id", existing.SiteID), zap.String("user_id", userID))
				return &CreateSiteResult{SiteID: existing.SiteID}, nil
			}
		}
		return nil, err
	}

	l.logger.Info("website site created",
		zap.String("site_id", siteID),
		zap.String("user_id", userID),
		zap.String("operation_id", operationID),
	)

	l.notifyDeployer(operationID)

	return &CreateSiteResult{
		SiteID:      siteID,
		OperationID: operationID,
	}, nil
}

// ---- ListSites ----

func (l *logic) ListSites(userID string, page, pageSize int) ([]*website.SiteEntity, int64, error) {
	return l.siteDao.ListByUserID(userID, page, pageSize)
}

// ---- GetSite ----

func (l *logic) GetSite(userID, siteID string) (*website.SiteEntity, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, err
	}
	if site == nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	return site, nil
}

// ---- CreateRelease（并发安全：事务内GetNextVersion）----

func (l *logic) CreateRelease(userID, siteID string, req CreateReleaseRequest) (*CreateReleaseResult, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, fmt.Errorf("get site: %w", err)
	}
	if site == nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	if site.Status != website.SiteStatusCreating && site.Status != website.SiteStatusActive {
		return nil, errcode.ErrWebsiteNotActive
	}

	p, err := l.getActivePass(userID)
	if err != nil {
		return nil, err
	}
	q, err := l.getBundleQuota(p.BundleID)
	if err != nil {
		return nil, err
	}

	// 安全校验
	if req.ArtifactHash != "" && !validateArtifactHash(req.ArtifactHash) {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "invalid artifact_hash format")
	}
	if q.MaxArtifactSize > 0 && req.ArtifactSize > q.MaxArtifactSize {
		return nil, errcode.ErrWebsiteArtifactTooLarge
	}
	if q.MaxFiles > 0 && req.FileCount > q.MaxFiles {
		return nil, errcode.ErrWebsiteFileCountExceeded
	}

	releaseID, err := l.generateID("website_release", "wr")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	// The site row serializes version allocation and advances the fencing generation.
	var version int
	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var lockedSite website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Table(website.SitesTable).
			Where("site_id = ? AND user_id = ?", siteID, userID).
			First(&lockedSite).Error; err != nil {
			return fmt.Errorf("lock site: %w", err)
		}
		if lockedSite.Status != website.SiteStatusCreating && lockedSite.Status != website.SiteStatusActive {
			return errcode.ErrWebsiteNotActive
		}
		site = &lockedSite
		site.OperationGeneration++
		if err := tx.Table(website.SitesTable).Where("site_id = ?", siteID).
			Update("operation_generation", site.OperationGeneration).Error; err != nil {
			return fmt.Errorf("advance site generation: %w", err)
		}

		v, err := l.releaseDao.GetNextVersionTx(tx, siteID)
		if err != nil {
			return fmt.Errorf("get next version: %w", err)
		}
		version = v

		release := &website.ReleaseEntity{
			ReleaseID:    releaseID,
			SiteID:       siteID,
			Version:      version,
			Status:       website.ReleaseStatusPending,
			ArtifactHash: req.ArtifactHash,
			ArtifactSize: req.ArtifactSize,
			FileCount:    req.FileCount,
		}
		release.UserID = userID
		if err := l.releaseDao.CreateReleaseTx(tx, release); err != nil {
			return fmt.Errorf("create release: %w", err)
		}

		op := &website.OperationEntity{
			OperationID:    operationID,
			SiteID:         siteID,
			ReleaseID:      releaseID,
			OperationType:  website.OpTypeDeploy,
			Status:         website.OpStatusCreated,
			SiteGeneration: site.OperationGeneration,
		}
		op.UserID = userID
		if err := tx.Table(website.OperationsTable).Create(op).Error; err != nil {
			return fmt.Errorf("create operation: %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	// COS 预签名上传 URL。配置不可用时返回空，由调用方决定是否降级。
	uploadURL := generateUploadURL(siteID, releaseID)

	l.notifyDeployer(operationID)

	return &CreateReleaseResult{
		ReleaseID:    releaseID,
		OperationID:  operationID,
		Version:      version,
		UploadURL:    uploadURL,
		UploadMethod: "PUT",
	}, nil
}

// generateUploadURL 生成站点桶的预签名 PUT 上传 URL，有效期 1 小时。
//
// 预签名 URL 的 key 由服务端拼接，Agent 只能往指定的制品路径写，
// 无法借这个 URL 触达其他站点的前缀。
func generateUploadURL(siteID, releaseID string) string {
	bucket, region := siteCOSBucket()
	secretID, secretKey := siteCOSSecrets()
	if bucket == "" || region == "" || secretID == "" || secretKey == "" {
		return ""
	}

	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region))
	if err != nil {
		return ""
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{})

	// 制品 zip 放在 _artifacts/ prefix 下，与站点文件 sites/ 分开
	key := fmt.Sprintf("_artifacts/%s/%s.zip", siteID, releaseID)
	presignedURL, err := client.Object.GetPresignedURL(context.Background(), http.MethodPut, key, secretID, secretKey, time.Hour, nil)
	if err != nil {
		return ""
	}
	return presignedURL.String()
}

// ---- ListReleases ----

func (l *logic) ListReleases(userID, siteID string, page, pageSize int) ([]*website.ReleaseEntity, int64, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, 0, err
	}
	if site == nil {
		return nil, 0, errcode.ErrWebsiteNotFound
	}
	return l.releaseDao.ListBySiteID(siteID, page, pageSize)
}

// ---- GetOperation ----

func (l *logic) GetOperation(userID, operationID string) (*website.OperationEntity, error) {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil {
		return nil, err
	}
	if op == nil {
		return nil, errcode.ErrWebsiteOperationNotFound
	}
	// 安全校验：确保操作属于当前用户
	if op.UserID != userID {
		return nil, errcode.ErrWebsiteOperationNotFound
	}
	return op, nil
}

// ---- GetSiteInternal (供站点网关按 siteID 查状态，无用户维度) ----

// GetSiteInternal 返回站点网关判定「是否对外服务」所需的最小信息。
//
// 刻意只返回 site_id 和 status，不返回实体本身：站点网关是公网直连组件，
// 泄露 user_id、pass_id 这类字段没有必要，多一个字段就多一份暴露面。
func (l *logic) GetSiteInternal(siteID string) (*SiteStatusView, error) {
	site, err := l.siteDao.GetBySiteID(siteID)
	if err != nil {
		return nil, err
	}
	// 已软删的站点对网关等同于不存在，避免删除后子域名仍能命中。
	if site == nil || site.DeletedTime != nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	return &SiteStatusView{SiteID: site.SiteID, Status: site.Status}, nil
}

// ---- GetOperationInternal (for deployer internal use, no user isolation) ----

func (l *logic) GetOperationInternal(operationID string) (*website.OperationEntity, error) {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil || op == nil {
		return op, err
	}
	site, err := l.siteDao.GetBySiteID(op.SiteID)
	if err != nil {
		return nil, err
	}
	if site == nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	return op, nil
}

// ---- ListPendingOperations（Worker轮询接口）----

func (l *logic) ListPendingOperations(status string, limit int) ([]*website.OperationEntity, error) {
	if status == "" {
		status = website.OpStatusCreated
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return l.operationDao.ListByStatus(status, limit)
}

// ClaimOperation atomically assigns a created (or expired) operation to one worker.
// Redis and polling only discover work; this database transition is the ownership source of truth.
func (l *logic) ClaimOperation(operationID, workerID string, leaseTTL time.Duration) (*website.OperationEntity, bool, error) {
	if operationID == "" || workerID == "" {
		return nil, false, errcode.ErrWebsiteInvalidParam
	}
	if leaseTTL <= 0 {
		leaseTTL = 15 * time.Minute
	}
	token, err := l.generateID("website_lease", "wl")
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(leaseTTL)
	result := resource.GormDB.Table(website.OperationsTable).
		Where("operation_id = ? AND ((status = ? AND (next_retry_at IS NULL OR next_retry_at <= ?)) OR (status = ? AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))",
			operationID, website.OpStatusCreated, now, website.OpStatusRunning, now).
		Updates(map[string]interface{}{
			"status":           website.OpStatusRunning,
			"lease_token":      token,
			"lease_expires_at": expiresAt,
			"next_retry_at":    nil,
			"attempt":          gorm.Expr("attempt + 1"),
			"error_message":    "",
		})
	if result.Error != nil {
		return nil, false, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, false, nil
	}
	op, err := l.GetOperationInternal(operationID)
	if err != nil {
		return nil, false, err
	}
	if op == nil || op.LeaseToken != token {
		return nil, false, nil
	}
	l.logger.Info("website operation claimed", zap.String("operation_id", operationID), zap.String("worker_id", workerID), zap.Int("attempt", op.Attempt))
	return op, true, nil
}

// ---- CompleteOperation ----

func (l *logic) CompleteOperation(operationID, leaseToken, cloudPath, publicURL string) error {
	if leaseToken == "" {
		return errcode.ErrWebsiteOperationNotClaimed
	}
	err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var op website.OperationEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.OperationsTable).
			Where("operation_id = ?", operationID).First(&op).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return errcode.ErrWebsiteOperationNotFound
			}
			return err
		}
		if op.Status == website.OpStatusSuccess && op.LeaseToken == leaseToken {
			return nil
		}
		if op.Status != website.OpStatusRunning || op.LeaseToken != leaseToken {
			return errcode.ErrWebsiteOperationNotClaimed
		}

		var site website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ?", op.SiteID).First(&site).Error; err != nil {
			return err
		}
		if !isCurrentOperationGeneration(op.SiteGeneration, site.OperationGeneration) {
			return l.markSupersededOperationTx(tx, &op)
		}
		if result := tx.Table(website.OperationsTable).
			Where("operation_id = ? AND status = ? AND lease_token = ?", operationID, website.OpStatusRunning, leaseToken).
			Updates(map[string]interface{}{"status": website.OpStatusSuccess, "error_message": "", "lease_expires_at": nil}); result.Error != nil {
			return result.Error
		} else if result.RowsAffected != 1 {
			return errcode.ErrWebsiteOperationNotClaimed
		}

		switch op.OperationType {
		case website.OpTypeCreate:
			if err := tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).Update("status", website.SiteStatusActive).Error; err != nil {
				return err
			}
			if cloudPath != "" && publicURL != "" {
				if err := tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).
					Updates(map[string]interface{}{"cloud_path": cloudPath, "public_url": publicURL}).Error; err != nil {
					return err
				}
			}

		case website.OpTypeDeploy:
			// 先让该站点此前的 active 版本退位，保证「当前版本」唯一。
			// 否则续费恢复、发布历史展示都会面对多个自称当前的版本。
			if err := tx.Table(website.ReleasesTable).
				Where("site_id = ? AND status = ? AND release_id <> ?",
					op.SiteID, website.ReleaseStatusActive, op.ReleaseID).
				Update("status", website.ReleaseStatusSuperseded).Error; err != nil {
				return err
			}
			if err := tx.Table(website.ReleasesTable).Where("release_id = ?", op.ReleaseID).
				Update("status", website.ReleaseStatusActive).Error; err != nil {
				return err
			}
			if err := tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).
				Update("status", website.SiteStatusActive).Error; err != nil {
				return err
			}
			if cloudPath != "" && publicURL != "" {
				if err := tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).
					Updates(map[string]interface{}{"cloud_path": cloudPath, "public_url": publicURL}).Error; err != nil {
					return err
				}
			}

		case website.OpTypeDelete:
			now := time.Now().UTC()
			if err := tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).
				Updates(map[string]interface{}{
					"status":       website.SiteStatusDeleted,
					"deleted_time": &now,
					"cloud_path":   "",
					"public_url":   "",
				}).Error; err != nil {
				return err
			}
			if err := l.releaseSiteQuotaTx(tx, op.UserID); err != nil {
				return err
			}

		case website.OpTypeSuspend:
			// 站点在发起 suspend 时已置为 suspended，这里只需确认终态。
			// 保留 public_url：URL 是稳定的 current/ 形式，续费恢复后地址不变。
			if err := tx.Table(website.SitesTable).
				Where("site_id = ? AND status = ?", op.SiteID, website.SiteStatusSuspended).
				Update("cloud_path", "").Error; err != nil {
				return err
			}

		case website.OpTypeResume:
			// 只有确实完成了文件恢复才转active，避免「显示可用但内容未上线」。
			updates := map[string]interface{}{"status": website.SiteStatusActive}
			if cloudPath != "" {
				updates["cloud_path"] = cloudPath
			}
			if publicURL != "" {
				updates["public_url"] = publicURL
			}
			if err := tx.Table(website.SitesTable).
				Where("site_id = ? AND status = ?", op.SiteID, website.SiteStatusSuspended).
				Updates(updates).Error; err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return err
	}

	l.logger.Info("website operation completed",
		zap.String("operation_id", operationID),
	)
	return nil
}

// ---- FailOperation ----

func (l *logic) FailOperation(operationID, leaseToken, errorMessage string) error {
	if leaseToken == "" {
		return errcode.ErrWebsiteOperationNotClaimed
	}
	err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var op website.OperationEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.OperationsTable).
			Where("operation_id = ?", operationID).First(&op).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return errcode.ErrWebsiteOperationNotFound
			}
			return err
		}
		if op.Status == website.OpStatusFailed && op.LeaseToken == leaseToken {
			return nil
		}
		if op.Status != website.OpStatusRunning || op.LeaseToken != leaseToken {
			return errcode.ErrWebsiteOperationNotClaimed
		}
		var site website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ?", op.SiteID).First(&site).Error; err != nil {
			return err
		}
		if !isCurrentOperationGeneration(op.SiteGeneration, site.OperationGeneration) {
			return l.markSupersededOperationTx(tx, &op)
		}
		safeMessage := truncateErrorMessage(errorMessage)
		updates := map[string]interface{}{
			"status":           website.OpStatusFailed,
			"error_message":    safeMessage,
			"lease_expires_at": nil,
		}
		// 可重试操作：未达上限则回到 created 等待重新调度；
		// 达到上限转dead 死信终态，停止重试并等待人工介入。
		if shouldRetryFailedOperation(op.OperationType) {
			if op.Attempt >= maxOperationAttempts {
				updates["status"] = website.OpStatusDead
				updates["error_message"] = truncateErrorMessage(fmt.Sprintf(
					"giving up after %d attempts: %s", op.Attempt, errorMessage))
				updates["next_retry_at"] = nil
				updates["lease_token"] = ""
			} else {
				updates["status"] = website.OpStatusCreated
				updates["next_retry_at"] = nextRetryAt(time.Now(), op.Attempt)
				updates["lease_token"] = ""
			}
		}
		if result := tx.Table(website.OperationsTable).
			Where("operation_id = ? AND status = ? AND lease_token = ?", operationID, website.OpStatusRunning, leaseToken).
			Updates(updates); result.Error != nil {
			return result.Error
		} else if result.RowsAffected != 1 {
			return errcode.ErrWebsiteOperationNotClaimed
		}

		switch op.OperationType {
		case website.OpTypeCreate:
			if err := l.releaseSiteQuotaTx(tx, op.UserID); err != nil {
				return err
			}
			return tx.Table(website.SitesTable).Where("site_id = ?", op.SiteID).
				Updates(map[string]interface{}{"status": website.SiteStatusDeleted, "deleted_time": time.Now().UTC()}).Error
		case website.OpTypeDeploy:
			return tx.Table(website.ReleasesTable).Where("release_id = ?", op.ReleaseID).
				Updates(map[string]interface{}{"status": website.ReleaseStatusFailed, "error_message": safeMessage}).Error
		case website.OpTypeDelete, website.OpTypeSuspend, website.OpTypeResume:
			// 站点状态保持不变，等待重试或人工介入。
			return nil
		}
		return nil
	})
	if err != nil {
		return err
	}

	l.logger.Warn("website operation failed",
		zap.String("operation_id", operationID),
		zap.String("error", errorMessage),
	)
	return nil
}

// allocSiteQuotaTx 占用一个站点席位。
//
// 定位配额行只用 (user_id, resource_name)，与 releaseSiteQuotaTx 保持一致，
// 故意不带 resource_key：resource_key 存的是配额行初始化时的 bundle_id，
// 用户换套餐后它与当前 bundle_id 不一致。扣减前虽然有 ensureQuotaInitialized
// 负责把 resource_key 改写成当前 bundle_id，但它失败时只告警不中断流程，
// 一旦改写没生效，按 resource_key 匹配就会 0 行命中，
// 用户看到的是「套餐建站数量已满」，真实原因却是配额行没对齐。
//
// 扣减本身仍是单条原子 UPDATE（带 available >= 1 条件），不存在先读后写的超扣竞态；
// 先定位主键只是为了保证严格只影响一行，并区分「配额行缺失」与「配额真的用尽」。
func (l *logic) allocSiteQuotaTx(tx *gorm.DB, userID string) error {
	var quotaID int64
	if err := tx.Table(quota.TableName).
		Select("id").
		Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ?",
			userID, website.ResourceNameWebsiteSite).
		Order("id" + " ASC").
		Limit(1).
		Scan(&quotaID).Error; err != nil {
		return fmt.Errorf("locate site quota row: %w", err)
	}
	if quotaID == 0 {
		// 配额行缺失说明 ensureQuotaInitialized 没能建行（它的错误只告警不中断），
		// 这是服务端数据不一致，不是用户配额用尽，不能返回 ErrWebsiteQuotaExceeded 误导排查。
		l.logger.Error("website site quota row missing, cannot allocate seat",
			zap.String("user_id", userID),
			zap.String("resource_name", website.ResourceNameWebsiteSite),
		)
		return errcode.Wrap(errcode.ErrInternalServer, "site quota row missing for user %s", userID)
	}

	result := tx.Table(quota.TableName).
		Where("id"+" = ? AND "+quota.ColumnResourceQuotaAvailable+" >= ?", quotaID, int64(1)).
		Update(quota.ColumnResourceQuotaAvailable, gorm.Expr(quota.ColumnResourceQuotaAvailable+" - ?", int64(1)))
	if result.Error != nil {
		return fmt.Errorf("alloc site quota: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		// available 已经是 0：席位确实用尽，这是给用户看的业务错误。
		return errcode.ErrWebsiteQuotaExceeded
	}
	return nil
}

// releaseSiteQuotaTx 归还一个站点席位。
//
// 定位配额行只用 (user_id, resource_name)，故意不带 resource_key：
// resource_key 存的是 bundle_id，用户换套餐时 ensureQuotaInitialized 会把它改写成
// 新 bundle_id，而站点行上记的仍是建站时的旧 bundle_id。若按站点的 bundle_id过滤，
// 换过套餐的用户删站时会匹配 0 行、席位被永久吃掉。
// 每个用户对该资源只有一行配额，所以按 (user_id, resource_name) 定位是精确的。
//
// 配额行不存在时（例如 Pass 已销毁、配额行已被清理）只告警不报错：
// 否则 delete 操作会因为「没有配额可还」而永久失败重试，站点反而删不掉。
func (l *logic) releaseSiteQuotaTx(tx *gorm.DB, userID string) error {
	// 先定位唯一一行再更新，而不是直接按条件批量 UPDATE。
	// 历史数据里同一用户可能存在多行建站配额（旧版ensureQuotaInitialized 每换一次
	// 套餐就会插一行），批量更新会一次归还多个席位造成超卖。
	var quotaID int64
	if err := tx.Table(quota.TableName).
		Select("id").
		Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ?",
			userID, website.ResourceNameWebsiteSite).
		Order("id" + " ASC").
		Limit(1).
		Scan(&quotaID).Error; err != nil {
		return fmt.Errorf("locate site quota row: %w", err)
	}
	if quotaID == 0 {
		// 配额行不存在（例如 Pass 已销毁、配额行已被清理）时只告警不报错：
		// 否则 delete 操作会因为「没有配额可还」而永久失败重试，站点反而删不掉。
		l.logger.Warn("website site quota not released: no quota row for user",
			zap.String("user_id", userID),
			zap.String("resource_name", website.ResourceNameWebsiteSite),
		)
		return nil
	}

	result := tx.Table(quota.TableName).
		Where("id"+" = ? AND "+
			quota.ColumnResourceQuotaAvailable+" < "+quota.ColumnResourceQuotaTotal, quotaID).
		Update(quota.ColumnResourceQuotaAvailable, gorm.Expr(quota.ColumnResourceQuotaAvailable+" + ?", int64(1)))
	if result.Error != nil {
		return fmt.Errorf("free site quota: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		// available 已等于 total，说明没有占用中的席位可归还，属于重复归还的幂等场景。
		l.logger.Warn("website site quota already at full availability",
			zap.String("user_id", userID),
			zap.Int64("quota_id", quotaID),
		)
	}
	return nil
}

func (l *logic) markSupersededOperationTx(tx *gorm.DB, op *website.OperationEntity) error {
	if err := tx.Table(website.OperationsTable).Where("operation_id = ? AND status = ? AND lease_token = ?", op.OperationID, website.OpStatusRunning, op.LeaseToken).
		Updates(map[string]interface{}{"status": website.OpStatusFailed, "error_message": "superseded by a newer site operation", "lease_expires_at": nil}).Error; err != nil {
		return err
	}
	// A superseded worker has no corrective work left to do. Commit its terminal state
	// instead of returning an error that would roll the transaction back.
	return nil
}

// ---- DeleteSite ----

func (l *logic) DeleteSite(userID, siteID string) (*DeleteSiteResult, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, err
	}
	if site == nil || site.Status == website.SiteStatusDeleted || site.Status == website.SiteStatusDeleting {
		return nil, errcode.ErrWebsiteNotFound
	}

	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var lockedSite website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ? AND user_id = ?", siteID, userID).First(&lockedSite).Error; err != nil {
			return err
		}
		if lockedSite.Status == website.SiteStatusDeleted || lockedSite.Status == website.SiteStatusDeleting {
			return errcode.ErrWebsiteNotFound
		}
		if err := tx.Table(website.SitesTable).
			Where("site_id = ?", siteID).
			Updates(map[string]interface{}{
				"status":               website.SiteStatusDeleting,
				"operation_generation": lockedSite.OperationGeneration + 1,
			}).Error; err != nil {
			return fmt.Errorf("mark site deleting: %w", err)
		}

		op := &website.OperationEntity{
			OperationID:    operationID,
			SiteID:         siteID,
			OperationType:  website.OpTypeDelete,
			Status:         website.OpStatusCreated,
			SiteGeneration: lockedSite.OperationGeneration + 1,
		}
		op.UserID = userID
		if err := tx.Table(website.OperationsTable).Create(op).Error; err != nil {
			return fmt.Errorf("create delete operation: %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	l.logger.Info("website site deletion requested",
		zap.String("site_id", siteID),
		zap.String("user_id", userID),
		zap.String("operation_id", operationID),
	)

	l.notifyDeployer(operationID)

	return &DeleteSiteResult{
		OperationID: operationID,
	}, nil
}

// ---- Pass生命周期联动 ----
//
// 套餐到期/续费必须真正改变站点在CloudBase 上的可访问性，不能只改 DB 状态：
// v2 已移除平台反向代理，用户拿到的是 CloudBase 原生 URL，平台不在访问路径上，
// 所以「下线」只能通过删除线上发布文件实现。
//
//   suspend：删除 sites/{siteID}/ 下的发布文件，保留 _artifacts/ 下的制品
//   resume ：从保留的制品重新发布，站点 URL 保持不变
//
// 制品的最终清理由 Pass 销毁链路（DeleteAllSitesOnPassDestroyed → delete 操作）
// 统一完成，这里不需要额外的定时清理。

// OnPassIsolated Pass到期/隔离时，下线用户所有 active 站点。
//
// 站点状态在事务内立即置为 suspended，用户和前端马上能看到准确状态；
// CloudBase 上的文件删除由 worker 异步完成，失败会持久重试。
func (l *logic) OnPassIsolated(userID string) error {
	sites, err := l.siteDao.ListActiveByUserID(userID)
	if err != nil {
		return fmt.Errorf("list active sites on pass isolated: %w", err)
	}
	var firstErr error
	suspended := 0
	for _, site := range sites {
		operationID, err := l.transitionSiteForPassLifecycle(
			userID, site.SiteID, website.OpTypeSuspend,
			website.SiteStatusActive, website.SiteStatusSuspended, "")
		if err != nil {
			l.logger.Warn("suspend site on pass isolated failed",
				zap.String("user_id", userID), zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		suspended++
		l.notifyDeployer(operationID)
	}
	if suspended > 0 {
		l.logger.Info("sites suspended on pass isolated",
			zap.String("user_id", userID), zap.Int("count", suspended))
	}
	return firstErr
}

// OnPassRenewed Pass 续费成功后，从保留的制品恢复用户所有 suspended 站点。
//
// 站点保持 suspended 直到 worker 真正把文件重新发布完成，
// 避免出现「状态显示可用但内容还没上线」的空窗。
func (l *logic) OnPassRenewed(userID string) error {
	sites, err := l.siteDao.ListSuspendedByUserID(userID)
	if err != nil {
		return fmt.Errorf("list suspended sites on pass renewed: %w", err)
	}
	var firstErr error
	resumed := 0
	for _, site := range sites {
		release, err := l.releaseDao.GetActiveBySiteID(site.SiteID)
		if err != nil {
			l.logger.Warn("lookup active release on pass renewed failed",
				zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if release == nil {
			// 站点从未成功发布过内容，没有制品可恢复，直接恢复可用状态。
			if err := l.siteDao.UpdateStatus(site.SiteID, website.SiteStatusActive); err != nil {
				l.logger.Warn("reactivate never-deployed site failed",
					zap.String("site_id", site.SiteID), zap.Error(err))
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			resumed++
			continue
		}

		operationID, err := l.transitionSiteForPassLifecycle(
			userID, site.SiteID, website.OpTypeResume,
			website.SiteStatusSuspended, website.SiteStatusSuspended, release.ReleaseID)
		if err != nil {
			l.logger.Warn("resume site on pass renewed failed",
				zap.String("user_id", userID), zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		resumed++
		l.notifyDeployer(operationID)
	}
	if resumed > 0 {
		l.logger.Info("sites resumed on pass renewed",
			zap.String("user_id", userID), zap.Int("count", resumed))
	}
	return firstErr
}

// transitionSiteForPassLifecycle 在一个事务内推进站点状态并登记异步操作。
//
// 推进 operation_generation 是为了让任何在途的旧操作在回调时被判定为 superseded，
// 避免「到期下线」和「续费恢复」互相踩，或旧的 deploy 把已下线的站点又传回去。
func (l *logic) transitionSiteForPassLifecycle(
	userID, siteID, opType, expectedStatus, nextStatus, releaseID string,
) (string, error) {
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return "", err
	}

	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var lockedSite website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ? AND user_id = ?", siteID, userID).First(&lockedSite).Error; err != nil {
			return err
		}
		if lockedSite.Status != expectedStatus {
			// 站点状态已被其他流程改变（例如用户已自行删除），跳过本次联动。
			return errcode.ErrWebsiteNotActive
		}

		nextGeneration := lockedSite.OperationGeneration + 1
		siteUpdates := map[string]interface{}{"operation_generation": nextGeneration}
		if nextStatus != expectedStatus {
			siteUpdates["status"] = nextStatus
		}
		if err := tx.Table(website.SitesTable).
			Where("site_id = ?", siteID).Updates(siteUpdates).Error; err != nil {
			return fmt.Errorf("advance site for %s: %w", opType, err)
		}

		op := &website.OperationEntity{
			OperationID:    operationID,
			SiteID:         siteID,
			ReleaseID:      releaseID,
			OperationType:  opType,
			Status:         website.OpStatusCreated,
			SiteGeneration: nextGeneration,
		}
		op.UserID = userID
		if err := tx.Table(website.OperationsTable).Create(op).Error; err != nil {
			return fmt.Errorf("create %s operation: %w", opType, err)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return operationID, nil
}

// 保留 sha256 引用以防未来需要
