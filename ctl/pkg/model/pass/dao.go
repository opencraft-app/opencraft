package pass

import (
	"context"
	"fmt"
	"time"

	"ctl/pkg/model"

	quota "ctl/pkg/model/userresourcequota"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Dao Pass 数据访问接口
type Dao interface {
	model.Dao

	GetByPassID(passID string) (*Entity, error)
	ListByUserID(userID string) ([]*Entity, error)
	ListByBundleID(bundleID string) ([]*Entity, error)
	ListByAppID(appID int64) ([]*Entity, error)
	ListByFilters(userID *string, bundleID *string) ([]*Entity, error)
	ListByFiltersPage(userID *string, bundleID *string, status *string, limit, offset int) ([]*Entity, int64, error)
	Create(entity *Entity) error
	UpdateByPassID(passID string, updates map[string]interface{}) error

	// CreatePassWithQuota 在同一事务中插入 pass 记录并替换更新配额
	// agentQuota 为 Bundle 的 agent_quota 值（最大配额上限，替换语义）
	CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error

	// === jifei 反查接口三件套（billing-integration B11A 新增）===
	// 设计稿：.tmp/trade-resource-query-design.md §4.1
	//
	// 共同约定：
	//   - bundleIDs 入参为 nil 或空切片时，DAO 内部省略 `WHERE bundle_id IN (...)` 子句（Q2 拍板，2026-05-11）
	//   - SELECT 列表与 WHERE 子句均不涉及 `deleted_time` 字段（Q9 拍板，2026-05-11：销毁走物理 DELETE）
	//   - 分页：0-based pageNo，limit/offset 由 caller 计算并传入

	// ListDistinctAppIDsByBundleIDs 按 bundle_id 集合反查去重的 app_id 列表 + 总数
	// 对应 jifei.getAllAppIds（trade → ctl GET /internal/ctl/passes/app-ids）
	ListDistinctAppIDsByBundleIDs(bundleIDs []string, limit, offset int) (appIDs []int64, total int64, err error)

	// ListByAppIDAndBundleIDs 按 app_id + 可选 bundle_id 集合反查 pass 实体列表 + 总数
	// 对应 jifei.getUserResources（trade → ctl GET /internal/ctl/passes/by-app）
	ListByAppIDAndBundleIDs(appID int64, bundleIDs []string, limit, offset int) (entities []*Entity, total int64, err error)

	// ListByAppIDAndPassIDs 按 app_id + pass_id 集合反查 pass 实体列表（命中数即为实际数量）
	// 对应 jifei.queryResource（trade → ctl POST /internal/ctl/passes/by-resource-ids）
	ListByAppIDAndPassIDs(appID int64, passIDs []string) ([]*Entity, error)

	// === trade-pass-isolate 设计稿落地（pass.status 状态机）===
	// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q8 / Q23 / Q22-I-E
	//
	// CAS 拿锁语义：原子地把 pass.status 从 'active' 变成 'isolating'
	//   - 返回 (true, nil)  表示拿锁成功，调用方负责派发子 task
	//   - 返回 (false, nil) 表示已被其他流程并发拿走锁（pass 当前不是 active 状态）
	//   - 返回 (_, err) 表示底层 DB 异常，调用方应让 task 框架重试
	//
	// 幂等性保证：
	//   - 父 task 被框架重试调用时，第二次调用拿不到锁，但子 task 已经派发，本次直接 finalize 即可
	//   - 拍板依据：Q22-I-E（父 task 用 child_registry 防重复派发）+ Q35=a（max_execute_count=INT64_MAX 兜底）
	TryAcquireSlotForIsolate(passID string) (acquired bool, err error)

	// UpdateStatus 将 pass.status 从 expectedStatus 推进到 newStatus（通用 CAS）
	//   - 不再用于 isolating → isolated 推进（v1.7.30 后改用 MarkIsolated / MarkIsolatedWithExpiredTime —
	//     设计稿 trade-pass-isolate §11-Q22 钦点：父 task 终态需同时写 isolated_time = NOW()）
	//   - 仍用于 trade-pass-renew §3.1 v3.8 isolated → renewing CAS（异步续费分支入口）
	//   - 返回 (true, nil) 表示推进成功；(false, nil) 表示当前状态与 expectedStatus 不匹配
	UpdateStatus(passID, expectedStatus, newStatus string) (updated bool, err error)

	// === trade-pass-renew §3.1 提前续费同步路径（active 路径）===
	// 设计稿：.tmp/trade-pass-renew-design.md §3.1 / §3.4 v3.8
	//
	// CAS 语义：原子地满足 `pass_id=? AND status='active'` 时，更新 expired_time 为 newExpiredTime；
	// status 字段不动（保持 active），与 isolate 链路的 status CAS 区分。
	//   - 返回 (true, nil) 表示拿到锁并写入成功（rows_affected == 1）
	//   - 返回 (false, nil) 表示状态已不是 active（如 isolating/isolated/renewing），调用方应据此返对应错误码
	//   - 返回 (_, err) 表示底层 DB 异常
	//
	// 用例：ctl.RenewPass 分支 A — pass.status=='active' 时直接同步延长 expired_time，
	// 不切 status，不入队 task；trade callback CompleteFlow(flow_id, completed) 紧随其后。
	UpdateExpiredTimeIfActive(passID string, newExpiredTime time.Time) (updated bool, err error)

	// === trade-pass-renew §3.4 异步续费父 task 终态收尾（renewing → active）===
	// 设计稿：.tmp/trade-pass-renew-design.md §3.4 / §5 / §12 Q2=a / R-D-3
	//
	// CAS 语义：原子地满足 `pass_id=? AND status='renewing'` 时，一次性写入：
	//   - status = 'active'
	//   - expired_time = newExpiredTime（基线 = expired_time，v1.7.20 B15 修订；
	//     原设计稿 §12 Q2=a 写 isolated_time 已废弃 — 续费业务语义统一以原到期时间为基线，
	//     与 jifei goodsDetail.curDeadline 协议层语义对齐，避免 ctl ↔ jifei 时长漂移）
	//   - isolated_time = NULL（清空，pass 已恢复正常）
	//
	// 不可拆成 3 个 UPDATE：renewing 状态对外可见，期间 expired_time/status 处于 "中间态"
	// 会让 reconcile worker / 前端 / 计费侧出现一致性问题。
	//
	// 返回 (true, nil) 表示推进成功（rows_affected == 1）；
	// 返回 (false, nil) 表示当前状态不是 renewing（如已被并发推到 active；幂等场景）；
	// 返回 (_, err) 表示 DB 异常。
	//
	// 用例：renewPassTask.execute 等所有子 task 终态后，计算 newExpired
	// = CalcExpiredTime(pass.expired_time, time_span, time_unit) 然后调本方法
	// （v1.7.20 B15 修订：基线 expired_time 取代 isolated_time）。
	FinalizeRenewal(passID string, newExpiredTime time.Time) (updated bool, err error)

	// === R-MR-5 续费失败回滚收尾 CAS（2026-05-24 用户拍板）===
	// 设计稿：.tmp/trade-pass-renew-design.md §3.4 失败回滚链路升级
	//
	// 用例：rollbackRenewPassTask 在 IsolateInstance 子 task 全部终态 + Align ai-gateway 回旧
	// 值后，调本方法把 pass 状态原子地从 'renewing' 回滚到原态（active 或 isolated）。
	//
	// CAS 语义：原子地满足 `pass_id=? AND status='renewing'` 时，一次性写入：
	//   - status                        = targetStatus（'active' 或 'isolated'）
	//   - expired_time                  = originalExpiredTime（写回续费前的旧值）
	//   - isolated_time（仅当 originalIsolatedTime != nil 时写）= *originalIsolatedTime
	//   - isolated_time（当 originalIsolatedTime == nil 时） = NULL（active 续费回滚）
	//
	// 二态语义关键区别：
	//   - originalIsolatedTime == nil  → targetStatus 必须是 active；isolated_time 写 NULL
	//     （续费前 pass 是 active 状态，本就无 isolated_time）
	//   - originalIsolatedTime != nil  → targetStatus 必须是 isolated；isolated_time 写回原值
	//     （续费前 pass 是 isolated 状态，回滚后保持 isolated）
	//
	// 不可拆成多个 UPDATE：renewing 状态对外可见，期间 status / expired_time / isolated_time
	// 处于 "中间态" 会让 reconcile worker / 前端 / 计费侧出现一致性问题（与 FinalizeRenewal 同范式）。
	//
	// 返回：
	//   - (true, nil)  → 推进成功（rows_affected == 1）
	//   - (false, nil) → 当前状态不是 renewing（如已被并发推进；幂等场景）
	//   - (_, err)     → DB 异常
	//
	// 入参校验由 caller 负责（worker 端）：
	//   - originalIsolatedTime == nil ↔ targetStatus == 'active'
	//   - originalIsolatedTime != nil ↔ targetStatus == 'isolated'
	//   - 不变量错误（如 nil + 'isolated'）由 caller 返错，DAO 不做语义校验只做 SQL 执行。
	RollbackRenewal(passID, targetStatus string, originalExpiredTime time.Time, originalIsolatedTime *time.Time) (updated bool, err error)

	// MarkIsolated 父 task IsolatePass 生命周期隔离分支终态 CAS
	// 设计稿：trade-pass-isolate §11-Q22（钦点 SQL：UPDATE pass SET status='isolated',
	// isolated_time=NOW() WHERE pass_id=? AND status='isolating'）。
	//
	// CAS 语义：原子地满足 `pass_id=? AND status='isolating'` 时，一次事务里：
	//   - status        = 'isolated'
	//   - isolated_time = isolatedTime（由 caller 传 time.Now().UTC()，与既有 DAO 范式一致；
	//                     便于单测打桩，避免 DB 时钟漂移）
	//
	// 用于生命周期隔离场景（jifei isolateResource 不带 newDeadline / dealName）。
	// 退费场景请走 MarkIsolatedWithExpiredTime。
	//
	// 返回 (true, nil) 表示推进成功（rows_affected == 1）；
	// 返回 (false, nil) 表示当前状态不是 isolating（可能已被并发推到 isolated；幂等场景）；
	// 返回 (_, err) 表示 DB 异常。
	MarkIsolated(passID string, isolatedTime time.Time) (updated bool, err error)

	// MarkIsolatedWithExpiredTime 父 task IsolatePass 退费分支终态 CAS（v1.7.30 BUG-35）。
	//
	// CAS 语义：原子地满足 `pass_id=? AND status='isolating'` 时，一次事务里：
	//   - status        = 'isolated'
	//   - expired_time  = newExpiredTime（jifei 退费 newDeadline，CST 字面值已解析为 UTC 绝对时刻）
	//   - isolated_time = isolatedTime（由 caller 传 time.Now().UTC()）
	//
	// 与 MarkIsolated 的差异：本方法多写一列 expired_time（退费链路 jifei 给的新到期时间）。
	// 退费本质上仍是隔离操作，故 isolated_time 同样写入隔离完成时刻 — 与生命周期分支一致。
	//
	// 原子性：不可拆成 "先 UpdateExpiredTime + 后 MarkIsolated" 两次 UPDATE，
	// 否则 expired_time / isolated_time 在 isolating 中间态可见会让计费侧 / reconcile worker 看到不一致。
	//
	// 返回 (true, nil) 表示推进成功（rows_affected == 1）；
	// 返回 (false, nil) 表示当前状态不是 isolating（可能已被并发推到 isolated；幂等场景）；
	// 返回 (_, err) 表示 DB 异常。
	MarkIsolatedWithExpiredTime(passID string, newExpiredTime, isolatedTime time.Time) (updated bool, err error)

	// === trade-pass-destroy 设计稿落地（pass.status CAS 销毁链路扩展）===
	// 设计稿：.tmp/trade-pass-destroy-design.md §4.1 / §4.5.1 / §11-A Q1 / Q2
	//
	// CAS 拿锁语义：原子地把 pass.status 从 'isolated' 变成 'deleting'
	//   - 用于入口 A（用户主动销毁）：ctl.DeletePass logic 入口的状态推进 + 幂等防重
	//   - 返回 (true, nil)  表示 CAS 成功，调用方负责同步调 trade.DeleteResource 触发 jifei
	//   - 返回 (false, nil) 表示 CAS 失败（status ≠ isolated；可能是 active/isolating/renewing/deleting/terminating
	//     或 pass 不存在）；调用方应再读 GetByPassID 决定返回 ErrPassNotFound / ErrPassDeleting / 其它状态错
	//   - 返回 (_, err) 表示底层 DB 异常，调用方应让上层重试或返 5xx
	//
	// 与 TryAcquireSlotForIsolate 的对偶关系：
	//   - TryAcquireSlotForIsolate：active → isolating（隔离链路入口）
	//   - TryAcquireSlotForDelete：  isolated → deleting（销毁链路入口 A）
	//
	// 不引入 sentinel error 区分 NotFound vs StatusMismatch（与 isolate 链路一致；
	// caller 上下文已足够判断，且 ctl 调用方在 CAS 失败后会再读 GetByPassID 决定具体错误码）。
	TryAcquireSlotForDelete(passID string) (acquired bool, err error)

	// === trade-pass-destroy 设计稿落地（§3.5 / §4.5.2 / §4.5.3 / §11-A Q1）===
	//
	// CAS 拿锁语义：原子地把 pass.status 从 ('deleting' 或 'isolated') 变成 'terminating'
	//   - 用于 ctl.DestroyPass logic 入口（trade.destroyResource 反向调），双源 from 兼容两条入口：
	//       入口 A 用户主动销毁：deleting → terminating （ctl.DeletePass 已先把 isolated 推到 deleting）
	//       入口 B 计费回调销毁：isolated → terminating （跳过 deleting；jifei 主动发起，无重复点击场景）
	//   - 返回 (true, nil)  表示 CAS 成功，调用方负责入队销毁父 task 推进主链
	//   - 返回 (false, nil) 表示 CAS 失败（status 不在 {deleting, isolated} 集合；可能是 active/isolating/
	//     renewing/terminating 或 pass 不存在）；调用方应再读 GetByPassID 决定返回错误码
	//   - 返回 (_, err) 表示底层 DB 异常，调用方应让上层重试或返 5xx
	//
	// 与 TryAcquireSlotForIsolate / TryAcquireSlotForDelete 的对偶关系：
	//   - TryAcquireSlotForIsolate：    active        → isolating
	//   - TryAcquireSlotForDelete：     isolated      → deleting
	//   - TryAcquireSlotForTerminate：  deleting∨isolated → terminating （双源 from）
	//
	// 实现要点：单条 SQL `UPDATE ... WHERE pass_id=? AND status IN ('deleting','isolated')`，
	// MySQL 原子保证 — 无需事务/SELECT FOR UPDATE，与现有 CAS 拿锁同范式。
	TryAcquireSlotForTerminate(passID string) (acquired bool, err error)

	// ListByStatus 按 status 反查 pass 列表，供 reconcile worker 扫描卡死状态
	//   - 主要用法：ListByStatus("isolating", limit=200) 找 stuck > 30min 的 pass
	//   - 拍板依据：Q19 = a 修订版（reconcile worker 30min 阈值）
	ListByStatus(status string, limit int) ([]*Entity, error)

	// === trade-pass-destroy 设计稿落地（§4.3 销毁主链 pass→history_pass 同事务迁移）===
	// 设计稿：.tmp/trade-pass-destroy-design.md §4.3 / §11-A Q6 / Q24
	//
	// MoveToHistory：单事务内完成 pass 表 DELETE + history_pass 表 INSERT，幂等。
	// 实现位于 history_dao.go（与 history_pass 表强耦合的逻辑就近放置）。
	//
	// 用户 2026-05-25 拍板新增联动清理：同事务内还会删除 user_resource_quota 表中
	// (user_id, resource_name='OPENCLAW_INSTANCE', resource_key='') 的行，一次性修复
	// 历史 quota 残留 + 异步销毁子 task 漏归还 quota 两个 bug（详见 history_dao.go 内注释）。
	//
	// 返回语义：
	//   - (alreadyMigrated=true,  nil)        重投场景：pass 已不在表中，history_pass 已有同 pass_id（幂等成功）
	//   - (alreadyMigrated=false, nil)        本次新迁移成功（INSERT history_pass + DELETE pass + DELETE quota 全提交）
	//   - (_, ErrPassNotFound)                pass 表与 history_pass 表均无对应记录（异常，需人工介入）
	//   - (_, err)                            其它 DB 异常，事务已回滚，caller 让父 task 重投
	//
	// 调用方：destroy 父 task 收尾步 5b（设计稿 §4.5.1 / §4.6.5）
	MoveToHistory(ctx context.Context, passID string, deletedTime time.Time, destroyReason string) (alreadyMigrated bool, err error)
}

type dao struct {
	*model.BaseDao
}

// NewDao 创建 Pass DAO
func NewDao() Dao {
	return &dao{
		BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnPassID),
	}
}

