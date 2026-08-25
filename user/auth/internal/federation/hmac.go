package federation

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	HeaderClientID  = "X-LightVela-Client-Id"
	HeaderKeyID     = "X-LightVela-Key-Id"
	HeaderTimestamp = "X-LightVela-Timestamp"
	HeaderRequestID = "X-LightVela-Request-Id"
	HeaderSignature = "X-LightVela-Signature"
)

var (
	ErrInvalidSignature = errors.New("invalid federation signature")
	requestIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
)

type RequestIdentity struct {
	ClientID  string
	KeyID     string
	RequestID string
}

type Verifier struct {
	registry *Registry
	maxSkew  time.Duration
}

func NewVerifier(registry *Registry, maxSkew time.Duration) *Verifier {
	return &Verifier{registry: registry, maxSkew: maxSkew}
}

func CanonicalString(clientID, keyID, method, path string, query url.Values, timestamp, requestID string, body []byte) string {
	hash := sha256.Sum256(body)
	return strings.Join([]string{
		clientID,
		keyID,
		strings.ToUpper(method),
		path,
		query.Encode(),
		timestamp,
		requestID,
		hex.EncodeToString(hash[:]),
	}, "\n")
}

func (v *Verifier) Verify(req *http.Request, body []byte, now time.Time) (RequestIdentity, error) {
	clientID := strings.TrimSpace(req.Header.Get(HeaderClientID))
	keyID := strings.TrimSpace(req.Header.Get(HeaderKeyID))
	timestampRaw := strings.TrimSpace(req.Header.Get(HeaderTimestamp))
	requestID := strings.TrimSpace(req.Header.Get(HeaderRequestID))
	signatureRaw := strings.TrimSpace(req.Header.Get(HeaderSignature))
	client, ok := v.registry.Client(clientID)
	if !ok || !requestIDPattern.MatchString(requestID) {
		return RequestIdentity{}, ErrInvalidSignature
	}
	secret, ok := client.HMACKeys[keyID]
	if !ok {
		return RequestIdentity{}, ErrInvalidSignature
	}
	timestamp, err := time.Parse(time.RFC3339, timestampRaw)
	if err != nil || now.Sub(timestamp) > v.maxSkew || timestamp.Sub(now) > v.maxSkew {
		return RequestIdentity{}, ErrInvalidSignature
	}
	signature, err := base64.RawURLEncoding.DecodeString(signatureRaw)
	if err != nil {
		return RequestIdentity{}, ErrInvalidSignature
	}
	query, err := url.ParseQuery(req.URL.RawQuery)
	if err != nil {
		return RequestIdentity{}, ErrInvalidSignature
	}
	canonical := CanonicalString(clientID, keyID, req.Method, req.URL.EscapedPath(), query, timestampRaw, requestID, body)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return RequestIdentity{}, ErrInvalidSignature
	}
	return RequestIdentity{ClientID: clientID, KeyID: keyID, RequestID: requestID}, nil
}
