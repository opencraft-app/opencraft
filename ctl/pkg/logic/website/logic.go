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
	"strconv"
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
	// UsedStorageBytes 是用户所有存活站点的 COS 占用之和。
	//
	// 数据来自 deployer 在发布/删除后回填的 website_sites.storage_bytes，
	// 因此它是「最近一次发布之后」的值，不是实时查桶的结果。
	UsedStorageBytes int64 `json:"used_storage_bytes"`
	MaxArtifactSize  int64 `json:"max_artifact_size"`
	MaxFiles         int   `json:"max_files"`
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
	ReleaseID     string            `json:"release_id"`
	OperationID   string            `json:"operation_id"`
	Version       int               `json:"version"`
	UploadURL     string            `json:"upload_url"`
	UploadMethod  string            `json:"upload_method"`
	UploadHeaders map[string]string `json:"upload_headers"`
}

type DeleteSiteResult struct {
	OperationID string `json:"operation_id"`
}

// SiteStatusView 是内部站点状态接口返回给受信调用方的最小视图。
//
// 当前唯一调用方是带 X-Internal-Token 的内部 GET /internal/ctl/websites/sites/{siteID}：
// 站点网关需要状态/流量门禁，Pages auth 链路还需要稳定的 user_id 归属。
// 因而这里允许带 user_id，但仍刻意不返回 pass_id / bundle_id 等更多内部字段。
//
// 额度和已用量跟着状态一起返回，而不是让网关再查一次：网关已经为这个接口做了
// 30 秒 TTL 缓存，把两个数字塞进同一次回源是零额外成本；新增一次回源则会让
// 站点的全部流量再多打一遍 ctl。
type SiteStatusView struct {
	SiteID    string `json:"site_id"`
	UserID    string `json:"user_id"`
	Status    string `json:"status"`
	CloudPath string `json:"cloud_path"`
	// MonthlyTrafficBytes 为 0 表示不限额（额度未配置或查不到），网关按不拦截处理。
	MonthlyTrafficBytes int64      `json:"monthly_traffic_bytes"`
	UsedTrafficBytes    int64      `json:"used_traffic_bytes"`
	AccessMode          string     `json:"access_mode"`
	ShareGeneration     string     `json:"share_generation,omitempty"`
	ShareExpiresAt      *time.Time `json:"share_expires_at,omitempty"`
}

// ---- Logic 接口 ----

type Logic interface {
	GetCapability(userID string) (*Capability, error)
	CreateSite(userID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error)
	ListSites(userID string, page, pageSize int) ([]*website.SiteEntity, int64, error)
	GetSite(userID, siteID string) (*website.SiteEntity, error)
	SetAccessPolicy(userID, siteID, mode string, durationDays int) (*ShareAccessResult, error)
	ResetShareCode(userID, siteID string) (*ShareAccessResult, error)
	VerifyShareCode(siteID, code, clientIP string) (*ShareVerifyResult, error)
	CreateRelease(userID, siteID string, req CreateReleaseRequest) (*CreateReleaseResult, error)
	ListReleases(userID, siteID string, page, pageSize int) ([]*website.ReleaseEntity, int64, error)
	GetOperation(userID, operationID string) (*website.OperationEntity, error)
	GetOperationInternal(operationID string) (*website.OperationEntity, error)
	GetSiteInternal(siteID string) (*SiteStatusView, error)
	// RecordTrafficUsage 接收站点网关按分钟批量上报的流量增量。
	RecordTrafficUsage(reports []TrafficUsageReport) (int, error)
	// UpdateSiteStorage 接收 deployer 在发布/删除后回填的站点存储用量。
	UpdateSiteStorage(siteID string, storageBytes int64) error
	ListPendingOperations(status string, limit int) ([]*website.OperationEntity, error)
	ClaimOperation(operationID, workerID string, leaseTTL time.Duration) (*website.OperationEntity, bool, error)
	CompleteOperation(operationID, leaseToken, cloudPath, publicURL string) error
	FailOperation(operationID, leaseToken, errorMessage string) error
	ReviveOperation(operationID string) (*website.OperationEntity, error)
	DeleteSite(userID, siteID string) (*DeleteSiteResult, error)
	// Pass 生命周期联动。三者都是纯 DB 状态迁移，不触碰 COS。
	OnPassIsolated(userID string) error
	OnPassRenewed(userID string) error
	OnPassDestroyed(userID string) error
	// ---- Custom domain binding ----
	// BindCustomDomain 将已验证所有权的自定义域名绑定到站点。
	// 绑定前校验站点存在且属于该用户。域名的归一化在 DAO 层完成。
	BindCustomDomain(domain, siteID, userID string) error
	// UnbindCustomDomain 解绑自定义域名。域名归一化在 DAO 层完成。
	UnbindCustomDomain(domain string) error
	// GetSiteIDByDomain 供 site-gateway 查询自定义域名→site_id。
	// 未绑定或绑定的站点已软删时返回 ErrWebsiteNotFound。
	GetSiteIDByDomain(domain string) (string, error)
}

