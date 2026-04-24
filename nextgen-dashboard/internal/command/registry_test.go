package command

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
)

func TestExecuteUsersListJSON(t *testing.T) {
	t.Parallel()

	registry := NewRegistry(fakeProvider())
	result, err := registry.Execute(context.Background(), "users list --json")
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if result.Mode != ModeCommand {
		t.Fatalf("expected command mode, got %q", result.Mode)
	}

	var users []map[string]any
	if err := json.Unmarshal([]byte(result.Output), &users); err != nil {
		t.Fatalf("output was not valid json: %v\n%s", err, result.Output)
	}
	if len(users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users))
	}
}

func TestExecuteUsersGetHumanReadable(t *testing.T) {
	t.Parallel()

	registry := NewRegistry(fakeProvider())
	result, err := registry.Execute(context.Background(), "users get usr_1")
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !strings.Contains(result.Output, "usr_1") || !strings.Contains(result.Output, "alice@example.com") {
		t.Fatalf("expected detailed user output, got %q", result.Output)
	}
}

func TestExecuteSubscriptionsListJSON(t *testing.T) {
	t.Parallel()

	registry := NewRegistry(fakeProvider())
	result, err := registry.Execute(context.Background(), "subscriptions list --json")
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	var subscriptions []map[string]any
	if err := json.Unmarshal([]byte(result.Output), &subscriptions); err != nil {
		t.Fatalf("output was not valid json: %v\n%s", err, result.Output)
	}
	if len(subscriptions) != 1 {
		t.Fatalf("expected 1 subscription, got %d", len(subscriptions))
	}
}

func TestExecuteSandboxesListHumanReadable(t *testing.T) {
	t.Parallel()

	registry := NewRegistry(fakeProvider())
	result, err := registry.Execute(context.Background(), "sandboxes list")
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !strings.Contains(result.Output, "sbx_1") || !strings.Contains(result.Output, "pool-bj8") {
		t.Fatalf("expected sandbox output, got %q", result.Output)
	}
}

func TestExecuteShellSwitchesMode(t *testing.T) {
	t.Parallel()

	registry := NewRegistry(fakeProvider())
	result, err := registry.Execute(context.Background(), "shell")
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if result.Mode != ModeShell {
		t.Fatalf("expected shell mode, got %q", result.Mode)
	}
}

func fakeProvider() data.Provider {
	now := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	return data.StaticProvider{
		UsersData: []data.User{
			{ID: "usr_1", Name: "Alice", Email: "alice@example.com", InviteRequired: true, CreatedAt: now},
			{ID: "usr_2", Name: "Bob", Phone: "13800000000", InviteRequired: true, CreatedAt: now},
		},
		SubscriptionsData: []data.Subscription{
			{UserID: "usr_1", Tier: "free", ConfirmedAt: now},
		},
		SandboxesData: []data.Sandbox{
			{ID: "sbx_1", PoolID: "pool-bj8", InstanceID: "ins_1", CreatedAt: now},
		},
	}
}
