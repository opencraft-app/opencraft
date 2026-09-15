package policy

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"hash"
	"strconv"

	goja "hypernode/internal/policy/jsvm"
)

const hostCryptoBufferLimit = 8 * 1024 * 1024

func checkedHostCryptoBytes(data []byte, name string) ([]byte, error) {
	if len(data) > hostCryptoBufferLimit {
		return nil, fmt.Errorf("%s exceeds host crypto buffer limit", name)
	}
	return data, nil
}

func hostCryptoUint8Array(vm *goja.Runtime, data []byte) (goja.Value, error) {
	return vm.NewUint8Array(data), nil
}

type hostCryptoBridge struct {
	vm      *goja.Runtime
	nextID  uint64
	hashes  map[string]hash.Hash
	ciphers map[string]cipher.Stream
}

func newHostCryptoBridge(vm *goja.Runtime) *hostCryptoBridge {
	return &hostCryptoBridge{
		vm: vm, hashes: make(map[string]hash.Hash), ciphers: make(map[string]cipher.Stream),
	}
}

func (b *hostCryptoBridge) id(prefix string) string {
	b.nextID++
	return prefix + strconv.FormatUint(b.nextID, 10)
}

func installHostCrypto(vm *goja.Runtime) error {
	bridge := newHostCryptoBridge(vm)
	object := vm.NewObject()
	if err := object.Set("__createHash", func(algorithm string) (string, error) {
		if algorithm != "sha256" {
			return "", fmt.Errorf("unsupported hash algorithm")
		}
		id := bridge.id("hash-")
		bridge.hashes[id] = sha256.New()
		return id, nil
	}); err != nil {
		return err
	}
	if err := object.Set("__createHmac", func(algorithm string, key []byte) (string, error) {
		if algorithm != "sha256" {
			return "", fmt.Errorf("unsupported HMAC algorithm")
		}
		key, err := checkedHostCryptoBytes(key, "HMAC key")
		if err != nil {
			return "", err
		}
		id := bridge.id("hash-")
		bridge.hashes[id] = hmac.New(sha256.New, key)
		return id, nil
	}); err != nil {
		return err
	}
	if err := object.Set("__hashUpdate", func(id string, data []byte) error {
		state := bridge.hashes[id]
		if state == nil {
			return fmt.Errorf("crypto digest is already finalized")
		}
		data, err := checkedHostCryptoBytes(data, "digest input")
		if err != nil {
			return err
		}
		_, _ = state.Write(data)
		return nil
	}); err != nil {
		return err
	}
	if err := object.Set("__hashDigest", func(id string) (goja.Value, error) {
		state := bridge.hashes[id]
		if state == nil {
			return nil, fmt.Errorf("crypto digest is already finalized")
		}
		delete(bridge.hashes, id)
		return hostCryptoUint8Array(vm, state.Sum(nil))
	}); err != nil {
		return err
	}
	if err := object.Set("__createCipher", func(algorithm string, key, iv []byte) (string, error) {
		stream, err := newHostCipherState(algorithm, key, iv)
		if err != nil {
			return "", err
		}
		id := bridge.id("cipher-")
		bridge.ciphers[id] = stream
		return id, nil
	}); err != nil {
		return err
	}
	if err := object.Set("__cipherUpdate", func(id string, input []byte) (goja.Value, error) {
		stream := bridge.ciphers[id]
		if stream == nil {
			return nil, fmt.Errorf("cipher is closed")
		}
		input, err := checkedHostCryptoBytes(input, "cipher input")
		if err != nil {
			return nil, err
		}
		output := make([]byte, len(input))
		stream.XORKeyStream(output, input)
		return hostCryptoUint8Array(vm, output)
	}); err != nil {
		return err
	}
	if err := object.Set("__cipherClose", func(id string) {
		delete(bridge.ciphers, id)
	}); err != nil {
		return err
	}
	if err := object.Set("x25519", func(privateMaterial, publicMaterial []byte) (goja.Value, error) {
		privateMaterial, err := checkedHostCryptoBytes(privateMaterial, "X25519 private key")
		if err != nil {
			return nil, err
		}
		publicMaterial, err = checkedHostCryptoBytes(publicMaterial, "X25519 public key")
		if err != nil {
			return nil, err
		}
		curve := ecdh.X25519()
		privateKey, err := curve.NewPrivateKey(privateMaterial)
		if err != nil {
			return nil, fmt.Errorf("invalid X25519 private key: %w", err)
		}
		publicKey, err := curve.NewPublicKey(publicMaterial)
		if err != nil {
			return nil, fmt.Errorf("invalid X25519 public key: %w", err)
		}
		shared, err := privateKey.ECDH(publicKey)
		if err != nil {
			return nil, fmt.Errorf("X25519 failed: %w", err)
		}
		return hostCryptoUint8Array(vm, shared)
	}); err != nil {
		return err
	}
	if err := object.Set("ed25519Sign", func(privateMaterial, data []byte) (goja.Value, error) {
		privateMaterial, err := checkedHostCryptoBytes(privateMaterial, "Ed25519 private key")
		if err != nil {
			return nil, err
		}
		data, err = checkedHostCryptoBytes(data, "Ed25519 data")
		if err != nil {
			return nil, err
		}
		var privateKey ed25519.PrivateKey
		switch len(privateMaterial) {
		case ed25519.SeedSize:
			privateKey = ed25519.NewKeyFromSeed(privateMaterial)
		case ed25519.PrivateKeySize:
			privateKey = ed25519.PrivateKey(privateMaterial)
		default:
			return nil, fmt.Errorf("Ed25519 private key must be 32 or 64 bytes")
		}
		return hostCryptoUint8Array(vm, ed25519.Sign(privateKey, data))
	}); err != nil {
		return err
	}
	if err := object.Set("ed25519Verify", func(publicKey, data, signature []byte) (bool, error) {
		publicKey, err := checkedHostCryptoBytes(publicKey, "Ed25519 public key")
		if err != nil {
			return false, err
		}
		data, err = checkedHostCryptoBytes(data, "Ed25519 data")
		if err != nil {
			return false, err
		}
		signature, err = checkedHostCryptoBytes(signature, "Ed25519 signature")
		if err != nil {
			return false, err
		}
		if len(publicKey) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize {
			return false, nil
		}
		return ed25519.Verify(ed25519.PublicKey(publicKey), data, signature), nil
	}); err != nil {
		return err
	}
	if err := object.Set("randomBytes", func(size int) (goja.Value, error) {
		if size < 1 || size > 4096 {
			return nil, fmt.Errorf("randomBytes size out of range")
		}
		data := make([]byte, size)
		if _, err := rand.Read(data); err != nil {
			return nil, err
		}
		return hostCryptoUint8Array(vm, data)
	}); err != nil {
		return err
	}
	if err := object.Set("timingSafeEqual", func(left, right []byte) (bool, error) {
		left, err := checkedHostCryptoBytes(left, "left buffer")
		if err != nil {
			return false, err
		}
		right, err = checkedHostCryptoBytes(right, "right buffer")
		if err != nil {
			return false, err
		}
		if len(left) != len(right) {
			return false, nil
		}
		return subtle.ConstantTimeCompare(left, right) == 1, nil
	}); err != nil {
		return err
	}
	if err := vm.Set("hostCrypto", object); err != nil {
		return err
	}
	// Stateful hashes and ciphers use stable native entrypoints plus ordinary JS
	// facades. Allocating Go callbacks for every SSH packet would eventually hit
	// QuickJS's 16-bit C-function magic limit just like the old SQLite cursor.
	bootstrap, err := vm.RunString(`(() => {
		const native = {
			createHash: hostCrypto.__createHash,
			createHmac: hostCrypto.__createHmac,
			hashUpdate: hostCrypto.__hashUpdate,
			hashDigest: hostCrypto.__hashDigest,
			createCipher: hostCrypto.__createCipher,
			cipherUpdate: hostCrypto.__cipherUpdate,
			cipherClose: hostCrypto.__cipherClose,
		};
		const hash = (id) => {
			const value = {
				update(data) { native.hashUpdate(id, data); return value; },
				digest() { return native.hashDigest(id); },
			};
			return value;
		};
		hostCrypto.createHash = (algorithm) => hash(native.createHash(algorithm));
		hostCrypto.createHmac = (algorithm, key) => hash(native.createHmac(algorithm, key));
		const cipher = (id) => ({
			update(data) { return native.cipherUpdate(id, data); },
			close() { native.cipherClose(id); },
		});
		hostCrypto.createCipheriv = (algorithm, key, iv) => cipher(native.createCipher(algorithm, key, iv));
		hostCrypto.createDecipheriv = (algorithm, key, iv) => cipher(native.createCipher(algorithm, key, iv));
		for (const name of Object.keys(hostCrypto)) {
			if (name.startsWith("__")) delete hostCrypto[name];
		}
	})()`)
	if err != nil {
		return fmt.Errorf("install host crypto facade: %w", err)
	}
	bootstrap.Free()
	return nil
}

func newHostCipherState(algorithm string, key, iv []byte) (cipher.Stream, error) {
	if algorithm != "aes-128-ctr" {
		return nil, fmt.Errorf("unsupported cipher algorithm")
	}
	key, err := checkedHostCryptoBytes(key, "cipher key")
	if err != nil {
		return nil, err
	}
	iv, err = checkedHostCryptoBytes(iv, "cipher IV")
	if err != nil {
		return nil, err
	}
	if len(key) != 16 || len(iv) != aes.BlockSize {
		return nil, fmt.Errorf("aes-128-ctr requires a 16-byte key and IV")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewCTR(block, iv), nil
}
