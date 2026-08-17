// Package computerupdate implements the signed Computer Release Channel core.
package computerupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"
)

var (
	ErrInvalidDescriptor = errors.New("Computer Release Channel descriptor 无效")
	ErrInvalidSignature  = errors.New("Computer Release Channel signature 无效")
	versionPattern       = regexp.MustCompile(
		`^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$`,
	)
	keyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type ChannelDescriptor struct {
	SchemaVersion   int
	Channel         string
	Target          string
	Sequence        int64
	ExpectedVersion string
	CatalogSHA256   []byte
	IssuedAt        time.Time
}

type ChannelSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type SignedDescriptor struct {
	SchemaVersion int              `json:"schemaVersion"`
	Payload       string           `json:"payload"`
	Signature     ChannelSignature `json:"signature"`
}

type descriptorDocument struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Channel         string `json:"channel"`
	Target          string `json:"target"`
	Sequence        int64  `json:"sequence"`
	ExpectedVersion string `json:"expectedVersion"`
	CatalogSHA256   string `json:"catalogSHA256"`
	IssuedAt        string `json:"issuedAt"`
}

func ValidateDescriptor(value ChannelDescriptor) error {
	if value.SchemaVersion != 1 ||
		(value.Channel != "stable" && value.Channel != "canary") ||
		(value.Target != "darwin-arm64" && value.Target != "linux-amd64") ||
		value.Sequence < 1 ||
		!versionPattern.MatchString(value.ExpectedVersion) ||
		len(value.CatalogSHA256) != sha256.Size ||
		value.IssuedAt.IsZero() ||
		!value.IssuedAt.Equal(value.IssuedAt.UTC()) {
		return ErrInvalidDescriptor
	}
	return nil
}

func SignDescriptor(
	value ChannelDescriptor,
	keyID string,
	privateKey ed25519.PrivateKey,
) (SignedDescriptor, error) {
	if err := ValidateDescriptor(value); err != nil ||
		!keyIDPattern.MatchString(keyID) ||
		len(privateKey) != ed25519.PrivateKeySize {
		return SignedDescriptor{}, ErrInvalidDescriptor
	}
	payload, err := json.Marshal(documentFromDescriptor(value))
	if err != nil {
		return SignedDescriptor{}, ErrInvalidDescriptor
	}
	signature := ed25519.Sign(privateKey, payload)
	return SignedDescriptor{
		SchemaVersion: 1,
		Payload:       base64.RawURLEncoding.EncodeToString(payload),
		Signature: ChannelSignature{
			Algorithm: "ed25519",
			KeyID:     keyID,
			Value:     base64.RawURLEncoding.EncodeToString(signature),
		},
	}, nil
}

func VerifySignedDescriptor(
	signed SignedDescriptor,
	trustedKeys map[string]ed25519.PublicKey,
	expectedChannel string,
	expectedTarget string,
) (ChannelDescriptor, []byte, error) {
	if signed.SchemaVersion != 1 || signed.Signature.Algorithm != "ed25519" ||
		!keyIDPattern.MatchString(signed.Signature.KeyID) {
		return ChannelDescriptor{}, nil, ErrInvalidSignature
	}
	publicKey := trustedKeys[signed.Signature.KeyID]
	if len(publicKey) != ed25519.PublicKeySize {
		return ChannelDescriptor{}, nil, ErrInvalidSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(signed.Payload)
	if err != nil || len(payload) == 0 || len(payload) > 3*1024 {
		return ChannelDescriptor{}, nil, ErrInvalidSignature
	}
	signature, err := base64.RawURLEncoding.DecodeString(signed.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(publicKey, payload, signature) {
		return ChannelDescriptor{}, nil, ErrInvalidSignature
	}
	var document descriptorDocument
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	if err := requireJSONEOF(decoder); err != nil {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	canonical, err := json.Marshal(document)
	if err != nil || !bytes.Equal(canonical, payload) {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	value, err := descriptorFromDocument(document)
	if err != nil || value.Channel != expectedChannel || value.Target != expectedTarget {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	digest := sha256.Sum256(payload)
	return value, append([]byte(nil), digest[:]...), nil
}

func documentFromDescriptor(value ChannelDescriptor) descriptorDocument {
	return descriptorDocument{
		SchemaVersion: value.SchemaVersion,
		Channel:       value.Channel, Target: value.Target,
		Sequence: value.Sequence, ExpectedVersion: value.ExpectedVersion,
		CatalogSHA256: hex.EncodeToString(value.CatalogSHA256),
		IssuedAt:      value.IssuedAt.UTC().Format(time.RFC3339Nano),
	}
}

func descriptorFromDocument(document descriptorDocument) (ChannelDescriptor, error) {
	digest, err := hex.DecodeString(document.CatalogSHA256)
	if err != nil || len(digest) != sha256.Size ||
		hex.EncodeToString(digest) != document.CatalogSHA256 {
		return ChannelDescriptor{}, ErrInvalidDescriptor
	}
	issuedAt, err := time.Parse(time.RFC3339Nano, document.IssuedAt)
	if err != nil || document.IssuedAt != issuedAt.UTC().Format(time.RFC3339Nano) {
		return ChannelDescriptor{}, ErrInvalidDescriptor
	}
	value := ChannelDescriptor{
		SchemaVersion: document.SchemaVersion,
		Channel:       document.Channel, Target: document.Target,
		Sequence: document.Sequence, ExpectedVersion: document.ExpectedVersion,
		CatalogSHA256: digest, IssuedAt: issuedAt.UTC(),
	}
	if err := ValidateDescriptor(value); err != nil {
		return ChannelDescriptor{}, err
	}
	return value, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrInvalidDescriptor
	}
	return nil
}