func (d *dao) GetByPassID(passID string) (*Entity, error) {
	var entity Entity
	if err := d.SelectByKeyColumn(passID, &entity); err != nil {
		return nil, err
	}
	return &entity, nil
}

func (d *dao) ListByUserID(userID string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnUserID, userID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByBundleID(bundleID string) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnBundleID, bundleID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByAppID(appID int64) ([]*Entity, error) {
	var entities []*Entity
	if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnAppID, appID)); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByFilters(userID *string, bundleID *string) ([]*Entity, error) {
	var entities []*Entity
	var scopes []func(*gorm.DB) *gorm.DB
	if userID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnUserID, *userID))
	}
	if bundleID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnBundleID, *bundleID))
	}
	if err := d.SimpleQueryAnd(&entities, scopes...); err != nil {
		return nil, err
	}
	return entities, nil
}

func (d *dao) ListByFiltersPage(userID *string, bundleID *string, status *string, limit, offset int) ([]*Entity, int64, error) {
	var scopes []func(*gorm.DB) *gorm.DB
	if userID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnUserID, *userID))
	}
	if bundleID != nil {
		scopes = append(scopes, model.WhereEqual(ColumnBundleID, *bundleID))
	}
	if status != nil {
		scopes = append(scopes, model.WhereEqual(ColumnStatus, *status))
	}

	var total int64
	if err := d.DB().Model(&Entity{}).Scopes(scopes...).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("ListByFiltersPage count: %w", err)
	}

	var entities []*Entity
	if err := d.DB().
		Scopes(scopes...).
		Order(model.ColumnCreatedTime + " DESC, " + ColumnPassID + " ASC").
		Limit(limit).Offset(offset).
		Find(&entities).Error; err != nil {
		return nil, 0, fmt.Errorf("ListByFiltersPage list: %w", err)
	}
	return entities, total, nil
}

