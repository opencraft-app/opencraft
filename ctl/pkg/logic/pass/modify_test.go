package pass

import (
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	bundlemodel "ctl/pkg/model/bundle"
	modelinstance "ctl/pkg/model/instance"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/transport"
	"ctl/test/testutil"
)

// 同 SP 变配的策略与入口校验单测。需求：TAPD 1010132091137784162 §7.2 / §8.1
//
// 覆盖允许关系表、状态码映射、入口参数校验、重试预算，以及只依赖 instance 表的
// 实例准入闸口（走内存 SQLite）。同时依赖 pass/bundle/instance 三张表的
// resolveModifyTarget 由 main/api 的集成测试覆盖。

func TestModifyAllowedOnlyUpgradesWithinSameSP(t *testing.T) {
	cases := []struct {
		name   string
		source string
		target string
		want   bool
	}{
		{"launch to cruise", "bundle_launch_01", "bundle_cruise_01", true},
		{"launch ai to cruise ai", "bundle_launch_ai_01", "bundle_cruise_ai_01", true},

		// 降配：本期不做，计费侧也没有对应的退差价链路。
		{"cruise to launch", "bundle_cruise_01", "bundle_launch_01", false},
		{"cruise ai to launch ai", "bundle_cruise_ai_01", "bundle_launch_ai_01", false},

		// 跨 SP：通用与 AI 分属两个 SP，jifei 侧变配要求同 SP，两边都不能互切。
		{"launch to cruise ai", "bundle_launch_01", "bundle_cruise_ai_01", false},
		{"launch ai to cruise", "bundle_launch_ai_01", "bundle_cruise_01", false},

		// 空变配：source == target 会让计费算出 0 元差价，没有业务含义。
		{"launch to launch", "bundle_launch_01", "bundle_launch_01", false},
		{"cruise to cruise", "bundle_cruise_01", "bundle_cruise_01", false},

		{"unknown source", "bundle_unknown", "bundle_cruise_01", false},
		{"unknown target", "bundle_launch_01", "bundle_unknown", false},
		{"empty", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ModifyAllowed(tc.source, tc.target); got != tc.want {
				t.Fatalf("ModifyAllowed(%q, %q) = %v, want %v", tc.source, tc.target, got, tc.want)
			}
		})
	}
}

func TestAllowedModifyTargetsReturnsDefensiveCopy(t *testing.T) {
	targets := AllowedModifyTargets("bundle_launch_01")
	if len(targets) != 1 || targets[0] != "bundle_cruise_01" {
		t.Fatalf("AllowedModifyTargets = %v, want [bundle_cruise_01]", targets)
	}
	// 改返回值不能污染策略表，否则一次错误调用会永久改变线上允许关系。
	targets[0] = "bundle_tampered"
	if again := AllowedModifyTargets("bundle_launch_01"); again[0] != "bundle_cruise_01" {
		t.Fatalf("policy table mutated through returned slice: %v", again)
	}

	if got := AllowedModifyTargets("bundle_cruise_01"); got != nil {
		t.Fatalf("AllowedModifyTargets for terminal bundle = %v, want nil", got)
	}
}

// assertInstancesModifiable 是升配的实例准入闸口（§10.1）。
//
// 升配要停机改规格，插进任何在跑的操作里会互相打断，所以规则是"非终态实例必须全是
// Running，否则整体拒绝"——不是跳过不合格的那几台。跳过的后果是用户升了套餐却留下
// 一台 2C4G 的机器。
func TestAssertInstancesModifiableRequiresEveryLiveInstanceRunning(t *testing.T) {
	cases := []struct {
		name      string
		instances []modelinstance.Entity
		wantErr   bool
	}{
		{
			// 买了套餐还没开机，只升套餐级权益。
			name: "零实例放行",
		},
		{
			name: "全部 Running 放行",
			instances: []modelinstance.Entity{
				{InstanceId: "ins-1", Status: modelinstance.InstanceStatusRunning},
				{InstanceId: "ins-2", Status: modelinstance.InstanceStatusRunning},
			},
		},
		{
			// Paused 说明 pass 已被隔离，此时升配会和隔离/恢复链路打架。
			name: "任一 Paused 整体拒绝",
			instances: []modelinstance.Entity{
				{InstanceId: "ins-1", Status: modelinstance.InstanceStatusRunning},
				{InstanceId: "ins-2", Status: modelinstance.InstanceStatusPaused},
			},
			wantErr: true,
		},
		{
			name: "任一非 Running 中间态整体拒绝",
			instances: []modelinstance.Entity{
				{InstanceId: "ins-1", Status: modelinstance.InstanceStatusRunning},
				{InstanceId: "ins-2", Status: modelinstance.InstanceStatusCreating},
			},
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := testutil.NewSQLiteDB(t, &modelinstance.Entity{})
			userID := "user-" + tc.name
			for i := range tc.instances {
				inst := tc.instances[i]
				inst.UserId = userID
				if err := db.Create(&inst).Error; err != nil {
					t.Fatalf("seed instance: %v", err)
				}
			}

			err := assertInstancesModifiable(userID)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected rejection, got nil")
				}
				if !errors.Is(err, errcode.ErrPassModifyInstanceNotReady) {
					t.Errorf("err = %v, want ErrPassModifyInstanceNotReady", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("expected pass-through, got %v", err)
			}
		})
	}
}

