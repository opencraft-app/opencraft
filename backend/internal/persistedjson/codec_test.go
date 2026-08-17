package persistedjson

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type fixture struct {
	ID string `json:"id"`
}

func TestEnvelopeRoundTripAndStrictLegacyRead(t *testing.T) {
	encoded, err := Encode(fixture{ID: "one"})
	if err != nil || !strings.Contains(encoded, `"schemaVersion":1`) {
		t.Fatalf("Encode() = (%q, %v)", encoded, err)
	}
	for _, test := range []struct {
		raw        string
		wantLegacy bool
	}{
		{raw: encoded},
		{raw: `{"id":"legacy"}`, wantLegacy: true},
	} {
		var value fixture
		legacy, err := Decode(test.raw, &value)
		if err != nil || legacy != test.wantLegacy || value.ID == "" {
			t.Fatalf("Decode(%q) = (%#v, %v, %v)", test.raw, value, legacy, err)
		}
	}
	for _, raw := range []string{
		`{"schemaVersion":2,"payload":{"id":"x"}}`,
		`{"schemaVersion":1,"payload":{"id":"x","extra":1}}`,
		`{"schemaVersion":1,"payload":{"id":"x"}} {}`,
		`{"id":"x","extra":1}`,
	} {
		if _, err := Decode(raw, &fixture{}); err == nil {
			t.Errorf("Decode(%q) did not fail", raw)
		}
	}
}

func TestSnapshotAndScopeRegistriesFailClosed(t *testing.T) {
	encoded, err := EncodeSnapshot("tat", "tat.computer.refresh", fixture{ID: "one"})
	if err != nil {
		t.Fatal(err)
	}
	var value fixture
	if _, err := DecodeSnapshot(encoded, "tat", "tat.computer.refresh", &value); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeSnapshot(encoded, "im", "im.identity.ensure", &value); err == nil {
		t.Fatal("snapshot binding mismatch accepted")
	}
	if _, err := EncodeScoped("unknown.scope", value); err == nil {
		t.Fatal("unknown idempotency scope accepted")
	}
}

func TestProfileCapabilitiesCodecRejectsOversizedEnvelope(t *testing.T) {
	oversized := struct {
		Value string `json:"value"`
	}{Value: strings.Repeat("x", 2*1024*1024)}
	if _, err := EncodeProfileCapabilities(oversized); err == nil {
		t.Fatal("oversized Profile capability payload was encoded")
	}
	if _, err := DecodeProfileCapabilities(
		`{"schemaVersion":1,"payload":{"value":"`+
			strings.Repeat("x", 2*1024*1024)+`"}}`,
		&oversized,
	); err == nil {
		t.Fatal("oversized Profile capability envelope was decoded")
	}
}

func TestProfileCapabilitiesPayloadRoundTripsSnapshotAndInvalidation(t *testing.T) {
	payload := ProfileCapabilitiesPayload{
		SchemaVersion:          1,
		Snapshot:               json.RawMessage(`{"schemaVersion":1,"status":"succeeded"}`),
		InvalidationGeneration: 2,
		Invalidations: []ProfileCapabilityInvalidation{{
			EventID:    "01989c24-7540-7f12-a27b-c83243215dd9",
			Generation: 2, RuntimeContextGeneration: 3, EventSequence: 4,
			Reason:     "runtime_reported_change",
			ObservedAt: time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC),
		}},
	}
	encoded, err := EncodeProfileCapabilities(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ProfileCapabilitiesPayload
	if _, err := DecodeProfileCapabilities(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion != 1 || decoded.InvalidationGeneration != 2 ||
		len(decoded.Invalidations) != 1 || decoded.Invalidations[0].EventSequence != 4 {
		t.Fatalf("decoded payload = %#v", decoded)
	}
}
