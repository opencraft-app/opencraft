package gateway

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestGenerateExternalKeyV2UsesFixedOpaqueFormat(t *testing.T) {
	random := make([]byte, externalKeyRandomBytes)
	for index := range random {
		random[index] = byte(index + 1)
	}

	material, err := generateExternalKeyV2(bytes.NewReader(random))
	if err != nil {
		t.Fatal(err)
	}
	if len(material.ExternalKey) != externalKeyTextLength {
		t.Fatalf("external key length = %d, want %d", len(material.ExternalKey), externalKeyTextLength)
	}
	if !strings.HasPrefix(material.ExternalKey, "sk-") || strings.Contains(material.ExternalKey, "lgw") {
		t.Fatalf("unexpected external key format %q", material.ExternalKey)
	}
	if material.Version != externalKeyVersionV2 {
		t.Fatalf("version = %d, want %d", material.Version, externalKeyVersionV2)
	}
	if material.RouteSlot != 0x01020304 {
		t.Fatalf("route slot = %#x, want %#x", material.RouteSlot, uint32(0x01020304))
	}
	if len(material.ExternalKeyID) != externalKeyIDTextLength {
		t.Fatalf("external key id length = %d, want %d", len(material.ExternalKeyID), externalKeyIDTextLength)
	}
	if material.SecretHash == "" || material.ExternalKeyHash != hashExternalKey(material.ExternalKey) {
		t.Fatalf("missing key hashes: %+v", material)
	}

	lookup := parseTrafficRouteLookup(material.ExternalKey)
	if !lookup.Valid || lookup.Version != externalKeyVersionV2 {
		t.Fatalf("generated key did not parse: %+v", lookup)
	}
	if lookup.RouteSlot != material.RouteSlot || lookup.ExternalKeyID != material.ExternalKeyID {
		t.Fatalf("parsed identity = %+v, material = %+v", lookup, material)
	}
	if lookup.SecretHash != material.SecretHash || lookup.ExternalKeyHash != material.ExternalKeyHash {
		t.Fatalf("parsed hashes = %+v, material = %+v", lookup, material)
	}
}

func TestGenerateExternalKeyV2FailsClosedWhenRandomSourceFails(t *testing.T) {
	reader := io.MultiReader(bytes.NewReader(make([]byte, externalKeyRandomBytes-1)), errorReader{})
	if _, err := generateExternalKeyV2(reader); err == nil {
		t.Fatal("expected random source failure")
	}
}

func TestPrepareAPIKeyReservationPreservesExternalKeyAndRemovesUpstreamMaterial(t *testing.T) {
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{9}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding, err := prepareAPIKeyReservation(APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyID: material.ExternalKeyID,
		ExternalKeyHash: material.ExternalKeyHash, SecretHash: material.SecretHash,
		KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		UpstreamKey: "sk-must-not-survive", UpstreamKeyID: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.ExternalKey != material.ExternalKey {
		t.Fatalf("reservation external key = %q, want persisted key", binding.ExternalKey)
	}
	if binding.UpstreamKey != "" || binding.UpstreamKeyID != 0 {
		t.Fatalf("reservation retained upstream material: %+v", binding)
	}
	if binding.Status != APIKeyStatusReserved || binding.ExternalKeyID != material.ExternalKeyID || binding.SecretHash != material.SecretHash {
		t.Fatalf("reservation lost route identity: %+v", binding)
	}
}

func TestValidateStoredExternalKeyRejectsMetadataMismatch(t *testing.T) {
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{5}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	valid := APIKeyBinding{
		ExternalKey:     material.ExternalKey,
		ExternalKeyHash: material.ExternalKeyHash,
		ExternalKeyID:   material.ExternalKeyID,
		SecretHash:      material.SecretHash,
		KeyVersion:      material.Version,
		RouteSlot:       material.RouteSlot,
	}
	if err := validateStoredExternalKey(valid); err != nil {
		t.Fatalf("valid stored key rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*APIKeyBinding)
	}{
		{name: "missing plaintext", mutate: func(binding *APIKeyBinding) { binding.ExternalKey = "" }},
		{name: "key id", mutate: func(binding *APIKeyBinding) { binding.ExternalKeyID = "wrong" }},
		{name: "key hash", mutate: func(binding *APIKeyBinding) { binding.ExternalKeyHash = strings.Repeat("0", 64) }},
		{name: "secret hash", mutate: func(binding *APIKeyBinding) { binding.SecretHash = strings.Repeat("1", 64) }},
		{name: "version", mutate: func(binding *APIKeyBinding) { binding.KeyVersion++ }},
		{name: "route slot", mutate: func(binding *APIKeyBinding) { binding.RouteSlot++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			binding := valid
			test.mutate(&binding)
			if err := validateStoredExternalKey(binding); err == nil {
				t.Fatalf("invalid binding accepted: %+v", binding)
			}
		})
	}
}

func TestParseTrafficRouteLookupRejectsUnsupportedAndMalformedKeys(t *testing.T) {
	valid, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{7}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(valid.ExternalKey, "sk-"))
	if err != nil {
		t.Fatal(err)
	}
	payload[0] = 3
	wrongVersion := "sk-" + base64.RawURLEncoding.EncodeToString(payload)

	for _, key := range []string{
		"sk-lgw-v1-ks-001.key-old.secret",
		"sk-short",
		"sk-" + strings.Repeat("!", externalKeyPayloadTextLength),
		wrongVersion,
		valid.ExternalKey + "x",
	} {
		if lookup := parseTrafficRouteLookup(key); lookup.Valid {
			t.Fatalf("invalid key %q parsed as %+v", key, lookup)
		}
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}
