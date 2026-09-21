package policy

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"testing"

	goja "hypernode/internal/policy/jsvm"
)

func newHostCryptoTestVM(t *testing.T) *goja.Runtime {
	t.Helper()
	vm := goja.New()
	if err := installHostCrypto(vm); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vm.Close() })
	return vm
}

func TestHostCryptoHashHMACAndTypedArrays(t *testing.T) {
	vm := newHostCryptoTestVM(t)
	value, err := vm.RunString(`(() => {
        const input = new Uint8Array([97, 98, 99]);
        const digest = hostCrypto.createHash("sha256").update(input).digest();
        const mac = hostCrypto.createHmac("sha256", new Uint8Array([1, 2, 3])).update(input).digest();
        return [digest instanceof Uint8Array, digest, mac];
      })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result []any
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	if result[0] != true {
		t.Fatal("host crypto did not return Uint8Array")
	}
	digest := result[1].([]uint8)
	if got := hex.EncodeToString(digest); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("sha256=%s", got)
	}
	if len(result[2].([]uint8)) != 32 {
		t.Fatal("unexpected HMAC length")
	}
}

func TestHostCryptoAESCTRKnownVector(t *testing.T) {
	vm := newHostCryptoTestVM(t)
	value, err := vm.RunString(`(() => {
        const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (part) => parseInt(part, 16));
        const key = fromHex("2b7e151628aed2a6abf7158809cf4f3c");
        const iv = fromHex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
        const plain = fromHex("6bc1bee22e409f96e93d7e117393172a");
        const cipher = hostCrypto.createCipheriv("aes-128-ctr", key, iv);
        const first = cipher.update(plain.slice(0, 4));
        const second = cipher.update(plain.slice(4));
        const encrypted = new Uint8Array(plain.length);
        encrypted.set(first, 0);
        encrypted.set(second, first.length);
        const decrypted = hostCrypto.createDecipheriv("aes-128-ctr", key, iv).update(encrypted);
        return [encrypted, decrypted];
      })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result [][]byte
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(result[0]); got != "874d6191b620e3261bef6864990db6ce" {
		t.Fatalf("AES-CTR=%s", got)
	}
	if got := hex.EncodeToString(result[1]); got != "6bc1bee22e409f96e93d7e117393172a" {
		t.Fatalf("AES-CTR roundtrip=%s", got)
	}
}

func TestHostCryptoStateDoesNotExhaustQuickJSFunctionHandles(t *testing.T) {
	vm := newHostCryptoTestVM(t)
	value, err := vm.RunString(`(() => {
		const key = new Uint8Array([1, 2, 3]);
		const data = new Uint8Array([4, 5, 6]);
		let last;
		for (let index = 0; index < 20000; index++) {
			last = hostCrypto.createHmac("sha256", key).update(data).digest();
		}
		return last.length;
	})()`)
	if err != nil {
		t.Fatal(err)
	}
	defer value.Free()
	if value.Export() != int64(32) {
		t.Fatalf("unexpected final HMAC length: %#v", value.Export())
	}
}

func TestHostCryptoX25519AndEd25519(t *testing.T) {
	vm := newHostCryptoTestVM(t)
	curve := ecdh.X25519()
	left, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	right, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, edPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := vm.Set("leftPrivate", left.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := vm.Set("rightPublic", right.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := vm.Set("edPrivate", []byte(edPrivate)); err != nil {
		t.Fatal(err)
	}
	if err := vm.Set("edPublic", []byte(edPrivate.Public().(ed25519.PublicKey))); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`(() => {
        const message = new Uint8Array([4, 5, 6]);
        const shared = hostCrypto.x25519(leftPrivate, rightPublic);
        const signature = hostCrypto.ed25519Sign(edPrivate, message);
        return [shared, signature, hostCrypto.ed25519Verify(edPublic, message, signature)];
      })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result []any
	if err := vm.ExportTo(value, &result); err != nil {
		t.Fatal(err)
	}
	expected, err := left.ECDH(right.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(result[0].([]uint8)); got != hex.EncodeToString(expected) {
		t.Fatalf("X25519=%s", got)
	}
	if len(result[1].([]uint8)) != ed25519.SignatureSize || result[2] != true {
		t.Fatal("Ed25519 sign/verify failed")
	}
}
