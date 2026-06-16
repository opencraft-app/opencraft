package pass

import (
	"context"
	"errors"
	"fmt"
	"time"

	"ctl/pkg/model"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"

	"gorm.io/gorm"
)

// === trade-pass-destroy 设计稿落地（§4.3 history_pass DAO + MoveToHistory）===
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3 / §11-A Q6 / Q24
//
// 文件分布：
//   - ctl/pkg/model/pass/history_entity.go：HistoryEntity 实体定义
//   - ctl/pkg/model/pass/history_dao.go（本文件）：HistoryDao 接口 + 实现
//   - ctl/pkg/model/pass/dao.go：Dao 接口扩展 MoveToHistory（跨 pass + history_pass 双表事务）
//
// 注意：设计稿原写 `ctl/pkg/store/pass/history_dao.go`，与 ctl 仓现状不符（仓内并无
// `ctl/pkg/store/` 目录，所有 DAO 均位于 `ctl/pkg/model/<entity>/dao.go` 同包内），
// 本期沿用现状归并到 model/pass 包内。

// ErrPassNotFound 表示 pass 表与 history_pass 表均无对应 pass_id 记录（非幂等的真实缺失）
//
// MoveToHistory 返此错误时，caller（destroy 父 task 步骤 5b）应视为业务异常并 return error
// 触发父 task 重投；连续多次 ErrPassNotFound 通常说明 trade_flow 状态与 ctl 真源已严重背离，
// 需要人工介入排查（不会通过重投自愈）。
var ErrPassNotFound = errors.New("pass not found in pass table or history_pass table")

// HistoryDao history_pass 数据访问接口
//
// 与 Dao 的对偶关系：
//   - Dao 操作 pass 表（在用 pass，含 active/isolating/isolated/renewing/deleting/terminating 六态）
//   - HistoryDao 操作 history_pass 表（销毁完成后的历史 pass，含 deleted_time + destroy_reason）
//
// HistoryDao 不直接负责 MoveToHistory（跨表事务），MoveToHistory 由主 Dao 提供（见 dao.go）。
// HistoryDao 只承担 history_pass 表的纯读 + 直插（管理后台 / 历史查询用）。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3
type HistoryDao interface {
	// Insert 直接插入 HistoryEntity（管理后台数据修复用；销毁主链不走此入口，走 MoveToHistory）
	//
	// destroyReason 镜像 jifei para.source 原值（biz/qn/other/空串）。Q24 ✅ 拍板。
	// caller 负责保证 deletedTime 非零（history_pass.deleted_time NOT NULL 约束）。
	Insert(ctx context.Context, p *Entity, deletedTime time.Time, destroyReason string) error

	// GetByPassID 按 pass_id 反查历史记录；不存在时返 gorm.ErrRecordNotFound
	GetByPassID(ctx context.Context, passID string) (*HistoryEntity, error)

	// ListByUserID 按 user_id 反查历史记录列表（按 deleted_time DESC 排序）
	ListByUserID(ctx context.Context, userID string) ([]*HistoryEntity, error)
}

// historyDao 默认 GORM 实现
type historyDao struct {
	*model.BaseDao
}

// NewHistoryDao 构造 history_pass DAO
func NewHistoryDao() HistoryDao {
	return &historyDao{
		BaseDao: model.NewBaseDao(HistoryTableName).SetKeyColumn(HistoryColumnPassID),
	}
}

// Insert 详见 HistoryDao 接口注释
func (d *historyDao) Insert(_ context.Context, p *Entity, deletedTime time.Time, destroyReason string) error {
	if p == nil {
		return errors.New("Insert: pass entity is nil")
	}
	row := fromActivePass(p, deletedTime, destroyReason)
	if err := d.DB().Create(row).Error; err != nil {
		return fmt.Errorf("HistoryDao.Insert: %w", err)
	}
	return nil
}