// ---- 实现 ----

type logic struct {
	siteDao         website.SiteDao
	releaseDao      website.ReleaseDao
	operationDao    website.OperationDao
	usageDao        website.UsageDao
	customDomainDao website.CustomDomainDao
	passDao         pass.Dao
	bundleDao       bundle.Dao
	quotaDao        quota.Dao
	idgenDao        idgen.Dao
	logger          *zap.Logger
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
		siteDao:         website.NewSiteDao(),
		releaseDao:      website.NewReleaseDao(),
		operationDao:    website.NewOperationDao(),
		usageDao:        website.NewUsageDao(),
		customDomainDao: website.NewCustomDomainDao(),
		passDao:         pass.NewDao(),
		bundleDao:       bundle.NewDao(),
		quotaDao:        quota.NewDao(),
		idgenDao:        idgen.NewDao(),
		logger:          resource.ZapLogger,
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
//   - suspend / resume：套餐到期与续费已改成纯 DB 状态迁移，不再登记这两类操作；
//     这里继续保留它们的可重试语义，只为让历史遗留的行仍能被正常收敛，
//     而不是在 canReviveOperation 里被判成「不可重跑」后永久卡住。
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

// canReviveOperation 判定一个操作是否允许被重新投入执行。
//
// 只有 dead 可复活：
//   - created/running 还在正常调度链路里，复活只会造成重复执行；
//   - success 已经推进过站点状态，重放会把已完成的动作再做一遍
//     （delete 的 success 会再归还一次配额席位，直接超卖）；
//   - failed 是不可重试操作（create/deploy）的终态，应由用户重新发起，
//     运维不该替他重放一个早已过期的制品上传窗口。
//
// generation 围栏必须原样成立才允许复活：操作的 site_generation 等于站点当前的
// operation_generation，说明它仍是站点上最新的那一代操作，复活后的回调会被
// CompleteOperation / FailOperation 正常接受。两者不等说明站点后来又发起过新操作，
// 这个 dead 操作已成历史，复活它等于放一个陈旧 worker 回去改站点状态——
// 正是一期专门修掉的「迟到的 worker 恢复已删除站点」问题，必须拒绝。
func canReviveOperation(status, operationType string, operationGeneration, siteGeneration int64) error {
	if status != website.OpStatusDead {
		return errcode.Wrap(errcode.ErrWebsiteOperationNotRevivable,
			"operation status is %q, only %q can be revived", status, website.OpStatusDead)
	}
	// 目前只有可重试操作会走到 dead（见 FailOperation）。这里做防御性校验，
	// 避免将来扩展操作类型时把不该自动重跑的动作放进复活路径。
	if !shouldRetryFailedOperation(operationType) {
		return errcode.Wrap(errcode.ErrWebsiteOperationNotRevivable,
			"operation type %q is not retryable", operationType)
	}
	if !isCurrentOperationGeneration(operationGeneration, siteGeneration) {
		return errcode.Wrap(errcode.ErrWebsiteOperationNotRevivable,
			"operation generation %d is stale, site is at generation %d", operationGeneration, siteGeneration)
	}
	return nil
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

	usedStorage, err := l.siteDao.SumStorageBytesByUserID(userID)
	if err != nil {
		// 与流量一致地降级：用量只用于展示，不该让整个 capability 查询失败。
		l.logger.Warn("sum website storage usage failed",
			zap.String("user_id", userID), zap.Error(err))
		usedStorage = 0
	}

	return &Capability{
		MaxSites:            q.MaxSites,
		UsedSites:           int(usedSites),
		MonthlyTrafficBytes: q.MonthlyTrafficBytes,
		UsedTrafficBytes:    l.usedTrafficBytesThisMonth(userID),
		StorageBytes:        q.StorageBytes,
		UsedStorageBytes:    usedStorage,
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
	if bundleID == "" {
		bundleID = p.BundleID
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
	sites, total, err := l.siteDao.ListByUserID(userID, page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	for _, site := range sites {
		l.hydrateShareAccess(site)
	}
	return sites, total, nil
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
	l.hydrateShareAccess(site)
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
	if !validateArtifactHash(req.ArtifactHash) {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "invalid artifact_hash format")
	}
	if req.ArtifactSize <= 0 {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "artifact_size must be positive")
	}
	if req.FileCount <= 0 {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "file_count must be positive")
	}
	if q.MaxArtifactSize > 0 && req.ArtifactSize > q.MaxArtifactSize {
		return nil, errcode.ErrWebsiteArtifactTooLarge
	}
	if q.MaxFiles > 0 && req.FileCount > q.MaxFiles {
		return nil, errcode.ErrWebsiteFileCountExceeded
	}
	if q.StorageBytes <= 0 {
		return nil, errcode.ErrWebsiteNoQuota
	}

	releaseID, err := l.generateID("website_release", "wr")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	// Signing does not perform a COS request. Do it before the transaction so a
	// missing or invalid runtime configuration cannot leave an unusable pending
	// release and operation behind.
	uploadURL, uploadHeaders, err := generateUploadURL(siteID, releaseID, req.ArtifactSize, req.ArtifactHash)
	if err != nil {
		return nil, err
	}

	// The site row serializes version allocation and advances the fencing generation.
	var version int
	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		// The user's single website quota row is also the storage-reservation lock.
		// Locking only one site would allow simultaneous releases on two sites to
		// both observe the same remaining user-wide storage budget.
		var quotaRow quota.Entity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(quota.TableName).
			Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ?",
				userID, website.ResourceNameWebsiteSite).
			Order("id ASC").First(&quotaRow).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errcode.ErrWebsiteNoQuota
			}
			return fmt.Errorf("lock website quota: %w", err)
		}

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

		inFlightStatuses := []string{
			website.ReleaseStatusPending,
			website.ReleaseStatusUploading,
			website.ReleaseStatusDeploying,
		}
		var inFlightForSite int64
		if err := tx.Table(website.ReleasesTable).
			Where("site_id = ? AND status IN ?", siteID, inFlightStatuses).
			Count(&inFlightForSite).Error; err != nil {
			return fmt.Errorf("count in-flight releases: %w", err)
		}
		if inFlightForSite > 0 {
			return errcode.ErrWebsiteReleaseInProgress
		}

		var usedStorage int64
		if err := tx.Table(website.SitesTable).
			Where("user_id = ? AND deleted_time IS NULL", userID).
			Select("COALESCE(SUM(storage_bytes), 0)").Scan(&usedStorage).Error; err != nil {
			return fmt.Errorf("sum website storage: %w", err)
		}
		var reservedStorage int64
		if err := tx.Table(website.ReleasesTable).
			Where("user_id = ? AND status IN ?", userID, inFlightStatuses).
			Select("COALESCE(SUM(artifact_size), 0)").Scan(&reservedStorage).Error; err != nil {
			return fmt.Errorf("sum website upload reservations: %w", err)
		}
		if usedStorage > q.StorageBytes || reservedStorage > q.StorageBytes-usedStorage ||
			req.ArtifactSize > q.StorageBytes-usedStorage-reservedStorage {
			return errcode.ErrWebsiteQuotaExceeded
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

	l.notifyDeployer(operationID)

	return &CreateReleaseResult{
		ReleaseID:     releaseID,
		OperationID:   operationID,
		Version:       version,
		UploadURL:     uploadURL,
		UploadMethod:  "PUT",
		UploadHeaders: uploadHeaders,
	}, nil
}

