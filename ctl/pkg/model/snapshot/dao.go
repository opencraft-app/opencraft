package snapshot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"ctl/pkg/model"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

// Dao snapshot 数据访问接口
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.4 / §11-A Q4-a / Q9-fix
//
// 销毁链路调用图：
//   - 销毁子 task 阶段 1：CreateSnapshot 成功后调 Insert 持久化 snapshot 元数据
//   - 销毁子 task 阶段 2：轮询 sandbox snapshot-status 时 GetByFlowAndInstance 反查防重 + UpdateState 推进状态
//   - snapshot cron：ListExpired 找到期记录 → 删 cbs 物理快照 → DeleteByID 清表
//   - 用户/admin 查询：ListByPassID 反查某 pass 的全部销毁历史快照
type Dao interface {
	model.Dao

	// Create 插入新的快照记录（销毁子 task 阶段 1 调用）
	//
	// 入参 entity 必须已填齐 SnapshotID / FlowID / PassID / InstanceID / UserID / Uin / AppID
	// / Region / SnapshotState / ExpireTime 字段。
	// 碰 (flow_id, instance_id) 唯一键冲突时返底层 DB error（caller 应视为已存在 → 反查 GetByFlowAndInstance）
	//
	// 命名为 Create 避免与 model.Dao.Insert(entities ...interface{}) 内嵌方法签名冲突；
	// 销毁链路语义上"创建一条 snapshot 行"，Create 与设计稿"snapshotDAO.Insert(ctx, s)"语义一致。
	Create(ctx context.Context, entity *Entity) error

	// GetByFlowAndInstance Q9-fix 修订：销毁链路重投幂等反查（替代原 GetByInstanceID）
	//
	// 用于销毁子 task 重投时判断"本 flow 内本 instance 是否已创快照"，是子 task 阶段 1 的去重检查。
	// 不存在时返 gorm.ErrRecordNotFound。
	GetByFlowAndInstance(ctx context.Context, flowID int64, instanceID string) (*Entity, error)

	// ListByPassID 反查某 pass 关联的全部快照（按创建时间 DESC 排序，含跨 flow 多次销毁的历史）
	ListByPassID(ctx context.Context, passID string) ([]*Entity, error)

	// ListExpired 反查 expire_time < before 且未删除的快照（用于 snapshot cron）
	//
	// limit > 0 时分页返结果；按 expire_time ASC 排序，先到期的先处理。
	ListExpired(ctx context.Context, before time.Time, limit int) ([]*Entity, error)

	// DeleteByID 按主键 id 物理删除（snapshot cron 删完 cbs 物理快照后清表用）
	DeleteByID(ctx context.Context, id int64) error

	// UpdateState 子 task 阶段 2 轮询时推进 snapshot_state（in_progress → ready / failed）
	//
	// CAS WHERE snapshot_id=? UPDATE snapshot_state=newState；
	// 返 (true, nil) 表示更新命中，(false, nil) 表示 snapshot 行不存在。
	UpdateState(ctx context.Context, snapshotID, newState string) (updated bool, err error)
}

type dao struct {
	*model.BaseDao
}

// NewDao 构造 snapshot DAO
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnSnapshotID),
	}
}

// Create 详见 Dao 接口注释
func (d *dao) Create(_ context.Context, entity *Entity) error {
	if entity == nil {
		return errors.New("Create: snapshot entity is nil")
	}
	if entity.SnapshotID == "" {
		return errors.New("Create: SnapshotID empty")
	}
	if entity.FlowID == 0 || entity.InstanceID == "" {
		return errors.New("Create: FlowID or InstanceID empty")
	}
	if err := d.DB().Create(entity).Error; err != nil {
		return fmt.Errorf("snapshot.Create: %w", err)
	}
	return nil
}

// GetByFlowAndInstance 详见 Dao 接口注释
func (d *dao) GetByFlowAndInstance(_ context.Context, flowID int64, instanceID string) (*Entity, error) {
	var row Entity
	if err := d.DB().
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnFlowID, ColumnInstanceID), flowID, instanceID).
		First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// ListByPassID 详见 Dao 接口注释
func (d *dao) ListByPassID(_ context.Context, passID string) ([]*Entity, error) {
	var rows []*Entity
	if err := d.DB().
		Where(fmt.Sprintf("%s = ?", ColumnPassID), passID).
		Order(ColumnExpireTime + " DESC").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("snapshot.ListByPassID: %w", err)
	}
	return rows, nil
}

// ListExpired 详见 Dao 接口注释
func (d *dao) ListExpired(_ context.Context, before time.Time, limit int) ([]*Entity, error) {
	var rows []*Entity
	q := resource.GormDB.Table(TableName).
		Where(fmt.Sprintf("%s < ?", ColumnExpireTime), before).
		Order(ColumnExpireTime + " ASC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	if err := q.Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("snapshot.ListExpired: %w", err)
	}
	return rows, nil
}

// DeleteByID 详见 Dao 接口注释
func (d *dao) DeleteByID(_ context.Context, id int64) error {
	result := d.DB().Where("id = ?", id).Delete(&Entity{})
	if result.Error != nil {
		return fmt.Errorf("snapshot.DeleteByID: %w", result.Error)
	}
	// rows_affected==0 视为已删（幂等），不返错；snapshot cron 多 worker 并发时常见
	return nil
}

// UpdateState 详见 Dao 接口注释
func (d *dao) UpdateState(_ context.Context, snapshotID, newState string) (bool, error) {
	if snapshotID == "" {
		return false, errors.New("UpdateState: snapshotID empty")
	}
	if newState != StateInProgress && newState != StateNormal && newState != StateError {
		return false, fmt.Errorf("UpdateState: unknown state %q", newState)
	}
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ?", ColumnSnapshotID), snapshotID).
		Update(ColumnSnapshotState, newState)
	if result.Error != nil {
		return false, fmt.Errorf("snapshot.UpdateState: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// 防止未使用 import（gorm 用于 ErrRecordNotFound 类型断言依赖）
var _ = gorm.ErrRecordNotFound
