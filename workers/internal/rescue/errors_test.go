package rescue

import (
	"errors"
	"testing"

	"go.temporal.io/sdk/temporal"
)

func TestTemporalActivityErrorMarksPermanentFailuresNonRetryable(t *testing.T) {
	err := temporalActivityError(errors.New("missing Tencent credentials; set TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY"))
	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected application error, got %T", err)
	}
	if !appErr.NonRetryable() {
		t.Fatal("expected non-retryable application error")
	}
}

func TestTemporalActivityErrorKeepsTransportFailuresRetryable(t *testing.T) {
	err := temporalActivityError(errors.New("dial tcp: i/o timeout"))
	var appErr *temporal.ApplicationError
	if errors.As(err, &appErr) && appErr.NonRetryable() {
		t.Fatal("transport failures should not be marked non-retryable")
	}
}

func TestTencentPermissionErrorIsNonRetryable(t *testing.T) {
	err := temporalActivityError(&TencentAPIError{Code: "UnauthorizedOperation", Message: "not allowed"})
	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) || !appErr.NonRetryable() {
		t.Fatalf("expected non-retryable application error, got %T %[1]v", err)
	}
}

func TestTencentPollingMissesRemainRetryable(t *testing.T) {
	for _, code := range []string{"ResourceNotFound.Instance", "UnsupportedOperation.InstanceState"} {
		err := temporalActivityError(&TencentAPIError{Code: code, Message: "state not ready"})
		var appErr *temporal.ApplicationError
		if errors.As(err, &appErr) && appErr.NonRetryable() {
			t.Fatalf("%s should remain retryable", code)
		}
	}
}