// generateUploadURL 生成站点桶的预签名 PUT 上传 URL，有效期 1 小时。
//
// 预签名 URL 的 key 由服务端拼接，Agent 只能往指定的制品路径写，
// 无法借这个 URL 触达其他站点的前缀。
func generateUploadURL(siteID, releaseID string, artifactSize int64, artifactHash string) (string, map[string]string, error) {
	bucket, region := siteCOSBucket()
	secretID, secretKey := siteCOSSecrets()
	if bucket == "" || region == "" || secretID == "" || secretKey == "" {
		return "", nil, errcode.ErrWebsiteUploadUnavailable
	}

	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region))
	if err != nil {
		return "", nil, errcode.Wrap(errcode.ErrWebsiteUploadUnavailable, "invalid COS endpoint: %v", err)
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{})

	// 制品 zip 放在 _artifacts/ prefix 下，与站点文件 sites/ 分开
	key := fmt.Sprintf("_artifacts/%s/%s.zip", siteID, releaseID)
	normalizedHash := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(artifactHash), "sha256:"))
	requiredHeaders := http.Header{}
	requiredHeaders.Set("Content-Length", strconv.FormatInt(artifactSize, 10))
	requiredHeaders.Set("x-cos-meta-artifact-sha256", normalizedHash)
	options := &cos.PresignedURLOptions{Header: &requiredHeaders}
	presignedURL, err := client.Object.GetPresignedURL(
		context.Background(), http.MethodPut, key, secretID, secretKey, time.Hour, options)
	if err != nil {
		return "", nil, errcode.Wrap(errcode.ErrWebsiteUploadUnavailable, "sign COS upload URL: %v", err)
	}
	return presignedURL.String(), map[string]string{
		"Content-Length":             requiredHeaders.Get("Content-Length"),
		"x-cos-meta-artifact-sha256": requiredHeaders.Get("x-cos-meta-artifact-sha256"),
	}, nil
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

