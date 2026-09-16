package computerv2

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/config"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/database/migration"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/computerproviderbinding"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
)

const (
	testAccountID  = "0199f95e-1900-7000-8000-000000000001"
	testServerID   = "0199f95e-1900-7000-8000-000000000002"
	testMemberID   = "0199f95e-1900-7000-8000-000000000003"
	testComputerID = "0199f95e-1900-7000-8000-000000000004"
	testServerTwo  = "0199f95e-1900-7000-8000-000000000005"
	testMemberTwo  = "0199f95e-1900-7000-8000-000000000006"
)

var testNow = time.Date(2026, 9, 14, 14, 0, 0, 0, time.UTC)

func TestEntRepositoryAttachesOwnedInstanceOnceAndReplaysIdempotently(t *testing.T) {
	repository, handle := openRepository(t)
	seedMembership(t, handle, testServerID, testMemberID, "server-one")
	command := attachCommand(testServerID, testComputerID, "instance-1", "attach-one")

	created, err := repository.Attach(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != testComputerID || created.ServerID != testServerID ||
		created.Kind != "lightvela_instance" || created.InstanceID != "instance-1" ||
		created.LifecycleState != "active" || created.Revision != 1 {
		t.Fatalf("Attach() = %#v", created)
	}
	entity, err := handle.Client().Computer.Get(context.Background(), testComputerID)
	if err != nil || entity.Kind != "lightvela_instance" ||
		entity.ProviderInstanceID == nil || *entity.ProviderInstanceID != "instance-1" ||
		entity.TatInstanceID != nil || entity.TatInstanceKind != "lightvela_instance" {
		t.Fatalf("stored Computer = (%#v, %v)", entity, err)
	}
	binding, err := handle.Client().ComputerProviderBinding.Query().
		Where(computerproviderbinding.BindingHashEQ(providerBindingHash("lightvela_instance", "instance-1"))).
		Only(context.Background())
	if err != nil || binding.ServerID != testServerID || binding.ComputerID != testComputerID || binding.State != "active" {
		t.Fatalf("stored binding = (%#v, %v)", binding, err)
	}

	replay := command
	replay.Computer.ID = "0199f95e-1900-7000-8000-000000000099"
	replayed, err := repository.Attach(context.Background(), replay)
	if err != nil || replayed.ID != testComputerID {
		t.Fatalf("Attach(replay) = (%#v, %v)", replayed, err)
	}
	count, err := handle.Client().Computer.Query().Count(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("Computer count = (%d, %v)", count, err)
	}
	page, err := repository.List(context.Background(), testAccountID, testServerID, computerv2port.ListOptions{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != testComputerID {
		t.Fatalf("List() = (%#v, %v)", page, err)
	}
}

func TestEntRepositoryRejectsOneInstanceAcrossServers(t *testing.T) {
	repository, handle := openRepository(t)
	seedMembership(t, handle, testServerID, testMemberID, "server-one")
	seedMembership(t, handle, testServerTwo, testMemberTwo, "server-two")
	if _, err := repository.Attach(context.Background(), attachCommand(testServerID, testComputerID, "instance-1", "attach-one")); err != nil {
		t.Fatal(err)
	}
	second := attachCommand(testServerTwo, "0199f95e-1900-7000-8000-000000000007", "instance-1", "attach-two")
	if _, err := repository.Attach(context.Background(), second); !errors.Is(err, computerv2port.ErrInstanceAlreadyAttached) {
		t.Fatalf("Attach(second server) error = %v", err)
	}
}

func TestEntRepositoryRequiresAdminAndRejectsIdempotencyKeyReuse(t *testing.T) {
	repository, handle := openRepository(t)
	seedMembership(t, handle, testServerID, testMemberID, "server-one")
	command := attachCommand(testServerID, testComputerID, "instance-1", "attach-one")
	if _, err := repository.Attach(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	conflict := command
	conflict.RequestHash = sha256.Sum256([]byte("different"))
	if _, err := repository.Attach(context.Background(), conflict); !errors.Is(err, computerv2port.ErrIdempotencyConflict) {
		t.Fatalf("Attach(idempotency conflict) error = %v", err)
	}

	otherAccount := "0199f95e-1900-7000-8000-000000000008"
	other := attachCommand(testServerID, "0199f95e-1900-7000-8000-000000000009", "instance-2", "attach-other")
	other.AccountID = otherAccount
	if _, err := repository.Attach(context.Background(), other); !errors.Is(err, computerv2port.ErrAdminRequired) {
		t.Fatalf("Attach(non-admin) error = %v", err)
	}
}

func attachCommand(serverID, computerID, instanceID, key string) computerv2port.AttachCommand {
	return computerv2port.AttachCommand{
		AccountID: testAccountID, ServerID: serverID, IdempotencyKey: key,
		RequestHash: sha256.Sum256([]byte(serverID + "\x00" + instanceID)),
		CreatedAt:   testNow,
		Computer: computerv2port.Draft{
			ID: computerID, Kind: "lightvela_instance", InstanceID: instanceID,
			Name: "Build Mac", LifecycleState: "active",
		},
	}
}

func openRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "collaboration.db"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedMembership(t *testing.T, handle *database.Handle, serverID, memberID, slug string) {
	t.Helper()
	ctx := context.Background()
	accountExists, err := handle.Client().Account.Query().Exist(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !accountExists {
		if _, err := handle.Client().Account.Create().SetID(testAccountID).
			SetEmail("alice@example.com").SetEmailNormalized("alice@example.com").
			SetDisplayName("Alice").SetPasswordHash("not-used").SetTokenVersion(1).
			SetImUserID("u_ALICE").SetImState("ready").SetRevision(1).
			SetCreatedAt(testNow).SetUpdatedAt(testNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().Server.Create().SetID(serverID).SetSlug(slug).SetName(slug).
		SetOwnerMemberID(memberID).SetImGroupID("im-" + slug).SetImState("ready").
		SetNextTaskNumber(1).SetRevision(1).SetCreatedAt(testNow).SetUpdatedAt(testNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().SetID(memberID).SetServerID(serverID).
		SetAccountID(testAccountID).SetKind("human").SetRole("owner").SetDisplayName("Alice").
		SetHandle("alice-" + slug).SetStatus("active").SetImState("ready").SetRevision(1).
		SetCreatedAt(testNow).SetUpdatedAt(testNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().SetAccountID(testAccountID).
		SetServerID(serverID).SetMemberID(memberID).SetRole("owner").SetStatus("active").
		SetServerNameSnapshot(slug).SetServerSlugSnapshot(slug).SetServerRevision(1).
		SetProjectedAt(testNow).SetUpdatedAt(testNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
}
