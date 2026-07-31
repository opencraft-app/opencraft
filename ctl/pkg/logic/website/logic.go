// Package website 静态建站业务逻辑
package website

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"

	"ctl/pkg/errcode"
	"ctl/pkg/model/bundle"
	"ctl/pkg/model/idgen"
	"ctl/pkg/model/pass"
	"ctl/pkg/model/website"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// ---- 返回类型 ----

type Capability struct {
	MaxSites             int   `json:"max_sites"`
	UsedSites            int   `json:"used_sites"`
	MonthlyTrafficBytes  int64 `json:"monthly_traffic_bytes"`
	UsedTrafficBytes     int64 `json:"used_traffic_bytes"`
	StorageBytes         int64 `json:"storage_bytes"`
	MaxArtifactSize      int64 `json:"max_artifact_size"`
	MaxFiles             int   `json:"max_files"`
	DailyDeployLimit     int   `json:"daily_deploy_limit"`
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

// ---- Logic 接口 ----

type Logic interface {
	GetCapability(userID string) (*Capability, error)
	CreateSite(userID, passID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error)
	ListSites(userID string, page, pageSize int) ([]*website.SiteEntity, int64, error)
	GetSite(userID, siteID string) (*website.SiteEntity, error)
	CreateRelease(userID, siteID string, req CreateReleaseRequest) (*CreateReleaseResult, error)
	ListReleases(userID, siteID string, page, pageSize int) ([]*website.ReleaseEntity, int64, error)
	GetOperation(operationID string) (*website.OperationEntity, error)
	ListPendingOperations(status string, limit int) ([]*website.OperationEntity, error)
	CompleteOperation(operationID, cloudPath, publicURL string) error
	FailOperation(operationID, errorMessage string) error
	DeleteSite(userID, siteID string) (*DeleteSiteResult, error)
	// Pass 生命周期联动
	OnPassIsolated(userID string) error
	OnPassRenewed(userID string) error
	// 流量计量
	RecordTraffic(siteID, userID string, bytes int64) error
}

// ---- 实现 ----

type logic struct {
	siteDao      website.SiteDao
	releaseDao   website.ReleaseDao
	operationDao website.OperationDao
	usageDao     website.UsageDailyDao
	passDao      pass.Dao
	bundleDao    bundle.Dao
	quotaDao     quota.Dao
	idgenDao     idgen.Dao
	logger       *zap.Logger
}

func NewLogic() Logic {
	return &logic{
		siteDao:      website.NewSiteDao(),
		releaseDao:   website.NewReleaseDao(),
		operationDao: website.NewOperationDao(),
		usageDao:     website.NewUsageDailyDao(),
		passDao:      pass.NewDao(),
		bundleDao:    bundle.NewDao(),
		quotaDao:     quota.NewDao(),
		idgenDao:     idgen.NewDao(),
		logger:       resource.ZapLogger,
	}
}

// ---- 辅助函数 ----

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
	id, err := l.idgenDao.GenId(name)
	if err != nil {
		return "", fmt.Errorf("gen id %s: %w", name, err)
	}
	return fmt.Sprintf("%s-%d", prefix, id), nil
}

func (l *logic) ensureQuotaInitialized(userID, bundleID string, q *website.BundleStaticSiteQuota) error {
	existing, err := l.quotaDao.SelectQuota(userID, website.ResourceNameWebsiteSite, "")
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

	now := time.Now()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	usedTraffic, err := l.usageDao.SumTrafficByUserAndDateRange(userID, monthStart, now)
	if err != nil {
		return nil, fmt.Errorf("sum traffic: %w", err)
	}

	return &Capability{
		MaxSites:            q.MaxSites,
		UsedSites:           int(usedSites),
		MonthlyTrafficBytes: q.MonthlyTrafficBytes,
		UsedTrafficBytes:    usedTraffic,
		StorageBytes:        q.StorageBytes,
		MaxArtifactSize:     q.MaxArtifactSize,
		MaxFiles:            q.MaxFiles,
		DailyDeployLimit:    q.DailyDeployLimit,
	}, nil
}

// ---- CreateSite（含幂等性）----

