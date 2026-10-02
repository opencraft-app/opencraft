package meshharness

import (
	"bytes"
	"errors"
	"testing"
)

func TestCOSEmulatorSeparatesDurabilityFromAccessPathVisibility(t *testing.T) {
	cos := NewCOSEmulator()
	key, payload := "cells/a/manifests/g7", []byte("exact actor heads and immutable object keys")
	if err := cos.Put(key, payload); err != nil {
		t.Fatal(err)
	}
	cos.Script("access-b", key, ErrCOSNotFound, ErrCOSTimeout, nil)
	if _, err := cos.Get("access-b", key); !errors.Is(err, ErrCOSNotFound) {
		t.Fatalf("first observation = %v", err)
	}
	if _, err := cos.Get("access-b", key); !errors.Is(err, ErrCOSTimeout) {
		t.Fatalf("second observation = %v", err)
	}
	got, err := cos.Get("access-b", key)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("converged GET = %q, %v", got, err)
	}
	if _, err := cos.Head("access-c", key); err != nil {
		t.Fatalf("independent HEAD failed: %v", err)
	}
	if err := cos.Put(key, []byte("overwrite")); err == nil {
		t.Fatal("immutable key overwrite was accepted")
	}
}
