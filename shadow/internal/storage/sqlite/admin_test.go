package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
)

func TestListAdminAccountsIncludesPendingAndBoundUsers(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	pending, _, err := store.EnsureUser(ctx, "usr_pending", "+86", "13800000001")
	if err != nil {
		t.Fatalf("ensure pending user: %v", err)
	}
	bound, _, err := store.EnsureUser(ctx, "usr_bound", "+86", "13800000002")
	if err != nil {
		t.Fatalf("ensure bound user: %v", err)
	}
	if err := store.MarkShadowAccountRegistered(ctx, bound.ID); err != nil {
		t.Fatalf("mark registered: %v", err)
	}
	if err := store.MarkShadowAccountBasicAuth(ctx, bound.ID); err != nil {
		t.Fatalf("mark basic auth: %v", err)
	}
	if err := store.MarkStandardRealnameAuth(ctx, bound.ID); err != nil {
		t.Fatalf("mark realname: %v", err)
	}
	boundAt := time.Now().UTC().Add(time.Minute)
	if err := store.SaveBinding(ctx, storage.Binding{
		UserID:         bound.ID,
		ShadowUserName: "shadow_bound",
		Uin:            330500000005,
		OwnerUin:       260203940,
		AppID:          1300000001,
		InstanceID:     "lhins-bound",
		CountryCode:    bound.CountryCode,
		PhoneNumber:    bound.PhoneNumber,
		CreatedAt:      boundAt,
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}

	accounts, total, err := store.ListAdminAccounts(ctx, storage.AdminAccountFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list accounts: %v", err)
	}
	if total != 2 || len(accounts) != 2 {
		t.Fatalf("unexpected result total=%d len=%d", total, len(accounts))
	}
	if accounts[0].UserID != bound.ID || accounts[0].ShadowUserName != "shadow_bound" {
		t.Fatalf("unexpected bound account: %#v", accounts[0])
	}
	if accounts[0].Uin != "330500000005" || accounts[0].OwnerUin != "260203940" || accounts[0].AppID != "1300000001" {
		t.Fatalf("unexpected account identifiers: %#v", accounts[0])
	}
	if !accounts[0].IsRegisterShadowAccount || !accounts[0].IsShadowAccountBasicAuth || !accounts[0].IsStandardRealnameAuth {
		t.Fatalf("missing bound account states: %#v", accounts[0])
	}
	if accounts[0].BoundAt == nil || !accounts[0].BoundAt.Equal(boundAt) {
		t.Fatalf("unexpected bound time: %#v", accounts[0].BoundAt)
	}
	if accounts[1].UserID != pending.ID || accounts[1].BoundAt != nil {
		t.Fatalf("unexpected pending account: %#v", accounts[1])
	}

	filtered, filteredTotal, err := store.ListAdminAccounts(ctx, storage.AdminAccountFilter{
		Search:   "330500000005",
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("filter accounts: %v", err)
	}
	if filteredTotal != 1 || len(filtered) != 1 || filtered[0].UserID != bound.ID {
		t.Fatalf("unexpected filtered result total=%d accounts=%#v", filteredTotal, filtered)
	}
}

func TestListAdminAccountsPaginates(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	for _, userID := range []string{"usr_1", "usr_2", "usr_3"} {
		if _, _, err := store.EnsureUser(ctx, userID, "+86", "1380000000"+userID[len(userID)-1:]); err != nil {
			t.Fatalf("ensure %s: %v", userID, err)
		}
	}
	accounts, total, err := store.ListAdminAccounts(ctx, storage.AdminAccountFilter{Page: 2, PageSize: 2})
	if err != nil {
		t.Fatalf("list accounts: %v", err)
	}
	if total != 3 || len(accounts) != 1 {
		t.Fatalf("unexpected pagination total=%d len=%d", total, len(accounts))
	}
}
