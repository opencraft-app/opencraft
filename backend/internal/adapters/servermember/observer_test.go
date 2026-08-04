package servermember

import (
	"context"
	"testing"
	"time"
)

func TestCreationObserverReturnsPendingWhenWaitWindowExpires(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	observer, err := NewCreationObserver(handle, 2*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}

	observation, err := observer.Await(
		context.Background(),
		testAccountID,
		testServerID,
		testOperationID,
		15*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("Await() error = %v", err)
	}
	if observation.Server.IMState != "provisioning" ||
		observation.Operation.State != "pending" {
		t.Fatalf("Await() = %#v", observation)
	}
}

func TestCreationObserverSeesSucceededCommunityWithinWindow(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	observer, err := NewCreationObserver(handle, 2*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(10 * time.Millisecond)
		ctx := context.Background()
		_, _ = handle.Client().Server.Update().
			SetImState("ready").
			SetRevision(2).
			Save(ctx)
		_, _ = handle.Client().TencentOperation.Update().
			SetState("succeeded").
			SetCompletedAt(testNow.Add(time.Second)).
			Save(ctx)
	}()

	observation, err := observer.Await(
		context.Background(),
		testAccountID,
		testServerID,
		testOperationID,
		250*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("Await() error = %v", err)
	}
	if observation.Server.IMState != "ready" ||
		observation.Operation.State != "succeeded" ||
		observation.Operation.CompletedAt == nil {
		t.Fatalf("Await() = %#v", observation)
	}
}
