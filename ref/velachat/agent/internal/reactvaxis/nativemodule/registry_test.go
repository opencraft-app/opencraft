package nativemodule_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
	"velachat/agent/internal/reactvaxis"
	"velachat/agent/internal/reactvaxis/nativemodule"
)

type safeProviderError struct {
	code string
}

func (e safeProviderError) Error() string {
	return "provider token=must-not-cross https://secret.invalid"
}

func (e safeProviderError) SafeCode() string { return e.code }

func TestCallResolvesOnOwningRuntimeLoop(t *testing.T) {
	registry := nativemodule.NewRegistry()
	registry.RegisterCall("platform.v1", "echo", func(_ context.Context, payload any) (any, error) {
		return map[string]any{"value": payload.(map[string]any)["value"]}, nil
	})
	source := `
globalThis.__velaTui = {
  start() {
    __velaNativeModules.call("platform.v1", "echo", {value: "你好"}, {requestId: "r1"})
      .then(result => __velaNative.commit({type: "Text", testId: "result", text: result.value}));
  }, dispatch() {}, resize() {}
};`
	runtime := newRuntime(t, source, registry)
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Text != "你好" {
		t.Fatalf("result = %#v", tree)
	}
}

func TestSubscriptionUsesBoundedSequenceAndStopsAfterUnsubscribe(t *testing.T) {
	registry := nativemodule.NewRegistry(nativemodule.WithQueueCapacity(2))
	registry.RegisterTopic("messaging.v1", "messages", func(ctx context.Context, _ any, emit nativemodule.EmitFunc) error {
		for index := 1; index <= 2; index++ {
			if err := emit(map[string]any{"index": index}); err != nil {
				return err
			}
		}
		<-ctx.Done()
		return ctx.Err()
	})
	source := `
globalThis.__velaNativeModuleDispatch = event => {
  if (event.kind === "event") {
    __velaNative.commit({type: "Text", testId: "event", text: String(event.sequence)});
    if (event.sequence === 2) __velaNativeModules.unsubscribe(event.subscriptionId);
  }
};
globalThis.__velaTui = {
  start() { __velaNativeModules.subscribe("messaging.v1", "messages", {}, {subscriptionId: "s1", launchId: "l1"}); },
  dispatch() {}, resize() {}
};`
	runtime := newRuntime(t, source, registry)
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	first, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.Text != "1" || second.Text != "2" {
		t.Fatalf("sequences = %q,%q", first.Text, second.Text)
	}
}

func TestCallDeadlineCancelsHandlerAndReturnsStableError(t *testing.T) {
	registry := nativemodule.NewRegistry()
	registry.RegisterCall("platform.v1", "slow", func(ctx context.Context, _ any) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	source := `
globalThis.__velaTui = {
  start() {
    __velaNativeModules.call("platform.v1", "slow", {}, {requestId: "r-deadline", deadlineMs: 10})
      .catch(error => __velaNative.commit({type: "Text", testId: "error", text: error.code + ":" + error.requestId}));
  }, dispatch() {}, resize() {}
};`
	runtime := newRuntime(t, source, registry)
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Text != "NATIVE_DEADLINE_EXCEEDED:r-deadline" {
		t.Fatalf("error = %q", tree.Text)
	}
}

func TestCallPreservesOnlySafeProviderCodeAndRedactsMessage(t *testing.T) {
	registry := nativemodule.NewRegistry()
	registry.RegisterCall("messaging.v1", "history", func(context.Context, any) (any, error) {
		return nil, safeProviderError{code: "sdk_10007"}
	})
	source := `
globalThis.__velaTui = {
  start() {
    __velaNativeModules.call("messaging.v1", "history", {}, {requestId: "r-provider"})
      .catch(error => __velaNative.commit({
        type: "Text", testId: "error",
        text: error.code + ":" + error.providerCode + ":" + error.message
      }));
  }, dispatch() {}, resize() {}
};`
	runtime := newRuntime(t, source, registry)
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Text != "NATIVE_CALL_FAILED:sdk_10007:消息服务请求失败" {
		t.Fatalf("error = %q", tree.Text)
	}
}

func TestCallRejectsPayloadAboveRegistryLimitBeforeHandler(t *testing.T) {
	called := false
	registry := nativemodule.NewRegistry(nativemodule.WithMaxPayloadBytes(32))
	registry.RegisterCall("platform.v1", "echo", func(_ context.Context, payload any) (any, error) {
		called = true
		return payload, nil
	})
	source := `
globalThis.__velaTui = {
  start() {
    __velaNativeModules.call("platform.v1", "echo", {value: "abcdefghijklmnopqrstuvwxyz"}, {requestId: "r-large"})
      .catch(error => __velaNative.commit({type: "Text", testId: "error", text: error.code}));
  }, dispatch() {}, resize() {}
};`
	runtime := newRuntime(t, source, registry)
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Text != "NATIVE_PAYLOAD_TOO_LARGE" || called {
		t.Fatalf("text=%q called=%v", tree.Text, called)
	}
}

func TestSubscriptionOverflowDropsOldLaunchAndUsesIndependentResyncControl(t *testing.T) {
	registry := nativemodule.NewRegistry(nativemodule.WithQueueCapacity(1))
	handlerDone := make(chan struct{})
	registry.RegisterTopic("messaging.v1", "messages", func(_ context.Context, _ any, emit nativemodule.EmitFunc) error {
		defer close(handlerDone)
		for index := 1; index <= 3; index++ {
			if err := emit(map[string]any{"index": index}); err != nil {
				return err
			}
		}
		return nil
	})
	vm := goja.New()
	vm.SetFieldNameMapper(goja.TagFieldNameMapper("json", true))
	scheduled := make(chan func(*goja.Runtime), 4)
	registry.Bind(func(callback func(*goja.Runtime)) bool {
		scheduled <- callback
		return true
	})
	defer registry.Close()
	if err := registry.Install(vm); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	events := make([]map[string]any, 0, 2)
	if err := vm.Set("__velaNativeModuleDispatch", func(call goja.FunctionCall) goja.Value {
		var event map[string]any
		if err := vm.ExportTo(call.Argument(0), &event); err != nil {
			panic(vm.NewGoError(err))
		}
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
		return goja.Undefined()
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := vm.RunString(`__velaNativeModules.subscribe("messaging.v1", "messages", {}, {subscriptionId:"s-overflow", launchId:"l1"})`); err != nil {
		t.Fatal(err)
	}

	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("topic handler did not finish")
	}
	for len(scheduled) > 0 {
		(<-scheduled)(vm)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 || events[0]["kind"] != "resync_required" ||
		events[0]["subscriptionId"] != "s-overflow" || fmt.Sprint(events[0]["lastSequence"]) != "0" {
		t.Fatalf("events = %s", fmt.Sprint(events))
	}
}

func newRuntime(t *testing.T, source string, registry *nativemodule.Registry) *reactvaxis.Runtime {
	t.Helper()
	digest := sha256.Sum256([]byte(source))
	runtime, err := reactvaxis.NewRuntime(reactvaxis.RuntimeConfig{
		Bundle: reactvaxis.Bundle{
			Name: "native-module-test", Protocol: reactvaxis.ProtocolV1,
			Source: source, SHA256: hex.EncodeToString(digest[:]),
		},
		Installers: []reactvaxis.Installer{registry},
		Commits:    4,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}
