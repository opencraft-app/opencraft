package policy

import (
	"testing"

	goja "hypernode/internal/policy/jsvm"
)

func TestWorkersBase64AndBufferCompatibility(t *testing.T) {
	vm := goja.New()
	if err := installWorkerEncoding(vm); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`(() => {
      const bytes = Uint8Array.of(0, 1, 127, 128, 255);
      const buffer = Buffer.from(bytes);
      const encoded = buffer.toString("base64");
      const decoded = Buffer.from(encoded, "base64");
      const binary = atob(btoa(String.fromCharCode(0, 128, 255)));
      return {
        Encoded: encoded,
        Decoded: Array.from(decoded),
        Binary: Array.from(binary, (character) => character.charCodeAt(0)),
        IsBuffer: Buffer.isBuffer(buffer),
        IsUint8Array: buffer instanceof Uint8Array,
        IsFunction: typeof Buffer === "function",
        UTF8: Buffer.from("hello", "utf-8").toString(),
      };
    })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Encoded      string
		Decoded      []byte
		Binary       []byte
		IsBuffer     bool
		IsUint8Array bool
		IsFunction   bool
		UTF8         string
	}
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	if result.Encoded != "AAF/gP8=" || len(result.Decoded) != 5 || result.Decoded[4] != 255 {
		t.Fatalf("base64 compatibility mismatch: %+v", result)
	}
	if len(result.Binary) != 3 || result.Binary[1] != 128 || result.Binary[2] != 255 {
		t.Fatalf("atob/btoa binary string mismatch: %+v", result.Binary)
	}
	if !result.IsBuffer || !result.IsUint8Array || !result.IsFunction || result.UTF8 != "hello" {
		t.Fatalf("Buffer compatibility mismatch: %+v", result)
	}
}
