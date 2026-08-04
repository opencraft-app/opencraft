package tencentoperation

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/tatinstancebinding"
	tencentoperationport "chatserver/internal/ports/tencentoperation"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	repoServerID   = "019b1f6e-ea4a-745c-9180-dff606cda19a"
	repoComputerID = "019b1f6e-ea4a-745c-9180-dff606cda19b"
	repoOperation1 = "019b1f6e-ea4a-745c-9180-dff606cda19d"
	repoOperation2 = "019b1f6e-ea4a-745c-9180-dff606cda19e"
)

var repoNow = time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)

func TestRepository只领取Computer操作并保持同Computer顺序(t *testing.T) {
	handle := openOperationDatabase(t)
	seedActiveComputer(t, handle)
	seedComputerOperation(t, handle, repoOperation1, "tat.computer.refresh", 2, repoNow)
	seedComputerOperation(t, handle, repoOperation2, "tat.computer.refresh", 2, repoNow.Add(time.Second))
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, ok, err := repository.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: "worker-a", Now: repoNow, LeaseExpiresAt: repoNow.Add(time.Minute),
	})
	if err != nil || !ok || work.OperationID != repoOperation1 || work.ResourceType != "computer" {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	if err := repository.Complete(context.Background(), tencentoperationport.Completion{
		OperationID: repoOperation1, LeaseOwner: "worker-a",
		Status: tencentoperationport.CompletionRetry, ErrorCode: "tat_temporarily_unavailable",
		NextAttemptAt: repoNow.Add(time.Minute), CompletedAt: repoNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	_, ok, err = repository.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: "worker-b", Now: repoNow.Add(10 * time.Second), LeaseExpiresAt: repoNow.Add(2 * time.Minute),
	})
	if err != nil || ok {
		t.Fatalf("后续操作不应越过 retry_wait 前序 = (%v, %v)", ok, err)
	}
}

func TestRepository拒绝旧AgentTAT操作(t *testing.T) {
	handle := openOperationDatabase(t)
	if _, err := handle.Client().TencentOperation.Create().
		SetID(repoOperation1).SetPartitionKey(repoServerID).SetServerID(repoServerID).
		SetService("tat").SetKind("tat.computer.refresh").SetResourceType("agent").
		SetResourceID("019b1f6e-ea4a-745c-9180-dff606cda19c").SetIdempotencyKey(repoOperation1).
		SetDesiredRevision(1).SetState("pending").SetAttempts(0).
		SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: "worker-a", Now: repoNow, LeaseExpiresAt: repoNow.Add(time.Minute),
	})
	if err != nil || ok {
		t.Fatalf("旧 Agent TAT 操作不得被领取 = (%v, %v)", ok, err)
	}
}

