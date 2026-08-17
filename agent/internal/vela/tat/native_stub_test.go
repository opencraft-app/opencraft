//go:build !vela_tat_cgo || !cgo || ((!darwin || !arm64) && (!linux || !amd64))

package tat

import (
	"context"
	"errors"
	"testing"
)

func TestUnavailableRuntimeReturnsStableError(t *testing.T) {
	t.Parallel()

	runtime := New()
	err := runtime.Register(context.Background(), Registration{
		StateRoot:         t.TempDir(),
		Region:            "ap-guangzhou",
		RegisterCodeID:    "id",
		RegisterCodeValue: "value",
		Tags:              []Tag{{Key: "key", Value: "value"}},
	})
	if !errors.Is(err, ErrNativeUnavailable) {
		t.Fatalf("error = %v", err)
	}
}
