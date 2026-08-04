package persistedjson

import (
	"strings"
	"testing"
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
