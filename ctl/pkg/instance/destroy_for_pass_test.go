package instance

import (
	"errors"
	"testing"
)

// === trade-pass-destroy 子 task helper 函数单测（设计稿 §4.7 / §11-A Q7 / Q10 / Q25）===
//
// 业务路径（4 阶段流程：CreateSnapshot / 轮询 / 入表 / DeleteSandbox + CAS）依赖 sandbox + DB +
// task 框架，留 sandbox-bj-7 联调集成测试覆盖。本单测只覆盖纯函数边界（与老 isolate / renew 同范式）。

// TestSnapshotRetentionSeconds_DefaultsTo90Days 验证 Q7 ✅ 拍板：
// 没有 ctl 配置（config.ServerConf == nil）/ 配置值 <=0 时，回退 90 天默认值（3 个月）。
func TestSnapshotRetentionSeconds_DefaultsTo90Days(t *testing.T) {
	// 默认值不依赖 config.ServerConf 是否初始化（nil-safe 兜底）
	got := snapshotRetentionSeconds()
	want := int64(90) * 24 * 3600
	if got != want {
		t.Errorf("snapshotRetentionSeconds default = %d, want %d (90 days)", got, want)
	}
}

// TestIsSnapshotSentinel_MatchesNoDiskAndNoSandbox 验证哨兵值识别：
// "<no-disk>" / "<no-sandbox>" 视为内部跳过 sandbox.GetSnapshotStatus 的标志，
// 其它字符串（包括空串）都返 false（让阶段 2 正常调 sandbox.GetSnapshotStatus 轮询）。
func TestIsSnapshotSentinel_MatchesNoDiskAndNoSandbox(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"no_disk", "<no-disk>", true},
		{"no_sandbox", "<no-sandbox>", true},
		{"real_snapshot_id", "snap-abcd1234", false},
		{"empty", "", false},
		{"angled_garbage", "<other>", false},
		{"close_match_no_angle", "no-disk", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isSnapshotSentinel(tc.in)
			if got != tc.want {
				t.Errorf("isSnapshotSentinel(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestIsInstanceNoSystemDiskError_MatchesByMessageString 验证 Q10/Q25 联动：
// sandbox handler 返 "INSTANCE_NO_SYSTEM_DISK" 业务码时，ctl 子 task 跳过快照阶段。
//
// 不强类型断言（避免循环引入 sandbox 错误类型），按 error.Error() 字符串包含匹配。
func TestIsInstanceNoSystemDiskError_MatchesByMessageString(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"exact_business_code", errors.New("INSTANCE_NO_SYSTEM_DISK"), true},
		{"wrapped_in_envelope", errors.New("sandbox.CreateSnapshot: 422 INSTANCE_NO_SYSTEM_DISK: instance has no system disk"), true},
		{"unrelated_error", errors.New("dial tcp: connection refused"), false},
		{"sandbox_5xx", errors.New("sandbox.CreateSnapshot: 502 Bad Gateway"), false},
		{"close_match_no_full_string", errors.New("INSTANCE_NO_DISK"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isInstanceNoSystemDiskError(tc.err)
			if got != tc.want {
				t.Errorf("isInstanceNoSystemDiskError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestSnapshotPollWaitErr_NotNil 防御：snapshotPollWaitErr 必须是 non-nil error
// （子 task execute 阶段 1+2 用它触发框架重投，nil 会导致父 task 误判为成功）。
func TestSnapshotPollWaitErr_NotNil(t *testing.T) {
	if snapshotPollWaitErr == nil {
		t.Fatal("snapshotPollWaitErr must be non-nil (used to signal retry)")
	}
	if snapshotPollWaitErr.Error() == "" {
		t.Fatal("snapshotPollWaitErr.Error() must not be empty (used in task message)")
	}
}
