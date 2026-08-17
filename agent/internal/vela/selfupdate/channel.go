package selfupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maximumChannelEnvelopeBytes = 16 * 1024

var (
	ErrChannelInvalid   = errors.New("Computer Update channel 无效")
	ErrChannelUntrusted = errors.New("Computer Update channel 签名不可信")
	versionPattern      = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$`)
	keyIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type VerifyChannelConfig struct {
	Channel   string
	Target    string
	KeyID     string
	PublicKey ed25519.PublicKey
	Now       time.Time
}

type ChannelDescriptor struct {
	SchemaVersion   int
	Channel         string
	Target          string
	Sequence        int64
	ExpectedVersion string
	CatalogSHA256   [sha256.Size]byte
	IssuedAt        time.Time
}

type ChannelDownloads struct {
	CatalogURL           string
	ManifestURL          string
	ManifestSignatureURL string
	ProgramURL           string
	ExpiresAt            time.Time
}

type VerifiedChannel struct {
	Descriptor    ChannelDescriptor
	Downloads     ChannelDownloads
	Payload       []byte
	PayloadSHA256 [sha256.Size]byte
}

type channelEnvelopeDocument struct {
	SchemaVersion int    `json:"schemaVersion"`
	Payload       string `json:"payload"`
	Signature     struct {
		Algorithm string `json:"algorithm"`
		KeyID     string `json:"keyId"`
		Value     string `json:"value"`
	} `json:"signature"`
	Downloads struct {
		CatalogURL           string `json:"catalogUrl"`
		ManifestURL          string `json:"manifestUrl"`
		ManifestSignatureURL string `json:"manifestSignatureUrl"`
		ProgramURL           string `json:"programUrl"`
		ExpiresAt            string `json:"expiresAt"`
	} `json:"downloads"`
}

type channelDescriptorDocument struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Channel         string `json:"channel"`
	Target          string `json:"target"`
	Sequence        int64  `json:"sequence"`
	ExpectedVersion string `json:"expectedVersion"`
	CatalogSHA256   string `json:"catalogSHA256"`
	IssuedAt        string `json:"issuedAt"`
}

func VerifyChannelEnvelope(raw []byte, config VerifyChannelConfig) (VerifiedChannel, error) {
	if len(raw) == 0 || len(raw) > maximumChannelEnvelopeBytes ||
		(config.Channel != "stable" && config.Channel != "canary") ||
		(config.Target != "darwin-arm64" && config.Target != "linux-amd64") ||
		!keyIDPattern.MatchString(config.KeyID) || len(config.PublicKey) != ed25519.PublicKeySize ||
		config.Now.IsZero() {
		return VerifiedChannel{}, ErrChannelInvalid
	}
	var envelope channelEnvelopeDocument
	if err := decodeExactJSON(raw, &envelope); err != nil || envelope.SchemaVersion != 1 ||
		envelope.Signature.Algorithm != "ed25519" || envelope.Signature.KeyID != config.KeyID {
		return VerifiedChannel{}, ErrChannelInvalid
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil || len(payload) == 0 || len(payload) > 3*1024 {
		return VerifiedChannel{}, ErrChannelInvalid
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(config.PublicKey, payload, signature) {
		return VerifiedChannel{}, ErrChannelUntrusted
	}
	var document channelDescriptorDocument
	if err := decodeExactJSON(payload, &document); err != nil {
		return VerifiedChannel{}, ErrChannelInvalid
	}
	canonical, err := json.Marshal(document)
	if err != nil || !bytes.Equal(canonical, payload) {
		return VerifiedChannel{}, ErrChannelInvalid
	}
	descriptor, err := descriptorFromDocument(document, config)
	if err != nil {
		return VerifiedChannel{}, err
	}
	downloads, err := downloadsFromDocument(envelope.Downloads, config.Now.UTC())
	if err != nil {
		return VerifiedChannel{}, err
	}
	return VerifiedChannel{
		Descriptor: descriptor, Downloads: downloads,
		Payload: append([]byte(nil), payload...), PayloadSHA256: sha256.Sum256(payload),
	}, nil
}

func descriptorFromDocument(
	document channelDescriptorDocument,
	config VerifyChannelConfig,
) (ChannelDescriptor, error) {
	catalogDigest, err := hex.DecodeString(document.CatalogSHA256)
	if err != nil || len(catalogDigest) != sha256.Size ||
		hex.EncodeToString(catalogDigest) != document.CatalogSHA256 {
		return ChannelDescriptor{}, ErrChannelInvalid
	}
	issuedAt, err := time.Parse(time.RFC3339Nano, document.IssuedAt)
	if err != nil || document.IssuedAt != issuedAt.UTC().Format(time.RFC3339Nano) ||
		issuedAt.After(config.Now.UTC().Add(5*time.Minute)) {
		return ChannelDescriptor{}, ErrChannelInvalid
	}
	if document.SchemaVersion != 1 || document.Channel != config.Channel ||
		document.Target != config.Target || document.Sequence < 1 ||
		!versionPattern.MatchString(document.ExpectedVersion) {
		return ChannelDescriptor{}, ErrChannelInvalid
	}
	var digest [sha256.Size]byte
	copy(digest[:], catalogDigest)
	return ChannelDescriptor{
		SchemaVersion: document.SchemaVersion, Channel: document.Channel,
		Target: document.Target, Sequence: document.Sequence,
		ExpectedVersion: document.ExpectedVersion, CatalogSHA256: digest,
		IssuedAt: issuedAt.UTC(),
	}, nil
}

func downloadsFromDocument(
	document struct {
		CatalogURL           string `json:"catalogUrl"`
		ManifestURL          string `json:"manifestUrl"`
		ManifestSignatureURL string `json:"manifestSignatureUrl"`
		ProgramURL           string `json:"programUrl"`
		ExpiresAt            string `json:"expiresAt"`
	},
	now time.Time,
) (ChannelDownloads, error) {
	expiresAt, err := time.Parse(time.RFC3339Nano, document.ExpiresAt)
	if err != nil || document.ExpiresAt != expiresAt.UTC().Format(time.RFC3339Nano) ||
		!expiresAt.After(now) || expiresAt.After(now.Add(15*time.Minute)) {
		return ChannelDownloads{}, ErrChannelInvalid
	}
	for _, value := range []string{
		document.CatalogURL, document.ManifestURL,
		document.ManifestSignatureURL, document.ProgramURL,
	} {
		if !validDownloadURL(value) {
			return ChannelDownloads{}, ErrChannelInvalid
		}
	}
	return ChannelDownloads{
		CatalogURL: document.CatalogURL, ManifestURL: document.ManifestURL,
		ManifestSignatureURL: document.ManifestSignatureURL,
		ProgramURL:           document.ProgramURL, ExpiresAt: expiresAt.UTC(),
	}, nil
}

func validDownloadURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil ||
		parsed.Hostname() == "" || parsed.Fragment != "" || len(raw) > 4096 ||
		strings.ContainsAny(raw, "\r\n\x00") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, ".myqcloud.com") ||
		strings.HasSuffix(host, ".tencentcloudapi.com")
}

func decodeExactJSON(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrChannelInvalid
	}
	return nil
}