func (l *logic) CreateSite(userID, passID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error) {
	p, err := l.getActivePass(userID)
	if err != nil {
		return nil, err
	}
	if p.BundleID != bundleID {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "bundle_id does not match current pass")
	}

	_, err = l.getBundleQuota(bundleID)
	if err != nil {
		return nil, err
	}

	// 幂等：如果 idempotencyKey 非空，查是否已存在同名的未删除站点
	if idempotencyKey != "" {
		existing, err := l.siteDao.GetByIdempotencyKey(userID, idempotencyKey)
		if err != nil {
			return nil, fmt.Errorf("check idempotency: %w", err)
		}
		if existing != nil {
			// 返回已存在的站点信息（幂等成功）
			return &CreateSiteResult{
				SiteID: existing.SiteID,
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
		// 原子扣席位
		result := tx.Table(quota.TableName).
			Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+
				quota.ColumnResourceKey+" = ? AND "+quota.ColumnResourceQuotaAvailable+" >= ?",
				userID, website.ResourceNameWebsiteSite, "", int64(1)).
			Update(quota.ColumnResourceQuotaAvailable, gorm.Expr(quota.ColumnResourceQuotaAvailable+" - ?", int64(1)))
		if result.Error != nil {
			return fmt.Errorf("alloc site quota: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			return errcode.ErrWebsiteQuotaExceeded
		}

		site := &website.SiteEntity{
			SiteID:   siteID,
			PassID:   p.PassID,
			BundleID: bundleID,
			Name:     name,
			Status:   website.SiteStatusCreating,
		}
		site.UserID = userID
		if err := tx.Table(website.SitesTable).Create(site).Error; err != nil {
			return fmt.Errorf("create site: %w", err)
		}

		op := &website.OperationEntity{
			OperationID:  operationID,
			SiteID:       siteID,
			OperationType: website.OpTypeCreate,
			Status:       website.OpStatusCreated,
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

	l.logger.Info("website site created",
		zap.String("site_id", siteID),
		zap.String("user_id", userID),
		zap.String("operation_id", operationID),
	)

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
	if q.DailyDeployLimit > 0 {
		todayCount, err := l.releaseDao.CountDeploysToday(siteID)
		if err != nil {
			return nil, fmt.Errorf("count today deploys: %w", err)
		}
		if int(todayCount) >= q.DailyDeployLimit {
			return nil, errcode.ErrWebsiteDeployLimitExceeded
		}
	}

	releaseID, err := l.generateID("website_release", "wr")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	// 事务：原子获取版本号 + 创建release + 创建operation
	var version int
	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		// 事务内获取下一个版本号（行锁防并发）
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
			OperationID:   operationID,
			SiteID:         siteID,
			ReleaseID:      releaseID,
			OperationType: website.OpTypeDeploy,
			Status:         website.OpStatusCreated,
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

	// COS 预签名上传 URL
	// 一期：制品上传到 COS，路径格式 website-artifacts/{siteID}/{releaseID}.zip
	// 如果 COS 配置不可用，返回空（Agent 可通过其他方式上传）
	uploadURL := generateUploadURL(siteID, releaseID)

	return &CreateReleaseResult{
		ReleaseID:    releaseID,
		OperationID:  operationID,
		Version:      version,
		UploadURL:    uploadURL,
		UploadMethod: "PUT",
	}, nil
}

// generateUploadURL 生成COS预签名PUT上传URL，有效期1小时
// 环境变量: WEBSITE_COS_BUCKET, WEBSITE_COS_REGION, WEBSITE_COS_SECRET_ID, WEBSITE_COS_SECRET_KEY
func generateUploadURL(siteID, releaseID string) string {
	cosBucket := os.Getenv("WEBSITE_COS_BUCKET")
	cosRegion := os.Getenv("WEBSITE_COS_REGION")
	secretID := os.Getenv("WEBSITE_COS_SECRET_ID")
	secretKey := os.Getenv("WEBSITE_COS_SECRET_KEY")
	if cosBucket == "" || cosRegion == "" || secretID == "" || secretKey == "" {
		return ""
	}

	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", cosBucket, cosRegion))
	if err != nil {
		return ""
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{})

	key := fmt.Sprintf("website-artifacts/%s/%s.zip", siteID, releaseID)
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

func (l *logic) GetOperation(operationID string) (*website.OperationEntity, error) {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil {
		return nil, err
	}
	if op == nil {
		return nil, errcode.ErrWebsiteOperationNotFound
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

// ---- CompleteOperation ----

func (l *logic) CompleteOperation(operationID, cloudPath, publicURL string) error {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil {
		return err
	}
	if op == nil {
		return errcode.ErrWebsiteOperationNotFound
	}

	// 事务：更新操作状态 + 更新site/release
	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		if err := l.operationDao.UpdateStatusTx(tx, operationID, website.OpStatusSuccess, ""); err != nil {
			return err
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
		}

		return nil
	})
	if err != nil {
		return err
	}

	l.logger.Info("website operation completed",
		zap.String("operation_id", operationID),
		zap.String("type", op.OperationType),
	)
	return nil
}

// ---- FailOperation ----

func (l *logic) FailOperation(operationID, errorMessage string) error {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil {
		return err
	}
	if op == nil {
		return errcode.ErrWebsiteOperationNotFound
	}

	if err := l.operationDao.UpdateStatus(operationID, website.OpStatusFailed, errorMessage); err != nil {
		return err
	}

	switch op.OperationType {
	case website.OpTypeCreate:
		// 创建失败：释放席位，标记site为deleted
		_, _ = l.quotaDao.FreeQuota(op.UserID, website.ResourceNameWebsiteSite, "", 1)
		_ = l.siteDao.SoftDelete(op.SiteID)

	case website.OpTypeDeploy:
		_ = l.releaseDao.UpdateStatus(op.ReleaseID, website.ReleaseStatusFailed, errorMessage)
	}

	l.logger.Warn("website operation failed",
		zap.String("operation_id", operationID),
		zap.String("type", op.OperationType),
		zap.String("error", errorMessage),
	)
	return nil
}

// ---- DeleteSite ----

func (l *logic) DeleteSite(userID, siteID string) (*DeleteSiteResult, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, err
	}
	if site == nil || site.Status == website.SiteStatusDeleted {
		return nil, errcode.ErrWebsiteNotFound
	}

	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		// 释放席位
		result := tx.Table(quota.TableName).
			Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+
				quota.ColumnResourceKey+" = ? AND ("+quota.ColumnResourceQuotaAvailable+" + ?) <= "+quota.ColumnResourceQuotaTotal,
				userID, website.ResourceNameWebsiteSite, "", int64(1)).
			Update(quota.ColumnResourceQuotaAvailable, gorm.Expr(quota.ColumnResourceQuotaAvailable+" + ?", int64(1)))
		if result.Error != nil {
			return fmt.Errorf("free site quota: %w", result.Error)
		}

		now := time.Now()
		if err := tx.Table(website.SitesTable).
			Where("site_id = ?", siteID).
			Updates(map[string]interface{}{
				"status":       website.SiteStatusDeleted,
				"deleted_time": &now,
			}).Error; err != nil {
			return fmt.Errorf("soft delete site: %w", err)
		}

		op := &website.OperationEntity{
			OperationID:   operationID,
			SiteID:         siteID,
			OperationType: website.OpTypeDelete,
			Status:         website.OpStatusCreated,
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

	l.logger.Info("website site deleted",
		zap.String("site_id", siteID),
		zap.String("user_id", userID),
		zap.String("operation_id", operationID),
	)

	return &DeleteSiteResult{
		OperationID: operationID,
	}, nil
}

// ---- Pass生命周期联动 ----

// OnPassIsolated Pass到期/隔离时，挂起用户所有active站点
func (l *logic) OnPassIsolated(userID string) error {
	affected, err := l.siteDao.SuspendActiveByUserID(userID)
	if err != nil {
		return fmt.Errorf("suspend sites on pass isolated: %w", err)
	}
	if affected > 0 {
		l.logger.Info("sites suspended on pass isolated",
			zap.String("user_id", userID),
			zap.Int64("affected", affected),
		)
	}
	return nil
}

// OnPassRenewed Pass续费成功后，恢复suspended站点为active
func (l *logic) OnPassRenewed(userID string) error {
	affected, err := l.siteDao.ReactivateSuspendedByUserID(userID)
	if err != nil {
		return fmt.Errorf("reactivate sites on pass renewed: %w", err)
	}
	if affected > 0 {
		l.logger.Info("sites reactivated on pass renewed",
			zap.String("user_id", userID),
			zap.Int64("affected", affected),
		)
	}
	return nil
}

// ---- 流量计量 ----

// RecordTraffic 记录站点流量到日用量表
// 一期：同步写入DB（后续可改为Redis缓冲+后台cron汇总）
func (l *logic) RecordTraffic(siteID, userID string, bytes int64) error {
	if bytes <= 0 {
		return nil
	}
	now := time.Now()
	// UPSERT 日用量
	return l.usageDao.UpsertDaily(siteID, userID, now, bytes, 1)
}

// 保留 sha256 引用以防未来需要