func (d *dao) Create(entity *Entity) error {
	return d.Insert(entity)
}

func (d *dao) UpdateByPassID(passID string, updates map[string]interface{}) error {
	return d.UpdateByKeyColumn(updates, passID)
}

// CreatePassWithQuota 在同一事务中：
// 1. 插入 pass 记录
// 2. 更新 user_resource_quota（替换语义 + 并发安全）：
//   - 先 INSERT IGNORE 确保配额记录存在（首次购买时创建）
//   - 再 UPDATE 带 WHERE available + (agentQuota - total) >= 0 条件
//     total = agentQuota, available = available + (agentQuota - total)
//   - WHERE 条件保证并发场景下 available 不会变为负数
func (d *dao) CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error {
	return d.Transaction(func(tx *gorm.DB) error {
		// 1. 插入 pass
		if err := tx.Create(entity).Error; err != nil {
			return fmt.Errorf("insert pass: %w", err)
		}

		// 2a. 确保配额记录存在（INSERT IGNORE）
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: quota.ColumnUserID},
				{Name: quota.ColumnResourceName},
				{Name: quota.ColumnResourceKey},
			},
			DoNothing: true,
		}).Create(&quota.Entity{
			UserID:                 userID,
			ResourceName:           "OPENCLAW_INSTANCE",
			ResourceKey:            "",
			ResourceQuotaAvailable: 0,
			ResourceQuotaTotal:     0,
		}).Error; err != nil {
			return fmt.Errorf("ensure quota record: %w", err)
		}

		// 2b. 原子更新配额（带 WHERE 条件保证 available >= 0）
		result := tx.Model(&quota.Entity{}).
			Where(
				quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ? AND "+
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+") >= 0",
				userID, "OPENCLAW_INSTANCE", "", agentQuota,
			).
			Updates(map[string]interface{}{
				quota.ColumnResourceQuotaAvailable: gorm.Expr(
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+")",
					agentQuota,
				),
				quota.ColumnResourceQuotaTotal: agentQuota,
			})
		if result.Error != nil {
			return fmt.Errorf("update quota: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("quota update rejected: consumed exceeds new agent_quota")
		}

		return nil
	})
}

