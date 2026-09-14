package policy

import (
	"testing"

	goja "hypernode/internal/policy/jsvm"
)

func TestUint8ArrayFromStringCompatibility(t *testing.T) {
	vm := goja.New()
	if err := installECMAScriptCompatibility(vm); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`(() => {
      const context = { offset: 1 };
      const text = Uint8Array.from("AB", function (character, index) {
        return character.charCodeAt(0) + index + this.offset;
      }, context);
      const typed = Uint8Array.from(new Uint16Array([257, 258]));
      return [text, typed];
    })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result [][]byte
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	if string(result[0]) != "BD" {
		t.Fatalf("mapped string=%v", result[0])
	}
	if result[1][0] != 1 || result[1][1] != 2 {
		t.Fatalf("typed array path=%v", result[1])
	}
}