func TestRepository绑定注册成功的Computer(t *testing.T) {
	handle := openOperationDatabase(t)
	expiresAt := repoNow.Add(time.Hour)
	seedManagedComputerRegistration(t, handle, repoOperation1, expiresAt, "macos")
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, ok, err := repository.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: "worker-a", Now: repoNow, LeaseExpiresAt: repoNow.Add(time.Minute),
	})
	if err != nil || !ok || work.Target.OS != tencenttatport.OSMacOS || work.RegistrationExpiresAt == nil {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	online := true
	if err := repository.Complete(context.Background(), tencentoperationport.Completion{
		OperationID: repoOperation1, LeaseOwner: "worker-a",
		Status:             tencentoperationport.CompletionSucceeded,
		ComputerInstanceID: "rins-macos-canary", ComputerOS: tencenttatport.OSMacOS,
		ComputerTATOnline: &online, CompletedAt: repoNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	host, err := handle.Client().Computer.Get(context.Background(), repoComputerID)
	if err != nil || host.LifecycleState != "active" || host.TatAgentState != "online" ||
		host.TatInstanceID == nil || *host.TatInstanceID != "rins-macos-canary" || host.RegistrationExpiresAt != nil {
		t.Fatalf("computer = (%#v, %v)", host, err)
	}
	binding, err := handle.Client().TATInstanceBinding.Query().
		Where(tatinstancebinding.BindingHashEQ(bindingHash("ap-beijing", "rins-macos-canary"))).
		Only(context.Background())
	if err != nil || binding.ComputerID != repoComputerID {
		t.Fatalf("binding = (%#v, %v)", binding, err)
	}
}

func TestRepositoryComputer完成受Lease保护并保存离线观察(t *testing.T) {
	handle := openOperationDatabase(t)
	seedActiveComputer(t, handle)
	seedComputerOperation(t, handle, repoOperation1, "tat.computer.refresh", 2, repoNow)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := repository.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: "worker-a", Now: repoNow, LeaseExpiresAt: repoNow.Add(time.Minute),
	}); err != nil || !ok {
		t.Fatalf("Claim() = (%v, %v)", ok, err)
	}
	if err := repository.Complete(context.Background(), tencentoperationport.Completion{
		OperationID: repoOperation1, LeaseOwner: "worker-b",
		Status: tencentoperationport.CompletionSucceeded, CompletedAt: repoNow.Add(time.Second),
	}); !errors.Is(err, tencentoperationport.ErrLeaseLost) {
		t.Fatalf("错误 lease completion = %v", err)
	}
	online := false
	if err := repository.Complete(context.Background(), tencentoperationport.Completion{
		OperationID: repoOperation1, LeaseOwner: "worker-a",
		Status:     tencentoperationport.CompletionSucceeded,
		ComputerOS: tencenttatport.OSLinux, ComputerTATOnline: &online,
		CompletedAt: repoNow.Add(2 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	host, err := handle.Client().Computer.Get(context.Background(), repoComputerID)
	if err != nil || host.TatAgentState != "offline" || host.Revision != 3 || host.LastObservedAt == nil {
		t.Fatalf("computer = (%#v, %v)", host, err)
	}
}

func openOperationDatabase(t *testing.T) *database.Handle {
	t.Helper()
	cfg, err := config.NewDatabase(t.TempDir() + "/data/chatserver.db")
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
	return handle
}

func seedActiveComputer(t *testing.T, handle *database.Handle) {
	t.Helper()
	if _, err := handle.Client().Computer.Create().
		SetID(repoComputerID).SetServerID(repoServerID).SetName("测试执行机").
		SetTatRegion("ap-beijing").SetTatInstanceID("rins-repository-test").
		SetTatInstanceKind("managed").SetOsType("linux").SetLifecycleState("active").
		SetTatAgentState("online").SetRevision(2).SetCreatedAt(repoNow).SetUpdatedAt(repoNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func seedManagedComputerRegistration(t *testing.T, handle *database.Handle, operationID string, expiresAt time.Time, osType string) {
	t.Helper()
	if _, err := handle.Client().Computer.Create().
		SetID(repoComputerID).SetServerID(repoServerID).SetName("托管执行机").
		SetTatRegion("ap-beijing").SetTatInstanceKind("managed").SetOsType(osType).
		SetLifecycleState("provisioning").SetTatAgentState("unknown").
		SetRegistrationExpiresAt(expiresAt).SetRevision(2).SetCreatedAt(repoNow).SetUpdatedAt(repoNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	seedComputerOperation(t, handle, operationID, "tat.computer.registration.reconcile", 2, repoNow)
}

func seedComputerOperation(t *testing.T, handle *database.Handle, id, kind string, revision int64, createdAt time.Time) {
	t.Helper()
	builder := handle.Client().TencentOperation.Create().
		SetID(id).SetPartitionKey(repoServerID).SetServerID(repoServerID).
		SetService("tat").SetKind(kind).SetResourceType("computer").SetResourceID(repoComputerID).
		SetIdempotencyKey(id).SetDesiredRevision(revision).SetState("pending").SetAttempts(0).
		SetCreatedAt(createdAt).SetUpdatedAt(createdAt)
	if kind == "tat.computer.registration.reconcile" {
		builder.SetDeadlineAt(createdAt.Add(time.Hour))
	}
	if _, err := builder.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}