// === jifei 反查接口三件套实现（billing-integration B11A 新增）===
// 设计稿：.tmp/trade-resource-query-design.md §4.1
//
// 实现要点：
//   - 不引入 `deleted_time` 字段读写（Q9 拍板：物理 DELETE）
//   - bundleIDs 为空时省略 IN 子句（Q2 拍板：subProductCode 选填）
//   - 命中索引：`uk_pass_id` / `idx_app_id` / `idx_bundle_id`
//   - 排序：getAllAppIds 用 `app_id ASC` 稳定分页；getUserResources 用 `expired_time ASC, pass_id ASC` 与 lightpower 一致

// ListDistinctAppIDsByBundleIDs 详见 Dao 接口注释
func (d *dao) ListDistinctAppIDsByBundleIDs(bundleIDs []string, limit, offset int) ([]int64, int64, error) {
	// 分页查询 DISTINCT app_id
	listQuery := d.DB().Distinct(ColumnAppID).Where(fmt.Sprintf("%s > ?", ColumnAppID), 0)
	countQuery := d.DB().Where(fmt.Sprintf("%s > ?", ColumnAppID), 0) // count 查 DISTINCT 数量，单独构造（避免 DISTINCT 影响 listQuery 状态）

	if len(bundleIDs) > 0 {
		listQuery = listQuery.Where(fmt.Sprintf("%s IN ?", ColumnBundleID), bundleIDs)
		countQuery = countQuery.Where(fmt.Sprintf("%s IN ?", ColumnBundleID), bundleIDs)
	}

	var appIDs []int64
	if err := listQuery.
		Order(ColumnAppID+" ASC").
		Limit(limit).Offset(offset).
		Pluck(ColumnAppID, &appIDs).Error; err != nil {
		return nil, 0, fmt.Errorf("ListDistinctAppIDsByBundleIDs list: %w", err)
	}

	var total int64
	if err := countQuery.Distinct(ColumnAppID).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("ListDistinctAppIDsByBundleIDs count: %w", err)
	}
	return appIDs, total, nil
}