// TestCheckPassModifyRejectsStateDriftAfterInquiry 覆盖 §6 / §10.1 的"询价后状态漂移"。
//
// checkModify 和 modifyResource 中间隔着用户支付的时间窗，这段时间里 pass 可能被
// 续费、隔离，或被另一笔变配抢先改了套餐。两个入口共用同一套校验就是为了保证
// "询价时说能升，发货时还得再确认一次"，否则会出现已扣款但发货基线不对的账不平。
func TestCheckPassModifyRejectsStateDriftAfterInquiry(t *testing.T) {
	const (
		sourceBundle = "bundle_launch_01"
		targetBundle = "bundle_cruise_01"
	)
	baseline := time.Now().UTC().Add(30 * 24 * time.Hour).Truncate(time.Second)

	cases := []struct {
		name        string
		passStatus  string
		passBundle  string
		passExpires time.Time
		curDeadline *time.Time
		reqUin      int64
		reqAppID    int64
		wantErr     error
	}{
		{
			name:        "无漂移放行",
			passStatus:  passmodel.StatusActive,
			passBundle:  sourceBundle,
			passExpires: baseline,
			curDeadline: &baseline,
		},
		{
			// 计费传的 uin 是资源 owner 的腾讯云身份。对不上意味着 resourceId 被
			// 错投到别人的资源上，继续发货就是拿 A 的钱升 B 的套餐。
			name:        "uin 归属不匹配",
			passStatus:  passmodel.StatusActive,
			passBundle:  sourceBundle,
			passExpires: baseline,
			curDeadline: &baseline,
			reqUin:      999888777,
			wantErr:     errcode.ErrPassModifyConfigMismatch,
		},
		{
			name:        "appId 归属不匹配",
			passStatus:  passmodel.StatusActive,
			passBundle:  sourceBundle,
			passExpires: baseline,
			curDeadline: &baseline,
			reqAppID:    424242,
			wantErr:     errcode.ErrPassModifyConfigMismatch,
		},
		{
			// 支付窗口里 pass 被隔离：不能继续发货。
			name:        "pass 已被隔离",
			passStatus:  passmodel.StatusIsolated,
			passBundle:  sourceBundle,
			passExpires: baseline,
			curDeadline: &baseline,
			wantErr:     errcode.ErrPassNotModifiable,
		},
		{
			// 另一笔变配抢先完成，pass 已经是目标套餐：再发一次会升到错误档位。
			name:        "source 套餐已漂移",
			passStatus:  passmodel.StatusActive,
			passBundle:  targetBundle,
			passExpires: baseline,
			curDeadline: &baseline,
			wantErr:     errcode.ErrPassModifyConfigMismatch,
		},
		{
			// 用户在支付窗口里又续了费：差价算的不是当前时长，必须让计费重新询价。
			name:        "curDeadline 已漂移",
			passStatus:  passmodel.StatusActive,
			passBundle:  sourceBundle,
			passExpires: baseline.Add(30 * 24 * time.Hour),
			curDeadline: &baseline,
			wantErr:     errcode.ErrPassModifyConfigMismatch,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := testutil.NewSQLiteDB(t,
				&passmodel.Entity{}, &bundlemodel.Entity{}, &modelinstance.Entity{})
			if err := db.Create(&passmodel.Entity{
				PassID: "p-drift", UserID: "user-drift", BundleID: tc.passBundle,
				Uin: 1234567890, AppID: 1, ExpiredTime: tc.passExpires,
				RenewFlag: passmodel.RenewFlagManual, Status: tc.passStatus,
			}).Error; err != nil {
				t.Fatalf("seed pass: %v", err)
			}
			if err := db.Create(&bundlemodel.Entity{
				BundleID: targetBundle, BundleState: "ONLINE", InstanceSpecID: "spec-4c8g80g",
			}).Error; err != nil {
				t.Fatalf("seed bundle: %v", err)
			}

			// 默认与 pass 行一致；只有归属用例刻意传错。
			reqUin, reqAppID := int64(1234567890), int64(1)
			if tc.reqUin != 0 {
				reqUin = tc.reqUin
			}
			if tc.reqAppID != 0 {
				reqAppID = tc.reqAppID
			}

			err := NewLogic().CheckPassModify("p-drift", &transport.CheckPassModifyRequest{
				SourceBundleID: sourceBundle,
				TargetBundleID: targetBundle,
				Uin:            reqUin,
				AppID:          reqAppID,
				CurDeadline:    tc.curDeadline,
			})
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("expected pass-through, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected rejection, got nil")
			}
			if !errors.Is(err, tc.wantErr) {
				t.Errorf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestClassifyModifyStatusError(t *testing.T) {
	// modifying 必须单独成码：受理入口靠它判断是否走"同一 flow 复用"分支，
	// 混进 NOT_MODIFIABLE 会让计费重投被直接拒绝进而触发退款。
	if err := classifyModifyStatusError(passmodel.StatusModifying); !errors.Is(err, errcode.ErrPassModifying) {
		t.Fatalf("modifying should map to ErrPassModifying, got %v", err)
	}

	for _, status := range []string{
		passmodel.StatusIsolating,
		passmodel.StatusIsolated,
		passmodel.StatusRenewing,
		passmodel.StatusDeleting,
		passmodel.StatusTerminating,
	} {
		err := classifyModifyStatusError(status)
		if !errors.Is(err, errcode.ErrPassNotModifiable) {
			t.Fatalf("status %s should map to ErrPassNotModifiable, got %v", status, err)
		}
		if errors.Is(err, errcode.ErrPassModifying) {
			t.Fatalf("status %s must not be mistaken for an in-flight modify", status)
		}
	}
}

func TestAcceptPassModifyRejectsMissingFlowID(t *testing.T) {
	l := &logic{}

	if _, err := l.AcceptPassModify("pass-1", nil); !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("nil request should be rejected with ErrPassInvalidParam, got %v", err)
	}

	// flow id 是区分"同一笔单重投"和"另一笔单插队"的唯一依据；
	// 缺了它幂等无从判断，必须在触碰 DB 之前拒掉。
	for _, flowID := range []int64{0, -1} {
		_, err := l.AcceptPassModify("pass-1", &transport.PassModifyRequest{
			CheckPassModifyRequest: transport.CheckPassModifyRequest{
				SourceBundleID: "bundle_launch_01",
				TargetBundleID: "bundle_cruise_01",
			},
			TradeFlowID: flowID,
		})
		if !errors.Is(err, errcode.ErrPassInvalidParam) {
			t.Fatalf("flow id %d should be rejected with ErrPassInvalidParam, got %v", flowID, err)
		}
	}
}

func TestCheckPassModifyRejectsNilRequest(t *testing.T) {
	l := &logic{}
	if err := l.CheckPassModify("pass-1", nil); !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("nil request should be rejected with ErrPassInvalidParam, got %v", err)
	}
}

func TestModifyPassParentRetryBudgetCoversChildWindow(t *testing.T) {
	// 子 task 窗口 60s × 60 = 1h（pkg/pass/worker/modify_task.go）。
	// 父 task 窗口必须严格覆盖它，否则父 task 会在子 task 还能自愈时先放弃。
	const modifyInstanceRetryWindowSeconds = int64(60 * 60)

	if modifyPassParentMaxExecuteCount != 1<<30 {
		t.Fatalf("modify parent max execute count = %d, want %d (never give up: disk resize is irreversible)",
			modifyPassParentMaxExecuteCount, 1<<30)
	}
	window := modifyPassParentExecuteIntervalSeconds * int64(modifyPassParentMaxExecuteCount)
	if window <= modifyInstanceRetryWindowSeconds {
		t.Fatalf("modify parent retry window = %ds, must exceed child window %ds",
			window, modifyInstanceRetryWindowSeconds)
	}
}
