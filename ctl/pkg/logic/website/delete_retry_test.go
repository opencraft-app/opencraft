package website

import (
	"strings"
	"testing"
	"time"

	"ctl/pkg/model/website"
)

func TestNextRetryAtUsesBoundedExponentialBackoff(t *testing.T) {
	now := time.Date(2026, time.August, 5, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		attempt int
		want    time.Duration
	}{
		{name: "first failure", attempt: 1, want: 30 * time.Second},
		{name: "second failure", attempt: 2, want: time.Minute},
		{name: "backoff is capped", attempt: 99, want: 15 * time.Minute},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := nextRetryAt(now, tt.attempt)
			if !got.Equal(now.Add(tt.want)) {
				t.Fatalf("nextRetryAt(%d) = %s, want %s", tt.attempt, got, now.Add(tt.want))
			}
		})
	}
}

// 清理/状态收敛类操作由系统触发，用户无法自助重试，因此必须可重试。
// create/deploy 由用户发起，失败后应由用户重新操作。
func TestOnlyCleanupOperationsAreRetryable(t *testing.T) {
	retryable := []string{
		website.OpTypeDelete,
		website.OpTypeSuspend,
		website.OpTypeResume,
	}
	for _, operationType := range retryable {
		if !shouldRetryFailedOperation(operationType) {
			t.Fatalf("%s operation should be retryable", operationType)
		}
	}

	for _, operationType := range []string{website.OpTypeCreate, website.OpTypeDeploy, "unknown"} {
		if shouldRetryFailedOperation(operationType) {
			t.Fatalf("%s operation must not be retried", operationType)
		}
	}
}

// error_message 列宽是 2048，不截断会在 MySQL strict mode 下触发 1406，
// 导致失败回调本身失败、操作卡在 running 直到租约过期，形成活锁。
func TestTruncateErrorMessageKeepsPayloadWithinColumnWidth(t *testing.T) {
	short := "upload failed: connection reset"
	if got := truncateErrorMessage(short); got != short {
		t.Fatalf("short message must be preserved, got %q", got)
	}

	long := strings.Repeat("x", maxErrorMessageLen*3)
	got := truncateErrorMessage(long)
	if len(got) >= len(long) {
		t.Fatalf("long message was not truncated: len=%d", len(got))
	}
	if !strings.HasSuffix(got, "...(truncated)") {
		t.Fatalf("truncated message must be marked, got suffix %q", got[len(got)-20:])
	}
	if len(got) > maxErrorMessageLen+len("...(truncated)") {
		t.Fatalf("truncated message too long: %d", len(got))
	}
}

// 截断必须落在 rune 边界上，否则会写入非法 utf8mb4 字节序列被 MySQL 拒绝。
func TestTruncateErrorMessageDoesNotSplitMultibyteRunes(t *testing.T) {
	got := truncateErrorMessage(strings.Repeat("中", maxErrorMessageLen))
	trimmed := strings.TrimSuffix(got, "...(truncated)")
	if !utf8ValidString(trimmed) {
		t.Fatalf("truncated message is not valid UTF-8: %q", trimmed)
	}
}

func utf8ValidString(s string) bool {
	for _, r := range s {
		if r == '\uFFFD' {
			return false
		}
	}
	return true
}
