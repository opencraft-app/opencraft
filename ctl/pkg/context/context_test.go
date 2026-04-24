package context

import (
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestSetActionReplacesLoggerFieldInsteadOfAccumulating(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)

	ctx := NewContext(nil)
	ctx.SetLogger(zap.New(core))
	ctx.SetAction("first")
	ctx.SetAction("second")
	ctx.Logger().Info("test")

	if logs.Len() != 1 {
		t.Fatalf("expected one log entry, got %d", logs.Len())
	}
	fields := logs.All()[0].Context
	var actionCount int
	var actionValue string
	for _, field := range fields {
		if field.Key == "action" {
			actionCount++
			actionValue = field.String
		}
	}
	if actionCount != 1 {
		t.Fatalf("expected one action field, got %d", actionCount)
	}
	if actionValue != "second" {
		t.Fatalf("expected latest action field, got %q", actionValue)
	}
}