// GetByPassID 详见 HistoryDao 接口注释
func (d *historyDao) GetByPassID(_ context.Context, passID string) (*HistoryEntity, error) {
	var row HistoryEntity
	if err := d.SelectByKeyColumn(passID, &row); err != nil {
		return nil, err
	}
	return &row, nil
}

// ListByUserID 详见 HistoryDao 接口注释
func (d *historyDao) ListByUserID(_ context.Context, userID string) ([]*HistoryEntity, error) {
	var rows []*HistoryEntity
	if err := d.DB().
		Where(fmt.Sprintf("%s = ?", HistoryColumnUserID), userID).
		Order(HistoryColumnDeletedTime + " DESC").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("HistoryDao.ListByUserID: %w", err)
	}
	return rows, nil
}

// === MoveToHistory：跨 pass + history_pass 双表的同事务幂等迁移 ===
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3 / §11-A Q6 / Q24
//
// 单事务流程：
//
//  1. SELECT pass WHERE pass_id=? FOR UPDATE
//     - 找到 → 走 step 2（INSERT history_pass + DELETE pass）
//     - 未找到 → SELECT history_pass WHERE pass_id=?
//     - 找到 → return (alreadyMigrated=true, nil)  // 幂等成功（重投场景）
//     - 未找到 → return ErrPassNotFound            // 真实缺失（异常）
//  2. INSERT history_pass（碰 UNIQUE pass_id 冲突 → 视为已迁，转 step 1 的幂等分支）
//  3. DELETE pass
//
// 调用方约束：
//   - 返回 alreadyMigrated=true 时，caller 应跳过本步骤继续后续流程（如 5c CompleteFlow）
//   - 返回 alreadyMigrated=false + nil 时，caller 视为本次新迁移成功，正常推进 payload.PassDeleted=true
//   - 返回 err != nil 时，caller 应让父 task 重投（事务自动回滚，pass 与 history_pass 状态一致）
func (d *dao) MoveToHistory(
	ctx context.Context,
	passID string,
	deletedTime time.Time,
	destroyReason string,
) (alreadyMigrated bool, err error) {
	if passID == "" {
		return false, errors.New("MoveToHistory: passID empty")
	}
	if deletedTime.IsZero() {
		return false, errors.New("MoveToHistory: deletedTime zero")
	}

	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		// step 1：先查 pass 表
		var p Entity
		findErr := tx.Table(TableName).
			Where(fmt.Sprintf("%s = ?", ColumnPassID), passID).
			First(&p).Error
		if findErr != nil && !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return fmt.Errorf("MoveToHistory: select pass: %w", findErr)
		}

		if errors.Is(findErr, gorm.ErrRecordNotFound) {
			// pass 未找到 → 查 history_pass 判断是否已迁
			var h HistoryEntity
			hErr := tx.Table(HistoryTableName).
				Where(fmt.Sprintf("%s = ?", HistoryColumnPassID), passID).
				First(&h).Error
			if hErr == nil {
				alreadyMigrated = true
				return nil
			}
			if errors.Is(hErr, gorm.ErrRecordNotFound) {
				return ErrPassNotFound
			}
			return fmt.Errorf("MoveToHistory: select history_pass: %w", hErr)
		}

		// step 2：INSERT history_pass
		row := fromActivePass(&p, deletedTime, destroyReason)
		if insertErr := tx.Table(HistoryTableName).Create(row).Error; insertErr != nil {
			// step 2 兜底：UNIQUE pass_id 冲突 → 视为已迁，删 pass 行后返 alreadyMigrated=true
			//
			// 此分支保护"step 1 看到 pass 但事务隔离级别下 history_pass 已存"的极小概率竞态：
			//   - 例如父 task A、B 并发重投，A 已 INSERT history_pass + DELETE pass 提交，
			//     B 在 RR 隔离级 snapshot 内仍看到 pass 行 → INSERT 撞 unique → 应当幂等
			if isDuplicateKeyError(insertErr) {
				if delErr := tx.Table(TableName).
					Where(fmt.Sprintf("%s = ?", ColumnPassID), passID).
					Delete(nil).Error; delErr != nil {
					return fmt.Errorf("MoveToHistory: cleanup pass after dup history: %w", delErr)
				}
				alreadyMigrated = true
				return nil
			}
			return fmt.Errorf("MoveToHistory: insert history_pass: %w", insertErr)
		}

		// step 3：DELETE pass
		delResult := tx.Table(TableName).
			Where(fmt.Sprintf("%s = ?", ColumnPassID), passID).
			Delete(nil)
		if delResult.Error != nil {
			return fmt.Errorf("MoveToHistory: delete pass: %w", delResult.Error)
		}
		if delResult.RowsAffected != 1 {
			// step 1 SELECT 已命中，DELETE 应当 affect 1 行；不一致说明并发删除（重投场景）
			// 事务尚未提交，history_pass 的 INSERT 也会随返回 error 一起回滚 → 状态一致
			return fmt.Errorf("MoveToHistory: delete pass rows_affected=%d (concurrent delete?)", delResult.RowsAffected)
		}

		// step 4（用户 2026-05-25 拍板）：DELETE user_resource_quota 用户配额行
		//
		// 修复两个塑性 bug：
		//   - bug 一（quota 未归还）：DestroyInstanceWithSnapshot 子 task 销毁 instance 后不归还
		//     OPENCLAW_INSTANCE 配额，导致 user_resource_quota.available 被抵护住不归零。销毁 pass
		//     是“万能清理”起点 —— pass 一旦被销毁，该用户名下所有 instance 都会被子 task 一起销毁，
		//     此时 quota 行本身已不再被需要，整行删除即使加销毁路径上错过的归还也被修复。
		//   - bug 二（quota 行未删）：销毁 pass 仅 MoveToHistory 迫使 pass 行迁移，并未联动清
		//     user_resource_quota 表 —— 下次同用户新购 pass 时 ensureDefaultQuota 可能看到脸面多仪的
		//     残留行（total/available 会被 CreatePassWithQuota CAS 覆盖，但脸面上是遗留场景）。
		//
		// 实现要点：
		//   - resource_name = 'OPENCLAW_INSTANCE'、resource_key = ''（与 CreatePassWithQuota / AllocQuota 同范式）
		//   - 仅删该用户该资源名下的 quota 行；不跨 user 、不跨 resource，避免误伤
		//   - 在同事务里执行，与 history_pass INSERT + pass DELETE 原子；RowsAffected==0 也是 OK（重投、
		//     或该用户从未创建过配额表项的场景）、不进错误路径。
		//   - 业务上“用户唯一 pass”约束（见 logic/pass 获取商品列表逻辑与设计稿 §3.1）下，销毁该
		//     pass 后该用户在本资源名下不会再有有效资源，整行删除是联动一致性修复。
		if p.UserID != "" {
			if qErr := tx.Table(quota.TableName).
				Where(quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ?",
					p.UserID, "OPENCLAW_INSTANCE", "").
				Delete(nil).Error; qErr != nil {
				return fmt.Errorf("MoveToHistory: delete user_resource_quota: %w", qErr)
			}
		}
		return nil
	})

	if err != nil {
		return false, err
	}
	return alreadyMigrated, nil
}

// isDuplicateKeyError 检查是否为 MySQL/SQLite 的唯一键冲突错误（与 model.dao.go 同名函数对偶）
//
// MySQL 错误 1062 / SQLite "UNIQUE constraint failed" 都视为重复键。
// 不引用 model 包的私有 isDuplicateKeyError 是因为它未导出，pass 包不能直接复用；
// 此处保持局部范式一致即可。
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return contains(msg, "Duplicate entry") ||
		contains(msg, "1062") ||
		contains(msg, "UNIQUE constraint failed")
}

func contains(s, substr string) bool {
	if len(substr) == 0 {
		return true
	}
	if len(s) < len(substr) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