// ListByAppIDAndBundleIDs 详见 Dao 接口注释
func (d *dao) ListByAppIDAndBundleIDs(appID int64, bundleIDs []string, limit, offset int) ([]*Entity, int64, error) {
	listQuery := d.DB().Where(fmt.Sprintf("%s = ?", ColumnAppID), appID)
	countQuery := d.DB().Where(fmt.Sprintf("%s = ?", ColumnAppID), appID)

	if len(bundleIDs) > 0 {
		listQuery = listQuery.Where(fmt.Sprintf("%s IN ?", ColumnBundleID), bundleIDs)
		countQuery = countQuery.Where(fmt.Sprintf("%s IN ?", ColumnBundleID), bundleIDs)
	}

	var entities []*Entity
	if err := listQuery.
		Order(ColumnExpiredTime + " ASC, " + ColumnPassID + " ASC").
		Limit(limit).Offset(offset).
		Find(&entities).Error; err != nil {
		return nil, 0, fmt.Errorf("ListByAppIDAndBundleIDs list: %w", err)
	}

	var total int64
	if err := countQuery.Model(&Entity{}).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("ListByAppIDAndBundleIDs count: %w", err)
	}
	return entities, total, nil
}

// ListByAppIDAndPassIDs 详见 Dao 接口注释
func (d *dao) ListByAppIDAndPassIDs(appID int64, passIDs []string) ([]*Entity, error) {
	if len(passIDs) == 0 {
		// 防御：caller 已保证非空，此处兜底返空数组
		return []*Entity{}, nil
	}
	var entities []*Entity
	if err := d.DB().
		Where(fmt.Sprintf("%s = ?", ColumnAppID), appID).
		Where(fmt.Sprintf("%s IN ?", ColumnPassID), passIDs).
		Find(&entities).Error; err != nil {
		return nil, fmt.Errorf("ListByAppIDAndPassIDs: %w", err)
	}
	return entities, nil
}

