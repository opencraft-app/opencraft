package policy

import (
	"fmt"

	goja "hypernode/internal/policy/jsvm"
)

// installECMAScriptCompatibility fills narrow gaps between QuickJS and the
// Workers/browser JavaScript baseline. Every patch feature-detects first and
// leaves a conforming host implementation untouched.
func installECMAScriptCompatibility(vm *goja.Runtime) error {
	_, err := vm.RunString(`(() => {
    let supportsStringIterable = false;
    try {
      const probe = Uint8Array.from("A", (character) => character.charCodeAt(0));
      supportsStringIterable = probe.length === 1 && probe[0] === 65;
    } catch {}
    if (supportsStringIterable) return;

    const nativeFrom = Uint8Array.from;
    Object.defineProperty(Uint8Array, "from", {
      configurable: true,
      writable: true,
      value(source, mapFunction, thisArgument) {
        if (typeof source !== "string") {
          return mapFunction === undefined
            ? nativeFrom.call(this, source)
            : nativeFrom.call(this, source, mapFunction, thisArgument);
        }
        const values = [];
        for (const value of source) values.push(value);
        return mapFunction === undefined
          ? nativeFrom.call(this, values)
          : nativeFrom.call(this, values, mapFunction, thisArgument);
      },
    });
  })()`)
	if err != nil {
		return fmt.Errorf("install ECMAScript compatibility: %w", err)
	}
	return nil
}
