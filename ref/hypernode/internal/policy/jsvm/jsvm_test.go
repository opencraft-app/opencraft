package goja

import (
	"testing"
	"time"
)

func TestUnresolvedPromiseDoesNotBlockHostEntry(t *testing.T) {
	vm := New()
	defer vm.Close()
	done := make(chan error, 1)
	go func() {
		value, err := vm.RunString("globalThis.pending = new Promise(() => {}); 42")
		if value != nil {
			value.Free()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("QuickJS host entry waited for an unresolved Promise")
	}
}

func TestContextBytesRemainUint8Array(t *testing.T) {
	vm := New()
	defer vm.Close()
	if err := vm.Set("context", map[string]any{"dataBytes": []byte{1, 2, 3}}); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`[
		context.dataBytes instanceof Uint8Array,
		context.dataBytes.length,
		Array.from(context.dataBytes),
	]`)
	if err != nil {
		t.Fatal(err)
	}
	defer value.Free()
	var result []any
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	if result[0] != true || result[1] != int64(3) && result[1] != 3 {
		t.Fatalf("unexpected byte projection: %#v", result)
	}
}

func TestPromiseMicrotasksReachCheckpointBeforeReturning(t *testing.T) {
	vm := New()
	defer vm.Close()

	value, err := vm.RunString(`
		globalThis.microtaskResult = "pending";
		Promise.resolve().then(() => { globalThis.microtaskResult = "settled"; });
		"evaluated";
	`)
	if err != nil {
		t.Fatal(err)
	}
	value.Free()

	result := vm.Get("microtaskResult")
	defer result.Free()
	if result.String() != "settled" {
		t.Fatalf("promise checkpoint did not drain: %q", result.String())
	}
}

func TestAwaitDrivesPromiseJobs(t *testing.T) {
	vm := New()
	defer vm.Close()
	promise, err := vm.RunString(`Promise.resolve(40).then((value) => value + 2)`)
	if err != nil {
		t.Fatal(err)
	}
	defer promise.Free()
	result, err := vm.Await(promise, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer result.Free()
	if got := result.Export(); got != int64(42) && got != float64(42) {
		t.Fatalf("unexpected awaited result: %#v", got)
	}
}

func TestRuntimeClosesWithSelfReturningHostObject(t *testing.T) {
	vm := New()
	object := vm.NewObject()
	if err := object.Set("again", func() *Object { return object }); err != nil {
		t.Fatal(err)
	}
	if err := vm.Set("selfReturning", object); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`selfReturning.again() === selfReturning`)
	if err != nil {
		t.Fatal(err)
	}
	if value.Export() != true {
		t.Fatalf("host object identity was not preserved: %#v", value.Export())
	}
	value.Free()
	if err := vm.Close(); err != nil {
		t.Fatal(err)
	}
}
