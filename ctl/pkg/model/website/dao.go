// Package website DAO
package website

import (
	"errors"
	"fmt"
	"time"

	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

// ---- Site DAO ----

type SiteDao interface {
	model.Dao
	CreateSite(entity *SiteEntity) error
	GetBySiteID(siteID string) (*SiteEntity, error)
	GetBySiteIDForUser(userID, siteID string) (*SiteEntity, error)
	ListByUserID(userID string, page, pageSize int) ([]*SiteEntity, int64, error)
	UpdateStatus(siteID, newStatus string) error
	UpdateCloudPathAndURL(siteID, cloudPath, publicURL string) error
	SoftDelete(siteID string) error
	CountActiveByUserID(userID string) (int64, error)
}

type siteDao struct {
	*model.BaseDao
}

func NewSiteDao() SiteDao {
	return &siteDao{BaseDao: model.NewBaseDao(SitesTable).SetKeyColumn("site_id")}
}

func (d *siteDao) CreateSite(entity *SiteEntity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return resource.GormDB.Table(d.TableName).Create(entity).Error
}

func (d *siteDao) GetBySiteID(siteID string) (*SiteEntity, error) {
	var entity SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get site: %w", err)
	}
	return &entity, nil
}

func (d *siteDao) GetBySiteIDForUser(userID, siteID string) (*SiteEntity, error) {
	var entity SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND user_id = ?", siteID, userID).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get site for user: %w", err)
	}
	return &entity, nil
}

func (d *siteDao) ListByUserID(userID string, page, pageSize int) ([]*SiteEntity, int64, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	var total int64
	if err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND deleted_time IS NULL", userID).
		Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count sites: %w", err)
	}

	var entities []*SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND deleted_time IS NULL", userID).
		Order("created_time DESC, id DESC").
		Offset(offset).Limit(pageSize).
		Find(&entities).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list sites: %w", err)
	}
	return entities, total, nil
}

func (d *siteDao) UpdateStatus(siteID, newStatus string) error {
	return resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Update("status", newStatus).Error
}

func (d *siteDao) UpdateCloudPathAndURL(siteID, cloudPath, publicURL string) error {
	return resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Updates(map[string]interface{}{
			"cloud_path": cloudPath,
			"public_url": publicURL,
		}).Error
}

func (d *siteDao) SoftDelete(siteID string) error {
	now := time.Now()
	return resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Updates(map[string]interface{}{
			"status":       SiteStatusDeleted,
			"deleted_time": &now,
		}).Error
}

func (d *siteDao) CountActiveByUserID(userID string) (int64, error) {
	var count int64
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND status IN ? AND deleted_time IS NULL",
			userID, []string{SiteStatusCreating, SiteStatusActive, SiteStatusSuspended}).
		Count(&count).Error
	return count, err
}

// ---- Release DAO ----

type ReleaseDao interface {
	model.Dao
	CreateRelease(entity *ReleaseEntity) error
	GetByReleaseID(releaseID string) (*ReleaseEntity, error)
	ListBySiteID(siteID string, page, pageSize int) ([]*ReleaseEntity, int64, error)
	UpdateStatus(releaseID, newStatus, errorMessage string) error
	GetActiveBySiteID(siteID string) (*ReleaseEntity, error)
	CountDeploysToday(siteID string) (int64, error)
	GetNextVersion(siteID string) (int, error)
}

type releaseDao struct {
	*model.BaseDao
}

func NewReleaseDao() ReleaseDao {
	return &releaseDao{BaseDao: model.NewBaseDao(ReleasesTable).SetKeyColumn("release_id")}
}

func (d *releaseDao) CreateRelease(entity *ReleaseEntity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return resource.GormDB.Table(d.TableName).Create(entity).Error
}

func (d *releaseDao) GetByReleaseID(releaseID string) (*ReleaseEntity, error) {
	var entity ReleaseEntity
	err := resource.GormDB.Table(d.TableName).
		Where("release_id = ?", releaseID).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get release: %w", err)
	}
	return &entity, nil
}

func (d *releaseDao) ListBySiteID(siteID string, page, pageSize int) ([]*ReleaseEntity, int64, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	var total int64
	if err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var entities []*ReleaseEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Order("created_time DESC, id DESC").
		Offset(offset).Limit(pageSize).
		Find(&entities).Error
	return entities, total, err
}

func (d *releaseDao) UpdateStatus(releaseID, newStatus, errorMessage string) error {
	updates := map[string]interface{}{"status": newStatus}
	if errorMessage != "" {
		updates["error_message"] = errorMessage
	}
	return resource.GormDB.Table(d.TableName).
		Where("release_id = ?", releaseID).
		Updates(updates).Error
}