// === trade-pass-isolate 设计稿落地（pass.status CAS）===
// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q8 / Q23 / Q22-I-E
//
// 实现说明：
//   - 参考 instance/dao.go::UpdateWithStatusPrecondition (L150-183) 的 CAS 范式
//   - 但 pass 表的状态切换不携带 ctx-userID 维度（IsolatePass 由系统侧/admin 触发，不是 user 主动）
//     故 WHERE 条件只带 pass_id + status 两个维度
//   - 用 RowsAffected 判断是否真的命中：=1 表示拿锁成功；=0 表示状态不匹配（被并发拿走 / pass 不存在）
//   - 不做"区分 NotFound vs StatusMismatch"的语义返回（caller 上下文已足够判断）

// TryAcquireSlotForIsolate 详见 Dao 接口注释
func (d *dao) TryAcquireSlotForIsolate(passID string) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusActive).
		Update(ColumnStatus, StatusIsolating)
	if result.Error != nil {
		return false, fmt.Errorf("TryAcquireSlotForIsolate: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// TryAcquireSlotForDelete 详见 Dao 接口注释（trade-pass-destroy §4.1 / §4.5.1 / §11-A Q1 / Q2）
//
// 实现：CAS WHERE pass_id=? AND status='isolated' UPDATE status='deleting'
//
//	（与 TryAcquireSlotForIsolate 同范式，仅 from/to 状态值不同）
func (d *dao) TryAcquireSlotForDelete(passID string) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusIsolated).
		Update(ColumnStatus, StatusDeleting)
	if result.Error != nil {
		return false, fmt.Errorf("TryAcquireSlotForDelete: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// TryAcquireSlotForTerminate 详见 Dao 接口注释（trade-pass-destroy §3.5 / §4.5.2 / §4.5.3 / §11-A Q1）
//
// 实现：CAS WHERE pass_id=? AND status IN ('deleting','isolated') UPDATE status='terminating'
//
//	双源 from：兼容入口 A（deleting）+ 入口 B（isolated）；
//	单条 SQL 原子操作，无需 SELECT FOR UPDATE。
func (d *dao) TryAcquireSlotForTerminate(passID string) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s IN ?", ColumnPassID, ColumnStatus),
			passID, []string{StatusDeleting, StatusIsolated}).
		Update(ColumnStatus, StatusTerminating)
	if result.Error != nil {
		return false, fmt.Errorf("TryAcquireSlotForTerminate: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// UpdateStatus 详见 Dao 接口注释
func (d *dao) UpdateStatus(passID, expectedStatus, newStatus string) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, expectedStatus).
		Update(ColumnStatus, newStatus)
	if result.Error != nil {
		return false, fmt.Errorf("UpdateStatus: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// UpdateExpiredTimeIfActive 详见 Dao 接口注释
//
// 实现：CAS WHERE pass_id=? AND status='active' UPDATE expired_time=?
//
//	（status 字段不动；与 isolate 链路 UpdateStatus 切换 status 的语义对偶分离）
func (d *dao) UpdateExpiredTimeIfActive(passID string, newExpiredTime time.Time) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusActive).
		Update(ColumnExpiredTime, newExpiredTime)
	if result.Error != nil {
		return false, fmt.Errorf("UpdateExpiredTimeIfActive: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// FinalizeRenewal 详见 Dao 接口注释（trade-pass-renew §3.4 / §12 Q2=a / R-D-3）
//
// 实现：CAS WHERE pass_id=? AND status='renewing' UPDATE
//
//	  status         = 'active'
//	  expired_time   = newExpiredTime
//	  isolated_time  = NULL
//
//	（一次性原子写入三列；renewing 状态期间任何中间态对外不可见）
func (d *dao) FinalizeRenewal(passID string, newExpiredTime time.Time) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusRenewing).
		Updates(map[string]interface{}{
			ColumnStatus:       StatusActive,
			ColumnExpiredTime:  newExpiredTime,
			ColumnIsolatedTime: gorm.Expr("NULL"),
		})
	if result.Error != nil {
		return false, fmt.Errorf("FinalizeRenewal: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// RollbackRenewal 详见 Dao 接口注释（R-MR-5 续费失败回滚收尾，2026-05-24 用户拍板）
//
// 实现：CAS WHERE pass_id=? AND status='renewing' UPDATE
//
//	status        = targetStatus
//	expired_time  = originalExpiredTime
//	isolated_time = *originalIsolatedTime（nil 时写 NULL）
//
// 与 FinalizeRenewal 对偶反向：FinalizeRenewal 把 renewing 推到 active + 新 expired + NULL；
// RollbackRenewal 把 renewing 回滚到原态（active 或 isolated）+ 旧 expired + 旧 isolated。
func (d *dao) RollbackRenewal(passID, targetStatus string, originalExpiredTime time.Time, originalIsolatedTime *time.Time) (bool, error) {
	updates := map[string]interface{}{
		ColumnStatus:      targetStatus,
		ColumnExpiredTime: originalExpiredTime,
	}
	if originalIsolatedTime != nil {
		updates[ColumnIsolatedTime] = *originalIsolatedTime
	} else {
		updates[ColumnIsolatedTime] = gorm.Expr("NULL")
	}

	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusRenewing).
		Updates(updates)
	if result.Error != nil {
		return false, fmt.Errorf("RollbackRenewal: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// MarkIsolated 详见 Dao 接口注释（trade-pass-isolate §11-Q22 钦点）。
//
// 实现：CAS WHERE pass_id=? AND status='isolating' UPDATE
//
//	  status         = 'isolated'
//	  isolated_time  = isolatedTime
//
//	（原子写 status + isolated_time 两列；用于生命周期隔离链路）
func (d *dao) MarkIsolated(passID string, isolatedTime time.Time) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusIsolating).
		Updates(map[string]interface{}{
			ColumnStatus:       StatusIsolated,
			ColumnIsolatedTime: isolatedTime,
		})
	if result.Error != nil {
		return false, fmt.Errorf("MarkIsolated: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// MarkIsolatedWithExpiredTime 详见 Dao 接口注释（v1.7.30 BUG-35 退费隔离）。
//
// 实现：CAS WHERE pass_id=? AND status='isolating' UPDATE
//
//	  status         = 'isolated'
//	  expired_time   = newExpiredTime
//	  isolated_time  = isolatedTime
//
//	（一次事务原子写 3 列；退费链路兼顾「延长到期时间」与「隔离完成时刻」语义）
func (d *dao) MarkIsolatedWithExpiredTime(passID string, newExpiredTime, isolatedTime time.Time) (bool, error) {
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnPassID, ColumnStatus), passID, StatusIsolating).
		Updates(map[string]interface{}{
			ColumnStatus:       StatusIsolated,
			ColumnExpiredTime:  newExpiredTime,
			ColumnIsolatedTime: isolatedTime,
		})
	if result.Error != nil {
		return false, fmt.Errorf("MarkIsolatedWithExpiredTime: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// ListByStatus 详见 Dao 接口注释
func (d *dao) ListByStatus(status string, limit int) ([]*Entity, error) {
	var entities []*Entity
	q := d.DB().Where(fmt.Sprintf("%s = ?", ColumnStatus), status)
	if limit > 0 {
		q = q.Limit(limit)
	}
	if err := q.Order(ColumnPassID + " ASC").Find(&entities).Error; err != nil {
		return nil, fmt.Errorf("ListByStatus: %w", err)
	}
	return entities, nil
}
