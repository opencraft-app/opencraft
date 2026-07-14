package gatewayroute

import (
	"errors"
	"testing"

	"ctl/pkg/resource"
)

func TestRecordRejectsEmptyUserID(t *testing.T) {
	originalDB := resource.GormDB
	resource.GormDB = nil
	t.Cleanup(func() {
		resource.GormDB = originalDB
	})

	err := Record("  ", GatewayLLMGateway, "sub-llm", "plan-llm", SourceManual)
	if !errors.Is(err, ErrUserIDRequired) {
		t.Fatalf("expected ErrUserIDRequired, got %v", err)
	}
}
