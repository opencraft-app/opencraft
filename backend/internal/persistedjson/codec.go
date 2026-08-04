// Package persistedjson owns every JSON document stored in business tables.
// It deliberately separates durable schemas from transient HTTP JSON.
package persistedjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const SchemaVersion = 1

type envelope struct {
	SchemaVersion int             `json:"schemaVersion"`
	Payload       json.RawMessage `json:"payload"`
}

type snapshotEnvelope struct {
	SchemaVersion int             `json:"schemaVersion"`
	Service       string          `json:"service"`
	Kind          string          `json:"kind"`
	Payload       json.RawMessage `json:"payload"`
}

// Encode writes the canonical v1 envelope used by message references.
func Encode(payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(envelope{SchemaVersion: SchemaVersion, Payload: raw})
	return string(encoded), err
}

// Decode accepts a strict v1 envelope or the exact legacy payload shape.
// The returned legacy flag lets consistency tooling report rows awaiting a
// natural rewrite without mutating them during an unrelated update.
func Decode(raw string, destination any) (legacy bool, err error) {
	if strings.TrimSpace(raw) == "" || destination == nil {
		return false, errors.New("持久 JSON 不能为空")
	}
	var probe map[string]json.RawMessage
	if err := strictDecode([]byte(raw), &probe); err != nil {
		return false, err
	}
	if _, versioned := probe["schemaVersion"]; !versioned {
		return true, strictDecode([]byte(raw), destination)
	}
	var value envelope
	if err := strictDecode([]byte(raw), &value); err != nil {
		return false, err
	}
	if value.SchemaVersion != SchemaVersion {
		return false, fmt.Errorf("未知持久 JSON schemaVersion %d", value.SchemaVersion)
	}
	if len(value.Payload) == 0 || bytes.Equal(value.Payload, []byte("null")) {
		return false, errors.New("持久 JSON payload 不能为空")
	}
	return false, strictDecode(value.Payload, destination)
}

// EncodeSnapshot writes a service/kind-bound operation snapshot.
func EncodeSnapshot(service, kind string, payload any) (string, error) {
	if !KnownOperation(service, kind) {
		return "", fmt.Errorf("未注册的 operation snapshot：%s/%s", service, kind)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(snapshotEnvelope{
		SchemaVersion: SchemaVersion,
		Service:       service,
		Kind:          kind,
		Payload:       raw,
	})
	return string(encoded), err
}

// DecodeSnapshot verifies the expected service/kind before decoding. Exact
// legacy payloads remain readable and are reported through legacy=true.
func DecodeSnapshot(raw, service, kind string, destination any) (legacy bool, err error) {
	if !KnownOperation(service, kind) {
		return false, fmt.Errorf("未注册的 operation snapshot：%s/%s", service, kind)
	}
	var probe map[string]json.RawMessage
	if err := strictDecode([]byte(raw), &probe); err != nil {
		return false, err
	}
	if _, versioned := probe["schemaVersion"]; !versioned {
		return true, strictDecode([]byte(raw), destination)
	}
	var value snapshotEnvelope
	if err := strictDecode([]byte(raw), &value); err != nil {
		return false, err
	}
	if value.SchemaVersion != SchemaVersion || value.Service != service || value.Kind != kind {
		return false, errors.New("operation snapshot 版本或绑定不匹配")
	}
	return false, strictDecode(value.Payload, destination)
}

// EncodeResultSnapshot writes the result column with the same immutable
// service/kind binding as the request snapshot. Keeping the column explicit
// prevents callers from accidentally decoding a request schema as a result.
func EncodeResultSnapshot(service, kind string, payload any) (string, error) {
	return EncodeSnapshot(service, kind, payload)
}

// DecodeResultSnapshot decodes a versioned result. The bootstrap operation is
// the only historical exception: before schemaVersion existed it stored an
// opaque encrypted string rather than JSON. It remains readable but is marked
// legacy so it is rewritten only by the next result update.
func DecodeResultSnapshot(raw, service, kind string, destination any) (legacy bool, err error) {
	if service == "computer-bootstrap" && kind == "tat.computer.bootstrap.registration" &&
		!strings.HasPrefix(strings.TrimSpace(raw), "{") {
		value, ok := destination.(*string)
		if !ok || strings.TrimSpace(raw) == "" {
			return false, errors.New("bootstrap result legacy payload 无效")
		}
		*value = raw
		return true, nil
	}
	return DecodeSnapshot(raw, service, kind, destination)
}

// Validate checks an envelope without coupling the consistency scanner to a
// business DTO. Business reads still use Decode with a concrete strict type.
func Validate(raw string) (legacy bool, err error) {
	var payload any
	return Decode(raw, &payload)
}

// ValidateSnapshot checks version and service/kind binding for persisted
// operation snapshots. Concrete repositories remain responsible for strict
// payload DTO decoding.
func ValidateSnapshot(raw, service, kind string) (legacy bool, err error) {
	var payload any
	return DecodeSnapshot(raw, service, kind, &payload)
}

// ValidateResultSnapshot is the result-column counterpart of ValidateSnapshot.
func ValidateResultSnapshot(raw, service, kind string) (legacy bool, err error) {
	var payload any
	if service == "computer-bootstrap" && kind == "tat.computer.bootstrap.registration" &&
		!strings.HasPrefix(strings.TrimSpace(raw), "{") {
		if strings.TrimSpace(raw) == "" {
			return false, errors.New("bootstrap result legacy payload 无效")
		}
		return true, nil
	}
	return DecodeSnapshot(raw, service, kind, &payload)
}

// EncodeScoped writes an idempotency response only for a registered scope.
func EncodeScoped(scope string, payload any) (string, error) {
	if !KnownScope(scope) {
		return "", fmt.Errorf("未注册的幂等 scope：%s", scope)
	}
	return Encode(payload)
}

// DecodeScoped verifies the scope registry and then applies strict decoding.
func DecodeScoped(raw, scope string, destination any) (legacy bool, err error) {
	if !KnownScope(scope) {
		return false, fmt.Errorf("未注册的幂等 scope：%s", scope)
	}
	return Decode(raw, destination)
}

func strictDecode(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("持久 JSON 包含 trailing data")
		}
		return err
	}
	return nil
}
