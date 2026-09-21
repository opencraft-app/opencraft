package policy

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	goja "hypernode/internal/policy/jsvm"
)

const workerEncodingBufferLimit = 32 * 1024 * 1024

func checkedEncodingBytes(data []byte) ([]byte, error) {
	if len(data) > workerEncodingBufferLimit {
		return nil, fmt.Errorf("encoding input exceeds 32 MiB limit")
	}
	return data, nil
}

func decodeWorkerBase64(text string) ([]byte, error) {
	clean := strings.Map(func(character rune) rune {
		if character == ' ' || character == '\t' || character == '\r' || character == '\n' {
			return -1
		}
		if character == '-' {
			return '+'
		}
		if character == '_' {
			return '/'
		}
		return character
	}, text)
	if remainder := len(clean) % 4; remainder != 0 {
		clean += strings.Repeat("=", 4-remainder)
	}
	if len(clean) > (workerEncodingBufferLimit*4/3)+4 {
		return nil, fmt.Errorf("base64 input exceeds 32 MiB decoded limit")
	}
	data, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 data: %w", err)
	}
	return checkedEncodingBytes(data)
}

func installWorkerEncoding(vm *goja.Runtime) error {
	host := vm.NewObject()
	if err := host.Set("copy", func(data []byte) (goja.Value, error) {
		data, err := checkedEncodingBytes(data)
		if err != nil {
			return nil, err
		}
		return hostCryptoUint8Array(vm, append([]byte(nil), data...))
	}); err != nil {
		return err
	}
	if err := host.Set("utf8Encode", func(text string) (goja.Value, error) {
		data, err := checkedEncodingBytes([]byte(text))
		if err != nil {
			return nil, err
		}
		return hostCryptoUint8Array(vm, data)
	}); err != nil {
		return err
	}
	if err := host.Set("base64Encode", func(data []byte) (string, error) {
		data, err := checkedEncodingBytes(data)
		if err != nil {
			return "", err
		}
		return base64.StdEncoding.EncodeToString(data), nil
	}); err != nil {
		return err
	}
	if err := host.Set("base64Decode", func(text string) (goja.Value, error) {
		data, err := decodeWorkerBase64(text)
		if err != nil {
			return nil, err
		}
		return hostCryptoUint8Array(vm, data)
	}); err != nil {
		return err
	}
	if err := host.Set("hexEncode", func(data []byte) (string, error) {
		data, err := checkedEncodingBytes(data)
		if err != nil {
			return "", err
		}
		return hex.EncodeToString(data), nil
	}); err != nil {
		return err
	}
	if err := host.Set("hexDecode", func(text string) (goja.Value, error) {
		if len(text) > workerEncodingBufferLimit*2 {
			return nil, fmt.Errorf("hex input exceeds 32 MiB decoded limit")
		}
		data, err := hex.DecodeString(text)
		if err != nil {
			return nil, fmt.Errorf("invalid hex data: %w", err)
		}
		return hostCryptoUint8Array(vm, data)
	}); err != nil {
		return err
	}
	if err := host.Set("utf8Decode", func(data []byte) (string, error) {
		data, err := checkedEncodingBytes(data)
		if err != nil {
			return "", err
		}
		return string(data), nil
	}); err != nil {
		return err
	}
	if err := host.Set("btoa", func(text string) (string, error) {
		data := make([]byte, 0, len(text))
		for _, character := range text {
			if character > 0xff {
				return "", fmt.Errorf("InvalidCharacterError: btoa input contains a code point greater than 255")
			}
			data = append(data, byte(character))
		}
		data, err := checkedEncodingBytes(data)
		if err != nil {
			return "", err
		}
		return base64.StdEncoding.EncodeToString(data), nil
	}); err != nil {
		return err
	}
	if err := host.Set("atob", func(text string) (string, error) {
		data, err := decodeWorkerBase64(text)
		if err != nil {
			return "", err
		}
		characters := make([]uint16, len(data))
		for index, value := range data {
			characters[index] = uint16(value)
		}
		return goja.StringFromUTF16(characters), nil
	}); err != nil {
		return err
	}
	if err := vm.Set("hostEncoding", host); err != nil {
		return err
	}
	_, err := vm.RunString(`(() => {
	globalThis.atob = (text) =>
	  Array.from(hostEncoding.base64Decode(String(text)), (byte) => String.fromCharCode(byte)).join("");
	globalThis.btoa = (text) => hostEncoding.base64Encode(
	  Uint8Array.from(String(text), (character) => character.charCodeAt(0) & 255)
	);
    if ((typeof globalThis.Buffer === "function" || typeof globalThis.Buffer === "object") &&
        typeof globalThis.Buffer.from === "function") return;

    const marker = Symbol("HypernodeBuffer");
    const decorate = (bytes) => {
      Object.defineProperty(bytes, marker, { value: true });
      Object.defineProperty(bytes, "toString", {
        configurable: true,
        value(encoding = "utf8") {
          const normalized = String(encoding).toLowerCase().replace("-", "");
          if (normalized === "base64") return hostEncoding.base64Encode(this);
          if (normalized === "hex") return hostEncoding.hexEncode(this);
          if (normalized === "utf8") return hostEncoding.utf8Decode(this);
          throw new TypeError("Unsupported Buffer encoding: " + encoding);
        },
      });
      return bytes;
    };
    function BufferCompat(source, encoding = "utf8") {
      return BufferCompat.from(source, encoding);
    }
    Object.defineProperty(BufferCompat, "name", { value: "Buffer" });
    BufferCompat.from = (source, encoding = "utf8") => {
        let bytes;
        if (typeof source === "string") {
          const normalized = String(encoding).toLowerCase().replace("-", "");
          if (normalized === "base64") bytes = hostEncoding.base64Decode(source);
          else if (normalized === "hex") bytes = hostEncoding.hexDecode(source);
          else if (normalized === "utf8") bytes = hostEncoding.utf8Encode(source);
          else throw new TypeError("Unsupported Buffer encoding: " + encoding);
        } else {
          bytes = hostEncoding.copy(source);
        }
        return decorate(bytes);
    };
    BufferCompat.isBuffer = (value) => value?.[marker] === true;
    globalThis.Buffer = Object.freeze(BufferCompat);
  })()`)
	if err != nil {
		return fmt.Errorf("install Workers encoding compatibility: %w", err)
	}
	return nil
}
