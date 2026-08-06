// Package website DAO
package website

import (
	"errors"
	"fmt"
	"time"

	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	ListServingByUserID(userID string) ([]*SiteEntity, error)
	ListSuspendedByUserID(userID string) ([]*SiteEntity, error)
	GetByIdempotencyKey(userID, idempotencyKey string) (*SiteEntity, error)
	UpdateStorageBytes(siteID string, storageBytes int64) error
	SumStorageBytesByUserID(userID string) (int64, error)
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

// ListServingByUserID 列出「套餐一旦失效就必须停止对外服务」的站点。
//
// 除了 active，creating 也必须包含进来。缺了 creating 会留下一个真实的正确性缺口：
// 套餐到期的瞬间若某站点还停在 creating，隔离会跳过它，随后那次 create 操作成功
// 回调又会把它置为 active——结果是套餐已经过期、站点却正常对外服务。
// 把 creating 一并转成 suspended 之后，站点状态迁移会推进 operation_generation，
// 在途的那次 create 回调会被 generation 围栏判为 superseded，无法再把站点拉回 active。
func (d *siteDao) ListServingByUserID(userID string) ([]*SiteEntity, error) {
	var entities []*SiteEntity
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND status IN ? AND deleted_time IS NULL",
			userID, []string{SiteStatusCreating, SiteStatusActive}).
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

// UpdateStorageBytes 回填站点当前占用的 COS 字节数。
//
// 只更新未软删的行：删除操作完成后 deployer 会再上报一次 0，但那次上报和
// CompleteOperation 的软删是两个独立请求，谁先到达不确定。加上这个条件后，
// 迟到的上报不会把一行已删站点的用量改回非零值。
func (d *siteDao) UpdateStorageBytes(siteID string, storageBytes int64) error {
	if storageBytes < 0 {
		storageBytes = 0
	}
	return resource.GormDB.Table(d.TableName).
		Where("site_id = ? AND deleted_time IS NULL", siteID).
		Update("storage_bytes", storageBytes).Error
}

// SumStorageBytesByUserID 汇总用户所有仍然存在的站点的存储用量。
//
// 与流量口径不同：已删除的站点其 COS 对象是真的被清掉了，不该继续占用存储额度；
// 而流量是按月的消耗量，删站不能让当月额度凭空恢复，否则反复建删就能刷流量。
func (d *siteDao) SumStorageBytesByUserID(userID string) (int64, error) {
	var total int64
	err := resource.GormDB.Table(d.TableName).
		Where("user_id = ? AND deleted_time IS NULL", userID).
		Select("COALESCE(SUM(storage_bytes), 0)").
		Scan(&total).Error
	return total, err
}

// ---- 日用量 DAO ----

// UsageDao 维护 website_usage_daily。
//
// 只有两个动作：站点网关按分钟上报的增量累加，以及按用户查当月合计。
type UsageDao interface {
	AddDailyTraffic(siteID, userID, usageDate string, trafficBytes, requestCount int64) error
	SumTrafficBytesInRange(userID, fromDate, toDate string) (int64, error)
}

type usageDao struct{}

func NewUsageDao() UsageDao {
	return &usageDao{}
}

// UsageDateLayout 是 usage_date 的规范化写法。
//
// 读写两侧都用这个日期字符串而不是 time.Time：MySQL 的列类型是 DATE，
// 而 SQLite（单测）里同一个 time.Time 会被存成带时分秒的字符串，
// 那样同一天会因为时间部分不同而落到不同的行，唯一键 (site_id, usage_date) 失效。
const UsageDateLayout = "2006-01-02"

// AddDailyTraffic 把一个上报窗口的增量累加到 (site_id, usage_date) 那一行。
//
// 累加而不是覆盖：站点网关是多副本的，每个副本各自聚合各自上报，同一天同一站点
// 会被多次写入。代价是这个动作天然不幂等，上报重试会重复计数——见调用方对误差
// 来源的说明。
func (d *usageDao) AddDailyTraffic(siteID, userID, usageDate string, trafficBytes, requestCount int64) error {
	if siteID == "" || usageDate == "" {
		return errors.New("site_id and usage_date are required")
	}
	return resource.GormDB.Table(UsageDailyTable).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "site_id"}, {Name: "usage_date"}},
			DoUpdates: clause.Assignments(map[string]interface{}{
				"traffic_bytes": gorm.Expr(UsageDailyTable+".traffic_bytes + ?", trafficBytes),
				"request_count": gorm.Expr(UsageDailyTable+".request_count + ?", requestCount),
			}),
		}).
		Create(map[string]interface{}{
			"site_id":       siteID,
			"user_id":       userID,
			"usage_date":    usageDate,
			"traffic_bytes": trafficBytes,
			"request_count": requestCount,
			"created_time":  time.Now().UTC(),
			"updated_time":  time.Now().UTC(),
		}).Error
}

// SumTrafficBytesInRange 汇总用户在 [fromDate, toDate] 区间内的流量。
//
// 按 user_id 而不是 join 站点表：站点删除后历史流量记录保留，月额度是按用户算的，
// 删站不该让当月已用额度凭空恢复。
func (d *usageDao) SumTrafficBytesInRange(userID, fromDate, toDate string) (int64, error) {
	var total int64
	err := resource.GormDB.Table(UsageDailyTable).
		Where("user_id = ? AND usage_date >= ? AND usage_date <= ?", userID, fromDate, toDate).
		Select("COALESCE(SUM(traffic_bytes), 0)").
		Scan(&total).Error
	return total, err
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
