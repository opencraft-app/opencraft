package meshharness

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
)

var (
	ErrCOSNotFound = errors.New("COS object not found on this access path")
	ErrCOSTimeout  = errors.New("COS request timed out with an uncertain result")
	ErrCOSCorrupt  = errors.New("COS returned corrupt bytes")
)

type COSRequest struct {
	Operation  string
	AccessPath string
	Key        string
	Result     string
}

// COSEmulator keeps immutable object truth separate from per-access-path
// observations. Scripts model Tencent COS propagation, timeout and corruption
// without making LIST an authority.
type COSEmulator struct {
	mu      sync.Mutex
	objects map[string][]byte
	scripts map[string][]error
	history []COSRequest
}

func NewCOSEmulator() *COSEmulator {
	return &COSEmulator{objects: map[string][]byte{}, scripts: map[string][]error{}}
}

func (e *COSEmulator) Put(key string, value []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if current, exists := e.objects[key]; exists && !bytes.Equal(current, value) {
		return fmt.Errorf("immutable COS key %q was overwritten", key)
	}
	e.objects[key] = bytes.Clone(value)
	e.history = append(e.history, COSRequest{Operation: "PUT", Key: key, Result: "OK"})
	return nil
}

func (e *COSEmulator) Script(accessPath, key string, results ...error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.scripts[accessPath+"\x00"+key] = append([]error(nil), results...)
}

func (e *COSEmulator) Head(accessPath, key string) ([32]byte, error) {
	value, err := e.get("HEAD", accessPath, key)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(value), nil
}

func (e *COSEmulator) Get(accessPath, key string) ([]byte, error) {
	return e.get("GET", accessPath, key)
}

func (e *COSEmulator) get(operation, accessPath, key string) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	scriptKey := accessPath + "\x00" + key
	var scripted error
	if queue := e.scripts[scriptKey]; len(queue) > 0 {
		scripted = queue[0]
		e.scripts[scriptKey] = queue[1:]
	}
	value, exists := e.objects[key]
	if !exists && scripted == nil {
		scripted = ErrCOSNotFound
	}
	result := "OK"
	if scripted != nil {
		result = scripted.Error()
	}
	e.history = append(e.history, COSRequest{Operation: operation, AccessPath: accessPath, Key: key, Result: result})
	if scripted == ErrCOSCorrupt && exists {
		corrupt := bytes.Clone(value)
		if len(corrupt) > 0 {
			corrupt[0] ^= 0xff
		}
		return corrupt, nil
	}
	if scripted != nil {
		return nil, scripted
	}
	return bytes.Clone(value), nil
}

func (e *COSEmulator) History() []COSRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]COSRequest(nil), e.history...)
}
