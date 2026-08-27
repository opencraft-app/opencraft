package website

import (
	"strings"
	"testing"
	"time"

	"ctl/pkg/model/website"
)

// dead 是唯一可复活的状态：它表示重试已耗尽、站点被永久卡住，需要人工介入。
func TestReviveAcceptsDeadOperation(t *testing.T) {
	for _, operationType := range []string{website.OpTypeDelete, website.OpTypeSuspend, website.OpTypeResume} {
		if err := canReviveOperation(website.OpStatusDead, operationType, 3, 3); err != nil {
			t.Fatalf("dead %s operation must be revivable, got %v", operationType, err)
		}
	}
}

// 非 dead 状态一律拒绝。success 尤其危险：delete 的 success 已经归还过配额席位，
// 重放一遍会再归还一次，直接造成席位超卖。
func TestReviveRejectsNonDeadStatuses(t *testing.T) {
	for _, status := range []string{
		website.OpStatusCreated,
		website.OpStatusRunning,
		website.OpStatusSuccess,
		website.OpStatusFailed,
	} {
		err := canReviveOperation(status, website.OpTypeDelete, 3, 3)
		if err == nil {
			t.Fatalf("status %s must not be revivable", status)
		}
		if !strings.Contains(err.Error(), status) {
			t.Fatalf("error for status %s should name the offending status, got %v", status, err)
		}
	}
}

// 不可重试的操作类型不该进入复活路径：create/deploy 由用户发起，
// 制品上传窗口有时效，替用户重放没有意义。
func TestReviveRejectsNonRetryableOperationTypes(t *testing.T) {
	for _, operationType := range []string{website.OpTypeCreate, website.OpTypeDeploy} {
		if err := canReviveOperation(website.OpStatusDead, operationType, 3, 3); err == nil {
			t.Fatalf("%s operation must not be revivable", operationType)
		}
	}
}

// generation 围栏：一期专门修过「迟到的 worker 恢复已删除站点」。
// 站点后来又发起过新操作时，旧的 dead 操作已成历史，复活它会让陈旧回调改站点状态。
func TestReviveRejectsStaleGeneration(t *testing.T) {
	stale := []struct {
		name                string
		operationGeneration int64
		siteGeneration      int64
	}{
		{name: "operation older than site", operationGeneration: 2, siteGeneration: 5},
		{name: "operation ahead of site", operationGeneration: 6, siteGeneration: 5},
	}
	for _, tt := range stale {
		t.Run(tt.name, func(t *testing.T) {
			err := canReviveOperation(website.OpStatusDead, website.OpTypeDelete, tt.operationGeneration, tt.siteGeneration)
			if err == nil {
				t.Fatalf("generation %d against site %d must be rejected", tt.operationGeneration, tt.siteGeneration)
			}
			if !strings.Contains(err.Error(), "stale") {
				t.Fatalf("error should explain the fence, got %v", err)
			}
		})
	}
}

// 复活写回的字段必须让 worker 立刻能领取，否则站点仍然卡住。
// 这里断言的是 ReviveOperation 写入的那组值（status=created、租约清空、无退避）
// 满足 ClaimOperation 的可领取判定。
func TestRevivedOperationIsImmediatelyClaimable(t *testing.T) {
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)
	if !isOperationClaimable(website.OpStatusCreated, nil, now) {
		t.Fatal("revived operation must be claimable right away")
	}
	// 对照：dead 状态本身不可领取，这正是复活前站点卡住的原因。
	if isOperationClaimable(website.OpStatusDead, nil, now) {
		t.Fatal("dead operation must not be claimable")
	}
}