// GetSiteInternal 返回内部站点状态接口所需的最小信息。
//
// 刻意不返回实体本身：internal caller 只需要 user_id + 门禁字段，
// pass_id、bundle_id 之类继续留在库表内，不扩大公开面。
func (l *logic) GetSiteInternal(siteID string) (*SiteStatusView, error) {
	site, err := l.siteDao.GetBySiteID(siteID)
	if err != nil {
		return nil, err
	}
	// 已软删的站点对网关等同于不存在，避免删除后子域名仍能命中。
	if site == nil || site.DeletedTime != nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	view := &SiteStatusView{
		SiteID:     site.SiteID,
		UserID:     site.UserID,
		Status:     site.Status,
		CloudPath:  site.CloudPath,
		AccessMode: website.SiteAccessModeOwnerOnly,
	}
	if share := loadShareAccessMetadata(siteID); share != nil {
		view.AccessMode = website.SiteAccessModeShareCode
		view.ShareGeneration = share.Generation
		expiresAt := share.ExpiresAt
		view.ShareExpiresAt = &expiresAt
	}
	view.MonthlyTrafficBytes, view.UsedTrafficBytes = l.trafficBudgetForSite(site)
	return view, nil
}

// trafficBudgetForSite 返回该站点所属用户的月流量额度与当月已用量。
//
// 全程 fail-open：额度查不到就返回 0（网关据此不拦截）。这是刻意的方向选择——
// 因为一次 DB 抖动或套餐数据缺失就把用户的站点整体 403，比让流量多跑一会儿糟糕得多。
// 超额拦截是滥用防护，不是必须严丝合缝的计费门禁。
func (l *logic) trafficBudgetForSite(site *website.SiteEntity) (limit int64, used int64) {
	if site.UserID == "" {
		return 0, 0
	}
	p, err := l.getActivePass(site.UserID)
	if err != nil {
		// 没有生效套餐的用户，其站点已经由 pass 生命周期钩子转成 suspended，
		// 网关会先在状态门禁那一步拦下，这里不需要再补一层。
		return 0, 0
	}
	q, err := l.getBundleQuota(p.BundleID)
	if err != nil {
		l.logger.Warn("website traffic budget: bundle quota unavailable",
			zap.String("site_id", site.SiteID), zap.String("bundle_id", p.BundleID), zap.Error(err))
		return 0, 0
	}
	if q.MonthlyTrafficBytes <= 0 {
		return 0, 0
	}
	return q.MonthlyTrafficBytes, l.usedTrafficBytesThisMonth(site.UserID)
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
	op.ActiveCloudPath = site.CloudPath
	if op.ReleaseID != "" {
		release, err := l.releaseDao.GetByReleaseID(op.ReleaseID)
		if err != nil {
			return nil, err
		}
		if release == nil || release.SiteID != op.SiteID || release.UserID != op.UserID {
			return nil, errcode.ErrWebsiteReleaseNotFound
		}
		op.ArtifactHash = release.ArtifactHash
		op.ArtifactSize = release.ArtifactSize
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
			// 只写 deleted_time 做软删，绝不硬删 website_sites 的行。
			//
			// 套餐到期和销毁都不再删 COS 对象，桶里会长期留着已经不对外服务的站点文件；
			// website_sites 是把这些对象对应回「属于谁、哪个套餐、什么时候建的」的唯一依据。
			// 行一删，那些对象就只能靠 sites/{siteID}/ 前缀猜归属，成本归集、违规溯源和
			// 后续的清理策略全都失去落脚点。软删的代价只是一行常驻记录。
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
			// 到期隔离已改成纯状态迁移，不再登记 suspend 操作，这个分支只服务历史行。
			// 站点状态由 OnPassIsolated 的事务写定，这里除了确认操作终态无事可做——
			// 尤其不能再清空 cloud_path：文件从此永久保留，已激活 release 一直有效。

		case website.OpTypeResume:
			// 续费恢复同样已改成纯状态迁移，这个分支只服务历史行：把一个旧的
			// resume 操作收敛掉，同时保证站点最终回到 active（否则历史行的站点
			// 会永久停在 suspended，用户付了费却看不到站点）。
			if err := tx.Table(website.SitesTable).
				Where("site_id = ? AND status = ?", op.SiteID, website.SiteStatusSuspended).
				Update("status", website.SiteStatusActive).Error; err != nil {
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

// ---- ReviveOperation ----

// ReviveOperation 把一个 dead 操作重新投入执行，仅供内部运维调用。
//
// dead 之前没有任何恢复入口：任何一次不可恢复的失败（例如环境配置缺失）会把
// delete 操作耗尽重试次数打到 dead，站点从此永久停在 deleting，
// 并永久占用用户一个配额席位。这个方法补上那条路径。
//
// 复活的是同一个操作而不是新建一个：站点状态、幂等键和 generation 围栏都不用动，
// 语义上就是「根因修好了，同一代操作重跑一次」。
func (l *logic) ReviveOperation(operationID string) (*website.OperationEntity, error) {
	if operationID == "" {
		return nil, errcode.ErrWebsiteInvalidParam
	}
	err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var op website.OperationEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.OperationsTable).
			Where("operation_id = ?", operationID).First(&op).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errcode.ErrWebsiteOperationNotFound
			}
			return err
		}
		// 与 Complete/FailOperation 一致地锁住站点行，保证读到的
		// operation_generation 不会在校验和写入之间被并发操作推进。
		var site website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ?", op.SiteID).First(&site).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errcode.ErrWebsiteNotFound
			}
			return err
		}
		if err := canReviveOperation(op.Status, op.OperationType, op.SiteGeneration, site.OperationGeneration); err != nil {
			return err
		}

		// 故意不推进 site.operation_generation。推进会让这个操作自己的
		// site_generation 立刻变成陈旧值，复活后的第一次回调就被判为 superseded，
		// 站点仍然卡住——围栏关系保持原样才是「重跑同一代」的正确语义。
		result := tx.Table(website.OperationsTable).
			Where("operation_id = ? AND status = ?", operationID, website.OpStatusDead).
			Updates(map[string]interface{}{
				"status":        website.OpStatusCreated,
				"attempt":       0,
				"error_message": "",
				// 清空租约字段：dead 时 lease_token 已被清空，lease_expires_at 可能还留着
				// 旧值，不清会让 isOperationClaimable 的过期租约分支误判。
				"lease_token":      "",
				"lease_expires_at": nil,
				// next_retry_at 置空让 worker 立即可领：调用方是在修好根因之后才来复活的，
				// 没有理由再等一轮指数退避。
				"next_retry_at": nil,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			// 本事务持有行锁，命中 0 行只能是并发的另一次复活先提交了。
			return errcode.Wrap(errcode.ErrWebsiteOperationNotRevivable, "operation was concurrently modified")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	l.notifyDeployer(operationID)
	op, err := l.GetOperationInternal(operationID)
	if err != nil {
		return nil, err
	}
	// 用 Warn：复活必然意味着此前有过一次不可恢复的失败，值得在日志里留痕。
	l.logger.Warn("website operation revived", zap.String("operation_id", operationID))
	return op, nil
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
// 套餐到期、续费和销毁都只改站点状态，一个 COS 对象都不动。
//
// site-gateway 每次请求都查站点状态，suspended/blocked 直接返 403 且不回源，
// 因此「下线」是一次状态写入就能达成的效果，不再需要删文件。
//
// 产品据此定下的模型：到期与销毁都不真实删除用户数据，文件永久保留，只是不对外服务。
// 于是：
//
//	到期隔离：active    → suspended，文件保留，公网 403
//	套餐续费：suspended → active，   文件原样在位，立刻恢复 200
//	套餐销毁：→ suspended，          文件保留，公网 403
//
// 只有用户主动点删除才真删 COS（sites/ 与 _artifacts/ 一起清），见 DeleteSite。

// OnPassIsolated Pass 到期/隔离时把用户所有仍在服务的站点转为 suspended。
//
// 纯 DB 事务：不登记任何异步操作，也不触碰 COS。站点在事务提交那一刻就对外 403，
// 不存在「DB 已隔离但文件还在服务」的空窗，因此这一步可以被调用方当成阻塞步骤。
//
// 范围包含 creating 而不只是 active，补的是一个真实的正确性缺口：只列 active 时，
// 到期瞬间还停在 creating 的站点会被跳过，随后那次 create 的成功回调把它置为 active，
// 结果是套餐已过期、站点却在对外服务。状态迁移会推进 operation_generation，
// 在途的 create 回调因此被 generation 围栏判为 superseded，无法把站点拉回 active。
func (l *logic) OnPassIsolated(userID string) error {
	sites, err := l.siteDao.ListServingByUserID(userID)
	if err != nil {
		return fmt.Errorf("list serving sites on pass isolated: %w", err)
	}
	var firstErr error
	suspended := 0
	for _, site := range sites {
		if err := l.transitionSiteStatusForPassLifecycle(
			userID, site.SiteID, website.SiteStatusSuspended,
			website.SiteStatusCreating, website.SiteStatusActive); err != nil {
			l.logger.Warn("suspend site on pass isolated failed",
				zap.String("user_id", userID), zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		suspended++
	}
	if suspended > 0 {
		l.logger.Info("sites suspended on pass isolated",
			zap.String("user_id", userID), zap.Int("count", suspended))
	}
	return firstErr
}

// OnPassRenewed Pass 续费成功后把用户所有 suspended 站点转回 active。
//
// 不需要从制品恢复：隔离时文件一个都没删，转 active 后网关立刻回源到原来的
// 已激活的 cloud_path，用户看到的还是下线前那一版内容，地址也不变。
func (l *logic) OnPassRenewed(userID string) error {
	sites, err := l.siteDao.ListSuspendedByUserID(userID)
	if err != nil {
		return fmt.Errorf("list suspended sites on pass renewed: %w", err)
	}
	var firstErr error
	resumed := 0
	for _, site := range sites {
		if err := l.transitionSiteStatusForPassLifecycle(
			userID, site.SiteID, website.SiteStatusActive, website.SiteStatusSuspended); err != nil {
			l.logger.Warn("resume site on pass renewed failed",
				zap.String("user_id", userID), zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		resumed++
	}
	if resumed > 0 {
		l.logger.Info("sites resumed on pass renewed",
			zap.String("user_id", userID), zap.Int("count", resumed))
	}
	return firstErr
}

// OnPassDestroyed Pass 销毁时把用户所有仍在服务的站点转为 suspended。
//
// 销毁同样不删文件（产品：文件永久保留），所以这里和到期隔离走同一个终点状态：
// 网关看到 suspended 就 403。站点行也不硬删——只有用户主动点删除才会软删并真删 COS。
//
// 用 suspended 而不是新造一个「已销毁」状态：对网关而言两者的判定完全一致（403 且
// 不回源），多一个状态就多一处需要三方（ctl / worker / 网关）同时认得的枚举值。
// 代价是用户重新购买套餐后续费联动会把这些站点转回 active——在「文件永久保留」的
// 模型下这正是期望行为：数据一直在，付费恢复即可继续对外服务。
func (l *logic) OnPassDestroyed(userID string) error {
	// 与到期隔离同一个范围：creating 也必须停服，理由见 OnPassIsolated。
	sites, err := l.siteDao.ListServingByUserID(userID)
	if err != nil {
		return fmt.Errorf("list serving sites on pass destroyed: %w", err)
	}
	var firstErr error
	suspended := 0
	for _, site := range sites {
		if err := l.transitionSiteStatusForPassLifecycle(
			userID, site.SiteID, website.SiteStatusSuspended,
			website.SiteStatusCreating, website.SiteStatusActive); err != nil {
			l.logger.Warn("suspend site on pass destroyed failed",
				zap.String("user_id", userID), zap.String("site_id", site.SiteID), zap.Error(err))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		suspended++
	}
	if suspended > 0 {
		l.logger.Info("sites suspended on pass destroyed",
			zap.String("user_id", userID), zap.Int("count", suspended))
	}
	return firstErr
}

// transitionSiteStatusForPassLifecycle 在一个事务内做一次带前置状态校验的站点状态迁移。
//
// 前置状态是一个集合而不是单个值：到期隔离和销毁都要同时接受 active 和 creating
// （见 OnPassIsolated），而续费恢复只接受 suspended。用集合表达而不是给隔离单独写
// 一个函数，是为了让「校验前置状态 + 推进围栏」这段逻辑只存在一份。
//
// 仍然推进 operation_generation：套餐状态变化的瞬间可能有一次 create 或 deploy
// 正在途中，它的成功回调会把站点无条件置为 active。不推进围栏的话，「到期隔离」
// 会被一个迟到的 worker 直接掀翻，站点在套餐已过期的情况下重新对外服务。
func (l *logic) transitionSiteStatusForPassLifecycle(
	userID, siteID, nextStatus string, expectedStatuses ...string) error {
	return resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var lockedSite website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Table(website.SitesTable).
			Where("site_id = ? AND user_id = ?", siteID, userID).First(&lockedSite).Error; err != nil {
			return err
		}
		matched := false
		for _, expected := range expectedStatuses {
			if lockedSite.Status == expected {
				matched = true
				break
			}
		}
		if !matched {
			// 站点状态已被其他流程改变（例如用户已自行删除），跳过本次联动。
			return errcode.ErrWebsiteNotActive
		}
		if err := tx.Table(website.SitesTable).
			Where("site_id = ?", siteID).
			Updates(map[string]interface{}{
				"status":               nextStatus,
				"operation_generation": lockedSite.OperationGeneration + 1,
			}).Error; err != nil {
			return fmt.Errorf("transition site %v -> %s: %w", expectedStatuses, nextStatus, err)
		}
		return nil
	})
}

// 保留 sha256 引用以防未来需要

// ---- Custom Domain Binding ----

// BindCustomDomain 将已验证所有权的域名绑定到指定站点。
//
// 调用方（其他模块）负责 DNS、证书申请和域名所有权验证，确认无误后调用本接口。
// 绑定前校验站点存在且属于该用户——防止把域名绑到别人的站点上。
//
// 域名重复绑定时返回 ErrWebsiteDomainAlreadyBound，调用方可以据此提示用户。
func (l *logic) BindCustomDomain(domain, siteID, userID string) error {
	// 校验站点存在且属于该用户
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return fmt.Errorf("bind custom domain: lookup site: %w", err)
	}
	if site == nil || site.DeletedTime != nil {
		return errcode.ErrWebsiteNotFound
	}

	binding := &website.CustomDomainEntity{
		Domain: domain,
		SiteID: siteID,
	}
	binding.UserID = userID

	if err := l.customDomainDao.CreateBinding(binding); err != nil {
		// MySQL 1062 duplicate entry — 域名已被绑定（可能是同一个站点的重复请求，
		// 也可能是被其他站点占用）。查一下当前绑定归属，区分两种情况。
		if strings.Contains(err.Error(), "1062") ||
			strings.Contains(err.Error(), "Duplicate entry") ||
			strings.Contains(err.Error(), "UNIQUE constraint failed") {
			existing, lookupErr := l.customDomainDao.GetByDomain(domain)
			if lookupErr == nil && existing != nil && existing.SiteID == siteID {
				// 同一站点的重复绑定请求，幂等成功。
				return nil
			}
			return errcode.ErrWebsiteDomainAlreadyBound
		}
		return fmt.Errorf("bind custom domain: %w", err)
	}
	return nil
}

// UnbindCustomDomain 解绑域名。域名不存在不算错误（幂等）。
func (l *logic) UnbindCustomDomain(domain string) error {
	if err := l.customDomainDao.DeleteByDomain(domain); err != nil {
		return fmt.Errorf("unbind custom domain: %w", err)
	}
	return nil
}

// GetSiteIDByDomain 供 site-gateway 在 Host 未命中根域时查询自定义域名绑定。
//
// 未绑定或绑定的站点已软删时返回 ErrWebsiteNotFound——site-gateway 据此返回 404，
// 不会回落到任何其他站点。
func (l *logic) GetSiteIDByDomain(domain string) (string, error) {
	binding, err := l.customDomainDao.GetByDomain(domain)
	if err != nil {
		return "", fmt.Errorf("get site by domain: %w", err)
	}
	if binding == nil {
		return "", errcode.ErrWebsiteNotFound
	}
	// 校验站点仍然存在且未软删。绑定记录不会在站点删除时自动级联清理，
	// 所以这里必须二次校验，否则已删站点仍可通过自定义域名命中缓存。
	site, err := l.siteDao.GetBySiteID(binding.SiteID)
	if err != nil {
		return "", fmt.Errorf("get site by domain: lookup site: %w", err)
	}
	if site == nil || site.DeletedTime != nil {
		return "", errcode.ErrWebsiteNotFound
	}
	return binding.SiteID, nil
}
