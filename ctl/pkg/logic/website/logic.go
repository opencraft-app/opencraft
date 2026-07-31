// Package website 静态建站业务逻辑
package website

import (
	"encoding/json"
	"fmt"
	"time"

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
	CompleteOperation(operationID, cloudPath, publicURL string) error
	FailOperation(operationID, errorMessage string) error
	DeleteSite(userID, siteID string) (*DeleteSiteResult, error)
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

func (l *logic) ensureQuotaInitialized(userID string, q *website.BundleStaticSiteQuota) error {
	existing, err := l.quotaDao.SelectQuota(userID, website.ResourceNameWebsiteSite, "")
	if err != nil {
		return fmt.Errorf("select site quota: %w", err)
	}
	if existing != nil {
		return nil
	}
	// INSERT IGNORE 写入配额行
	entity := &quota.Entity{
		UserID:                 userID,
		ResourceName:           website.ResourceNameWebsiteSite,
		ResourceKey:            "",
		ResourceQuotaAvailable: int64(q.MaxSites),
		ResourceQuotaTotal:     int64(q.MaxSites),
	}
	return resource.GormDB.Table(quota.TableName).Create(entity).Error
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

	// 懒初始化配额行
	if err := l.ensureQuotaInitialized(userID, q); err != nil {
		l.logger.Warn("ensure quota init failed", zap.Error(err))
		// 不阻断，继续返回能力信息
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

// ---- CreateSite ----

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

	// 先生成ID（不在事务内，idgen有自己的事务）
	siteID, err := l.generateID("website_site", "ws")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

	// 事务：扣席位 + 写site + 写operation
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

		// 写site
		site := &website.SiteEntity{
			SiteID:   siteID,
			PassID:   passID,
			BundleID: bundleID,
			Name:     name,
			Status:   website.SiteStatusCreating,
		}
		site.UserID = userID
		if err := tx.Table(website.SitesTable).Create(site).Error; err != nil {
			return fmt.Errorf("create site: %w", err)
		}

		// 写operation
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

// ---- CreateRelease ----

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

	version, err := l.releaseDao.GetNextVersion(siteID)
	if err != nil {
		return nil, fmt.Errorf("get next version: %w", err)
	}

	releaseID, err := l.generateID("website_release", "wr")
	if err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}

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
	if err := l.releaseDao.CreateRelease(release); err != nil {
		return nil, fmt.Errorf("create release: %w", err)
	}

	operation := &website.OperationEntity{
		OperationID:   operationID,
		SiteID:         siteID,
		ReleaseID:      releaseID,
		OperationType: website.OpTypeDeploy,
		Status:         website.OpStatusCreated,
	}
	operation.UserID = userID
	if err := l.operationDao.CreateOperation(operation); err != nil {
		return nil, fmt.Errorf("create operation: %w", err)
	}

	// TODO: 生成 COS 预签名上传 URL（一期可先返回空，由前端直接上传到ctl）
	uploadURL := ""

	return &CreateReleaseResult{
		ReleaseID:    releaseID,
		OperationID:  operationID,
		Version:      version,
		UploadURL:    uploadURL,
		UploadMethod: "PUT",
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

// ---- CompleteOperation ----

func (l *logic) CompleteOperation(operationID, cloudPath, publicURL string) error {
	op, err := l.operationDao.GetByOperationID(operationID)
	if err != nil {
		return err
	}
	if op == nil {
		return errcode.ErrWebsiteOperationNotFound
	}

	if err := l.operationDao.UpdateStatus(operationID, website.OpStatusSuccess, ""); err != nil {
		return err
	}

	switch op.OperationType {
	case website.OpTypeCreate:
		if err := l.siteDao.UpdateStatus(op.SiteID, website.SiteStatusActive); err != nil {
			return err
		}
		if cloudPath != "" && publicURL != "" {
			if err := l.siteDao.UpdateCloudPathAndURL(op.SiteID, cloudPath, publicURL); err != nil {
				return err
			}
		}

	case website.OpTypeDeploy:
		if err := l.releaseDao.UpdateStatus(op.ReleaseID, website.ReleaseStatusActive, ""); err != nil {
			return err
		}
		if err := l.siteDao.UpdateStatus(op.SiteID, website.SiteStatusActive); err != nil {
			return err
		}
		if cloudPath != "" && publicURL != "" {
			if err := l.siteDao.UpdateCloudPathAndURL(op.SiteID, cloudPath, publicURL); err != nil {
				return err
			}
		}

	case website.OpTypeDelete:
		// 删除完成，site已软删
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

	// 事务：释放席位 + 软删site + 写operation
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

		// 软删site
		now := time.Now()
		if err := tx.Table(website.SitesTable).
			Where("site_id = ?", siteID).
			Updates(map[string]interface{}{
				"status":       website.SiteStatusDeleted,
				"deleted_time": &now,
			}).Error; err != nil {
			return fmt.Errorf("soft delete site: %w", err)
		}

		// 写operation
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
