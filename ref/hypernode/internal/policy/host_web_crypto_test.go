package policy

import (
	"bytes"
	"crypto/sha256"
	"testing"
	"time"
)

func TestWebCryptoDigestCompletesThroughDrainQueue(t *testing.T) {
	wake := make(chan struct{}, 1)
	bridge := &webCryptoBridge{notify: func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}}
	id, err := bridge.submitDigest("SHA-256", []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-wake:
	case <-time.After(time.Second):
		t.Fatal("digest completion did not wake the event pump")
	}
	results := bridge.drain()
	if len(results) != 1 || results[0]["id"] != id || results[0]["error"] != "" {
		t.Fatalf("unexpected digest result: %#v", results)
	}
	expected := sha256.Sum256([]byte("abc"))
	if !bytes.Equal(results[0]["bytes"].([]byte), expected[:]) {
		t.Fatalf("digest mismatch: %x", results[0]["bytes"])
	}
	if remaining := bridge.drain(); len(remaining) != 0 {
		t.Fatalf("drain was not destructive: %#v", remaining)
	}
}

func TestWebCryptoDigestRejectsUnsupportedAlgorithms(t *testing.T) {
	bridge := &webCryptoBridge{}
	if _, err := bridge.submitDigest("SHA-1", []byte("abc")); err == nil {
		t.Fatal("expected unsupported algorithm rejection")
	}
}

func TestWebCryptoPromiseCompletesThroughPolicyTick(t *testing.T) {
	engine, err := NewWithStoreConfig(defaultPolicyPath(t), "", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	engine.mu.Lock()
	value, runErr := engine.vm.RunString(`
		globalThis.__digestResult = null;
		crypto.subtle.digest("SHA-256", new Uint8Array([97, 98, 99])).then((result) => {
			globalThis.__digestResult = Array.from(new Uint8Array(result));
		});
	`)
	if value != nil {
		value.Free()
	}
	engine.mu.Unlock()
	if runErr != nil {
		t.Fatal(runErr)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if err := engine.Tick(); err != nil {
			t.Fatal(err)
		}
		engine.mu.Lock()
		resultValue, resultErr := engine.vm.RunString("globalThis.__digestResult")
		var result []byte
		if resultErr == nil {
			resultErr = engine.vm.ExportTo(resultValue, &result)
		}
		if resultValue != nil {
			resultValue.Free()
		}
		engine.mu.Unlock()
		if resultErr == nil && len(result) == sha256.Size {
			expected := sha256.Sum256([]byte("abc"))
			if !bytes.Equal(result, expected[:]) {
				t.Fatalf("digest mismatch: %x", result)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Web Crypto Promise did not complete through policy Tick")
}
