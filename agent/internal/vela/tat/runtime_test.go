package tat

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestRuntimeRegisterEncodesTencentTagShape(t *testing.T) {
	t.Parallel()

	bridge := &fakeBridge{}
	runtime := newRuntime(bridge)
	root := t.TempDir()
	err := runtime.Register(context.Background(), Registration{
		StateRoot:         root,
		Region:            "ap-guangzhou",
		RegisterCodeID:    "rc-test",
		RegisterCodeValue: "secret-test",
		Tags: []Tag{
			{Key: "VelaComputerID", Value: "computer-test"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bridge.registerStateRoot != root {
		t.Fatalf("state root = %q", bridge.registerStateRoot)
	}
	if bridge.registerTags !=
		`[{"Key":"VelaComputerID","Value":"computer-test"}]` {
		t.Fatalf("tags = %s", bridge.registerTags)
	}
}

func TestRuntimeRejectsUnsafeRegistrationBeforeNativeCall(t *testing.T) {
	t.Parallel()

	cases := []Registration{
		{},
		{
			StateRoot:         "relative",
			Region:            "ap-guangzhou",
			RegisterCodeID:    "id",
			RegisterCodeValue: "value",
			Tags:              []Tag{{Key: "key", Value: "value"}},
		},
		{
			StateRoot:         filepath.Clean(t.TempDir()),
			Region:            "ap-guangzhou",
			RegisterCodeID:    "id",
			RegisterCodeValue: "value",
		},
		{
			StateRoot:         filepath.Clean(t.TempDir()),
			Region:            "ap-guangzhou",
			RegisterCodeID:    "id",
			RegisterCodeValue: "value",
			Tags:              []Tag{{Key: "", Value: "value"}},
		},
	}
	for index, registration := range cases {
		bridge := &fakeBridge{}
		err := newRuntime(bridge).Register(
			context.Background(),
			registration,
		)
		if !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("case %d: %v", index, err)
		}
		if bridge.registerCalls != 0 {
			t.Fatalf("case %d called native bridge", index)
		}
	}
}

func TestRuntimeStartAndCloseExactlyOnce(t *testing.T) {
	t.Parallel()

	native := &fakeNativeHandle{}
	bridge := &fakeBridge{startHandle: native}
	runtime := newRuntime(bridge)
	handle, err := runtime.Start(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if bridge.startCalls != 1 {
		t.Fatalf("start calls = %d", bridge.startCalls)
	}
	if err := handle.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if native.closeCalls != 1 {
		t.Fatalf("close calls = %d", native.closeCalls)
	}
}

func TestRuntimeInspectsOnlyPublicProviderIdentity(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	bridge := &fakeBridge{identity: Identity{
		Region: "ap-guangzhou", InstanceID: "rins-public-identity",
	}}
	identity, err := newRuntime(bridge).Inspect(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Region != "ap-guangzhou" || identity.InstanceID != "rins-public-identity" ||
		bridge.inspectStateRoot != root {
		t.Fatalf("identity=%#v stateRoot=%q", identity, bridge.inspectStateRoot)
	}
}

type fakeBridge struct {
	registerCalls     int
	registerStateRoot string
	registerTags      string
	startCalls        int
	startHandle       nativeHandle
	inspectStateRoot  string
	identity          Identity
}

func (b *fakeBridge) register(
	stateRoot string,
	_ string,
	_ string,
	_ string,
	tags string,
) error {
	b.registerCalls++
	b.registerStateRoot = stateRoot
	b.registerTags = tags
	return nil
}

func (b *fakeBridge) start(_ string) (nativeHandle, error) {
	b.startCalls++
	return b.startHandle, nil
}

func (b *fakeBridge) inspect(stateRoot string) (Identity, error) {
	b.inspectStateRoot = stateRoot
	return b.identity, nil
}

type fakeNativeHandle struct {
	closeCalls int
}

func (h *fakeNativeHandle) close() error {
	h.closeCalls++
	return nil
}
