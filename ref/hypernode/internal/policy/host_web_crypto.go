package policy

import (
	"crypto/sha256"
	"fmt"
	"sync"
	"sync/atomic"

	goja "hypernode/internal/policy/jsvm"
)

const maxWebCryptoJobs = 4096

type webCryptoResult struct {
	ID    string `json:"id"`
	Bytes []byte `json:"bytes,omitempty"`
	Error string `json:"error,omitempty"`
}

// webCryptoBridge is an engine-neutral asynchronous crypto completion queue.
// Workers-style JavaScript lives in policy/src/runtime/web-crypto.js; Go only
// performs bounded native work and wakes the serialized QuickJS event pump.
type webCryptoBridge struct {
	next    atomic.Uint64
	notify  func()
	mu      sync.Mutex
	pending int
	results []webCryptoResult
}

func installHostWebCrypto(vm *goja.Runtime, notify func()) error {
	bridge := &webCryptoBridge{notify: notify}
	object := vm.NewObject()
	if err := object.Set("submitDigest", bridge.submitDigest); err != nil {
		return err
	}
	if err := object.Set("drain", bridge.drain); err != nil {
		return err
	}
	return vm.Set("hostWebCrypto", object)
}

func (b *webCryptoBridge) submitDigest(algorithm string, input []byte) (string, error) {
	if algorithm != "SHA-256" && algorithm != "sha-256" && algorithm != "sha256" {
		return "", fmt.Errorf("unsupported digest algorithm: %s", algorithm)
	}
	if len(input) > hostCryptoBufferLimit {
		return "", fmt.Errorf("digest input exceeds host crypto buffer limit")
	}
	b.mu.Lock()
	if b.pending >= maxWebCryptoJobs {
		b.mu.Unlock()
		return "", fmt.Errorf("web crypto queue is full")
	}
	b.pending++
	b.mu.Unlock()
	id := fmt.Sprintf("digest-%d", b.next.Add(1))
	data := append([]byte(nil), input...)
	go func() {
		digest := sha256.Sum256(data)
		b.mu.Lock()
		b.pending--
		b.results = append(b.results, webCryptoResult{ID: id, Bytes: append([]byte(nil), digest[:]...)})
		b.mu.Unlock()
		if b.notify != nil {
			b.notify()
		}
	}()
	return id, nil
}

func (b *webCryptoBridge) drain() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	results := b.results
	b.results = nil
	projected := make([]map[string]any, 0, len(results))
	for _, result := range results {
		projected = append(projected, map[string]any{
			"id":    result.ID,
			"bytes": append([]byte(nil), result.Bytes...),
			"error": result.Error,
		})
	}
	return projected
}
