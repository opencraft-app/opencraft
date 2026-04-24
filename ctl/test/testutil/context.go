package testutil

import (
	"testing"

	"go.uber.org/zap"

	pctx "ctl/pkg/context"
	"ctl/pkg/resource"
)

func NewContext(t *testing.T, userID string) pctx.Context {
	t.Helper()

	if resource.ZapLogger == nil {
		resource.ZapLogger = zap.NewNop()
	}

	ctx := pctx.NewContext(nil).WithRegion("ap-guangzhou").WithUserID(userID)
	ctx.SetRequestId("test-trace-id")
	return ctx
}
