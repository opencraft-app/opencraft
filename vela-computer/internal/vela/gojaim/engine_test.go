package gojaim

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
)

func TestEngineLoadsRealBundleCreatesClientAndCloses(t *testing.T) {
	engine, err := NewEngine(Config{
		SDKAppID: 1_400_000_001,
		Host:     silentHost{},
	})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	if engine.ClientID() == "" {
		t.Fatal("engine did not create a LiteChat client")
	}
	events, err := engine.DrainEvents(context.Background())
	if err != nil {
		t.Fatalf("DrainEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("initial events = %#v, want none", events)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Close(ctx); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := engine.Close(ctx); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestEngineCloseHonorsContextWhileOwnerLoopIsBusy(t *testing.T) {
	engine, err := NewEngine(Config{
		SDKAppID: 1_400_000_003,
		Host:     silentHost{},
	})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	if !engine.loop.RunOnLoop(func(*goja.Runtime) {
		close(entered)
		<-release
	}) {
		t.Fatal("could not occupy owner loop")
	}
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- engine.Close(ctx) }()
	select {
	case closeErr := <-done:
		if !errors.Is(closeErr, context.DeadlineExceeded) {
			t.Fatalf("Close() error = %v, want deadline exceeded", closeErr)
		}
	case <-time.After(100 * time.Millisecond):
		close(release)
		t.Fatal("Close() ignored its context while owner loop was busy")
	}
	close(release)
	select {
	case <-engine.closed:
	case <-time.After(time.Second):
		t.Fatal("Engine did not terminate after owner loop was released")
	}
}

func TestEngineCommandHonorsContextWhileOwnerLoopIsBusy(t *testing.T) {
	engine, release := newBusyEngine(t, 1_400_000_004)
	defer closeEngineAfterBusyTest(t, engine)
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, commandErr := engine.Command(ctx, map[string]any{"op": "loginState"})
		done <- commandErr
	}()
	select {
	case commandErr := <-done:
		if !errors.Is(commandErr, context.DeadlineExceeded) {
			t.Fatalf("Command() error = %v, want deadline exceeded", commandErr)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Command() blocked while scheduling work on the busy owner loop")
	}
}

func TestEngineDrainEventsHonorsContextWhileOwnerLoopIsBusy(t *testing.T) {
	engine, release := newBusyEngine(t, 1_400_000_005)
	defer closeEngineAfterBusyTest(t, engine)
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, drainErr := engine.DrainEvents(ctx)
		done <- drainErr
	}()
	select {
	case drainErr := <-done:
		if !errors.Is(drainErr, context.DeadlineExceeded) {
			t.Fatalf("DrainEvents() error = %v, want deadline exceeded", drainErr)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("DrainEvents() blocked while scheduling work on the busy owner loop")
	}
}

func newBusyEngine(t *testing.T, sdkAppID int) (*Engine, func()) {
	t.Helper()
	engine, err := NewEngine(Config{SDKAppID: sdkAppID, Host: silentHost{}})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	if !engine.loop.RunOnLoop(func(*goja.Runtime) {
		close(entered)
		<-release
	}) {
		t.Fatal("could not occupy owner loop")
	}
	<-entered
	return engine, func() { close(release) }
}

func closeEngineAfterBusyTest(t *testing.T, engine *Engine) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Close(ctx); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestEngineReturnsRealLiteChatPromiseRejection(t *testing.T) {
	engine, err := NewEngine(Config{
		SDKAppID: 1_400_000_002,
		Host:     silentHost{},
	})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(
			context.Background(),
			time.Second,
		)
		defer cancel()
		_ = engine.Close(ctx)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = engine.Command(ctx, map[string]any{
		"op": "getConversationList",
	})
	if err == nil {
		t.Fatal("unauthenticated LiteChat command unexpectedly succeeded")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("LiteChat rejection was not resumed on owner loop: %v", err)
	}
}

func TestNormalizeFetchBodyCopiesGojaArrayBuffer(t *testing.T) {
	vm := goja.New()
	buffer := vm.NewArrayBuffer([]byte("attachment bytes"))
	body, err := normalizeFetchBody(buffer)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := body.([]byte)
	if !ok || string(got) != "attachment bytes" {
		t.Fatalf("normalized body = %#v", body)
	}
	buffer.Bytes()[0] = 'X'
	if string(got) != "attachment bytes" {
		t.Fatalf("normalized body aliases JS memory: %q", got)
	}
}

func TestClassifyCommandRejectionExposesOnlySafeDiagnosticCode(t *testing.T) {
	t.Parallel()

	vm := goja.New()
	tests := []struct {
		name   string
		value  goja.Value
		code   string
		absent string
	}{
		{
			name:  "SDK numeric code",
			value: vm.ToValue(map[string]any{"errorCode": 70013, "message": "Bearer must-not-leak"}),
			code:  "sdk_70013", absent: "must-not-leak",
		},
		{
			name: "missing FileReader shim",
			value: func() goja.Value {
				value, err := vm.RunString(`new Error("FileReader is not defined")`)
				if err != nil {
					t.Fatal(err)
				}
				return value
			}(),
			code: "missing_file_reader",
		},
		{
			name: "nested endpoint denial",
			value: vm.ToValue(map[string]any{
				"cause": map[string]any{"message": ErrEndpointDenied.Error()},
			}),
			code: "endpoint_denied",
		},
		{
			name:  "unclassified text",
			value: vm.ToValue("signed-url=must-not-leak"),
			code:  "command_rejected", absent: "must-not-leak",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			err := classifyCommandRejection(vm, test.value)
			if err.SafeCode() != test.code {
				t.Fatalf("safe code = %q, want %q", err.SafeCode(), test.code)
			}
			if test.absent != "" && strings.Contains(err.Error(), test.absent) {
				t.Fatalf("safe error leaked rejection: %q", err.Error())
			}
			if test.absent != "" && strings.Contains(err.SafeDetail(), test.absent) {
				t.Fatalf("safe detail leaked rejection: %q", err.SafeDetail())
			}
			if !errors.Is(err, ErrCommandRejected) {
				t.Fatalf("error = %v, want ErrCommandRejected", err)
			}
		})
	}
}

type silentHost struct{}

func (silentHost) OpenWebSocket(
	context.Context,
	string,
	func(SocketEvent),
) (uint64, error) {
	return 1, nil
}

func (silentHost) SendWebSocket(
	context.Context,
	uint64,
	[]byte,
) error {
	return nil
}

func (silentHost) CloseWebSocket(
	context.Context,
	uint64,
) error {
	return nil
}

func (silentHost) StartFetch(
	context.Context,
	FetchRequest,
	func(FetchResult),
) (uint64, error) {
	return 1, nil
}

func (silentHost) AbortFetch(
	context.Context,
	uint64,
) error {
	return nil
}