func (d *releaseDao) GetActiveBySiteID(siteID string) (*ReleaseEntity, error) {
	var entity ReleaseEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND status = ?", siteID, ReleaseStatusActive).
		Order("version DESC").
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &entity, nil
}

func (d *releaseDao) CountDeploysToday(siteID string) (int64, error) {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var count int64
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND created_time >= ?", siteID, start).
		Count(&count).Error
	return count, err
}

func (d *releaseDao) GetNextVersion(siteID string) (int, error) {
	var maxVersion int
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Select("COALESCE(MAX(version), 0)").
		Scan(&maxVersion).Error
	return maxVersion + 1, err
}

// ---- Operation DAO ----

type OperationDao interface {
	model.Dao
	CreateOperation(entity *OperationEntity) error
	GetByOperationID(operationID string) (*OperationEntity, error)
	UpdateStatus(operationID, newStatus, errorMessage string) error
	ListBySiteID(siteID string, page, pageSize int) ([]*OperationEntity, int64, error)
}

type operationDao struct {
	*model.BaseDao
}

func NewOperationDao() OperationDao {
	return &operationDao{BaseDao: model.NewBaseDao(OperationsTable).SetKeyColumn("operation_id")}
}

func (d *operationDao) CreateOperation(entity *OperationEntity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return resource.GormDB.Table(d.TableName).Create(entity).Error
}

func (d *operationDao) GetByOperationID(operationID string) (*OperationEntity, error) {
	var entity OperationEntity
	err := resource.GormDB.Table(d.TableName).
		Where("operation_id = ?", operationID).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &entity, nil
}

func (d *operationDao) UpdateStatus(operationID, newStatus, errorMessage string) error {
	updates := map[string]interface{}{"status": newStatus}
	if errorMessage != "" {
		updates["error_message"] = errorMessage
	}
	return resource.GormDB.Table(d.TableName).
		Where("operation_id = ?", operationID).
		Updates(updates).Error
}

func (d *operationDao) ListBySiteID(siteID string, page, pageSize int) ([]*OperationEntity, int64, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	var total int64
	if err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var entities []*OperationEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ?", siteID).
		Order("created_time DESC, id DESC").
		Offset(offset).Limit(pageSize).
		Find(&entities).Error
	return entities, total, err
}

// ---- Usage Daily DAO ----

type UsageDailyDao interface {
	UpsertDaily(siteID, userID string, usageDate time.Time, trafficBytes int64, requestCount int64) error
	GetBySiteAndDate(siteID string, usageDate time.Time) (*UsageDailyEntity, error)
	SumTrafficByUserAndDateRange(userID string, start, end time.Time) (int64, error)
}

type usageDailyDao struct {
	*model.BaseDao
}

func NewUsageDailyDao() UsageDailyDao {
	return &usageDailyDao{BaseDao: model.NewBaseDao(UsageDailyTable)}
}

func (d *usageDailyDao) UpsertDaily(siteID, userID string, usageDate time.Time, trafficBytes int64, requestCount int64) error {
	dateOnly := time.Date(usageDate.Year(), usageDate.Month(), usageDate.Day(), 0, 0, 0, 0, usageDate.Location())
	return resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND usage_date = ?", siteID, dateOnly).
		Assign(map[string]interface{}{
			"user_id":       userID,
			"traffic_bytes": trafficBytes,
			"request_count": requestCount,
		}).
		FirstOrCreate(&UsageDailyEntity{
			SiteID:       siteID,
			UserID:       userID,
			UsageDate:    dateOnly,
			TrafficBytes: trafficBytes,
			RequestCount: requestCount,
		}).Error
}

func (d *usageDailyDao) GetBySiteAndDate(siteID string, usageDate time.Time) (*UsageDailyEntity, error) {
	dateOnly := time.Date(usageDate.Year(), usageDate.Month(), usageDate.Day(), 0, 0, 0, 0, usageDate.Location())
	var entity UsageDailyEntity
	err := resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND usage_date = ?", siteID, dateOnly).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &entity, nil
}

func (d *usageDailyDao) SumTrafficByUserAndDateRange(userID string, start, end time.Time) (int64, error) {
	var total struct {
		Total int64
	}
	err := resource.GormDB.Table(d.TableName).
		Select("COALESCE(SUM(traffic_bytes), 0) as total").
		Where("user_id = ? AND usage_date >= ? AND usage_date < ?", userID, start, end).
		Scan(&total).Error
	return total.Total, err
}
