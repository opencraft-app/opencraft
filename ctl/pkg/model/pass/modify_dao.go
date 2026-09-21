package pass

import (
	"encoding/json"
	"fmt"

	taskmodel "ctl/pkg/model/task"
	quota "ctl/pkg/model/userresourcequota"
	taskcommon "ctl/pkg/taskruntime/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 同 SP 变配的两个 CAS 原语。详见 Dao 接口上对应方法的注释。

// modifyQuotaResourceName 与 CreatePassWithQuota 保持一致：变配替换的是同一行配额。
const modifyQuotaResourceName = "OPENCLAW_INSTANCE"

// TryAcquireSlotForModify 详见 Dao 接口注释。
func (d *dao) TryAcquireSlotForModify(passID string, flowID int64, sourceBundleID, targetBundleID string) (bool, error) {
	if passID == "" || flowID <= 0 || sourceBundleID == "" || targetBundleID == "" || sourceBundleID == targetBundleID {
		return false, fmt.Errorf("TryAcquireSlotForModify: passID, flowID and distinct source/target bundle IDs are required")
	}
	result := d.DB().
		Model(&Entity{}).
		Where(fmt.Sprintf("%s = ? AND %s = ? AND %s = ?", ColumnPassID, ColumnStatus, ColumnBundleID), passID, StatusActive, sourceBundleID).
		Updates(map[string]interface{}{
			ColumnStatus:               StatusModifying,
			ColumnModifyFlowID:         flowID,
			ColumnModifyTargetBundleID: targetBundleID,
		})
	if result.Error != nil {
		return false, fmt.Errorf("TryAcquireSlotForModify: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// FinalizeModify 详见 Dao 接口注释。
func (d *dao) FinalizeModify(passID string, flowID int64, targetBundleID, userID string, agentQuota int64, taskID string) (bool, error) {
	if passID == "" || flowID <= 0 || targetBundleID == "" || userID == "" || taskID == "" {
		return false, fmt.Errorf("FinalizeModify: passID, flowID, targetBundleID, userID and taskID are required")
	}

	finalized := false
	err := d.Transaction(func(tx *gorm.DB) error {
		var task taskmodel.Entity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("task_id = ?", taskID).First(&task).Error; err != nil {
			return fmt.Errorf("read modify receipt: %w", err)
		}
		var receipt taskcommon.ModifyPassTaskPayload
		if err := json.Unmarshal([]byte(task.TaskParams), &receipt); err != nil {
			return fmt.Errorf("decode modify receipt: %w", err)
		}
		if task.TaskName != taskcommon.TaskNameModifyPass || task.UserID != userID ||
			receipt.PassID != passID || receipt.UserID != userID || receipt.TradeFlowID != flowID ||
			receipt.TargetBundleID != targetBundleID || receipt.SourceBundleID == "" || !receipt.SubscriptionDone {
			return fmt.Errorf("modify receipt identity or subscription progress mismatch")
		}
		if receipt.EntitlementsFinalized {
			return nil
		}
		passResult := tx.Model(&Entity{}).
			Where("pass_id = ? AND status = ? AND modify_flow_id = ? AND modify_target_bundle_id = ? AND user_id = ? AND bundle_id = ?",
				passID, StatusModifying, flowID, targetBundleID, userID, receipt.SourceBundleID).
			Updates(map[string]interface{}{
				ColumnStatus:               StatusActive,
				ColumnBundleID:             targetBundleID,
				ColumnModifyFlowID:         0,
				ColumnModifyTargetBundleID: "",
			})
		if passResult.Error != nil {
			return fmt.Errorf("update pass: %w", passResult.Error)
		}
		if passResult.RowsAffected != 1 {
			// 已被并发收尾或 flow 不匹配：不改配额，让调用方按幂等处理。
			return nil
		}

		// 替换语义：total 换成目标套餐配额，available 同步平移，已占用数量继续计入。
		// WHERE 里的 available + (new_total - old_total) >= 0 保证不会把已占用挤成负数。
		quotaResult := tx.Model(&quota.Entity{}).
			Where(
				quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ? AND "+
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+") >= 0",
				userID, modifyQuotaResourceName, "", agentQuota,
			).
			Updates(map[string]interface{}{
				quota.ColumnResourceQuotaAvailable: gorm.Expr(
					quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+")",
					agentQuota,
				),
				quota.ColumnResourceQuotaTotal: agentQuota,
			})
		if quotaResult.Error != nil {
			return fmt.Errorf("update quota: %w", quotaResult.Error)
		}
		if quotaResult.RowsAffected == 0 {
			// 升配只会放大配额，正常不会被 available >= 0 拒绝；真被拒说明已占用数据异常，
			// 回滚整个事务，不留下「套餐已升但配额没跟上」的中间态。
			return fmt.Errorf("quota update rejected for user %s: consumed exceeds target agent_quota %d", userID, agentQuota)
		}

		// Preserve unknown payload fields for rolling-version compatibility.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(task.TaskParams), &fields); err != nil {
			return err
		}
		fields["entitlements_finalized"] = json.RawMessage("true")
		body, err := json.Marshal(fields)
		if err != nil {
			return err
		}
		result := tx.Model(&taskmodel.Entity{}).Where("task_id = ?", taskID).Update("task_params", string(body))
		if result.Error != nil {
			return fmt.Errorf("write modify receipt: %w", result.Error)
		}
		if result.RowsAffected != 1 {
			return fmt.Errorf("write modify receipt affected %d rows", result.RowsAffected)
		}
		finalized = true
		return nil
	})
	if err != nil {
		return false, fmt.Errorf("FinalizeModify: %w", err)
	}
	return finalized, nil
}
