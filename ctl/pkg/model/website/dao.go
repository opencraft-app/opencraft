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
	ListActiveByUserID(userID string) ([]*SiteEntity, error)
	ListSuspendedByUserID(userID string) ([]*SiteEntity, error)
	GetByIdempotencyKey(userID, idempotencyKey string) (*SiteEntity, error)
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

// CountActiveByUserID 统计占用配额席位的站点。
//
// blocked 也要计入：违规封禁不释放席位，否则用户封一个就能再建一个，
// 封禁反而变成了绕过配额的手段，而且被封站点的产物仍然占着存储。
func (d *siteDao) CountActiveByUserID(userID string) (int64, error) {
	var count int64
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND status IN ? AND deleted_time IS NULL",
			userID, []string{
				SiteStatusCreating, SiteStatusActive, SiteStatusSuspended,
				SiteStatusDeleting, SiteStatusBlocked,
			}).
		Count(&count).Error
	return count, err
}

// ListActiveByUserID 列出用户所有 active 站点，供套餐到期下线使用。
func (d *siteDao) ListActiveByUserID(userID string) ([]*SiteEntity, error) {
	var entities []*SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND status = ? AND deleted_time IS NULL", userID, SiteStatusActive).
		Find(&entities).Error
	return entities, err
}

func (d *siteDao) ListSuspendedByUserID(userID string) ([]*SiteEntity, error) {
	var entities []*SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND status = ? AND deleted_time IS NULL", userID, SiteStatusSuspended).
		Find(&entities).Error
	return entities, err
}

// GetByIdempotencyKey 按真实幂等键查询已存在的站点。
//
// 幂等键落在独立列上并由 (user_id, idempotency_key) 唯一索引保护，
// 因此这里是精确匹配，不再借用 name 字段。
// 排除 deleting/deleted：正在删除或已删除的站点不应被当作幂等命中返回，
// 否则调用方会拿到一个即将消失的站点。
func (d *siteDao) GetByIdempotencyKey(userID, idempotencyKey string) (*SiteEntity, error) {
	if idempotencyKey == "" {
		return nil, nil
	}
	var entity SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND idempotency_key = ? AND status NOT IN ? AND deleted_time IS NULL",
			userID, idempotencyKey, []string{SiteStatusDeleting, SiteStatusDeleted}).
		First(&entity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &entity, nil
}

// ---- Release DAO ----

type ReleaseDao interface {
	model.Dao
	CreateRelease(entity *ReleaseEntity) error
	CreateReleaseTx(tx *gorm.DB, entity *ReleaseEntity) error
	GetByReleaseID(releaseID string) (*ReleaseEntity, error)
	ListBySiteID(siteID string, page, pageSize int) ([]*ReleaseEntity, int64, error)
	UpdateStatus(releaseID, newStatus, errorMessage string) error
	GetActiveBySiteID(siteID string) (*ReleaseEntity, error)
	GetNextVersionTx(tx *gorm.DB, siteID string) (int, error)
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

func (d *releaseDao) CreateReleaseTx(tx *gorm.DB, entity *ReleaseEntity) error {
	if entity == nil {
		return errors.New("entity is nil")
	}
	return tx.Table(d.TableName).Create(entity).Error
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

// GetNextVersionTx 在事务内获取下一个版本号（行锁防并发）
func (d *releaseDao) GetNextVersionTx(tx *gorm.DB, siteID string) (int, error) {
	var maxVersion int
	err := tx.Table(d.TableName).
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
	ListByStatus(status string, limit int) ([]*OperationEntity, error)
	UpdateStatusTx(tx *gorm.DB, operationID, newStatus, errorMessage string) error
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

func (d *operationDao) UpdateStatusTx(tx *gorm.DB, operationID, newStatus, errorMessage string) error {
	updates := map[string]interface{}{"status": newStatus}
	if errorMessage != "" {
		updates["error_message"] = errorMessage
	}
	return tx.Table(d.TableName).
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

func (d *operationDao) ListByStatus(status string, limit int) ([]*OperationEntity, error) {
	var entities []*OperationEntity
	query := resource.GormDB.Table(d.TableName).Where("status = ?", status)
	if status == OpStatusCreated {
		query = query.Where("(next_retry_at IS NULL OR next_retry_at <= ?)", time.Now().UTC())
	}
	err := query.
		Order("created_time ASC, id ASC").
		Limit(limit).
		Find(&entities).Error
	return entities, err
}
