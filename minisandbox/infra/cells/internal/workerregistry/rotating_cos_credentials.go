package workerregistry

import (
	"encoding/json"
	"errors"
	cos "github.com/tencentyun/cos-go-sdk-v5"
	"io"
	"net/http"
	"os"
	"time"
)

// Projected Secret files are read per request; no static-key fallback on read/expiry failure.
type rotatingCOSCredentials struct{ path string }
type storageSession struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token"`
	ExpiresAt       int64  `json:"expires_at"`
}

func (t *rotatingCOSCredentials) RoundTrip(req *http.Request) (*http.Response, error) {
	f, err := os.Open(t.path)
	if err != nil {
		return nil, errors.New("storage session file unavailable")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil || len(b) > 16384 {
		return nil, errors.New("storage session file unreadable")
	}
	var s storageSession
	if json.Unmarshal(b, &s) != nil || s.AccessKeyID == "" || s.SecretAccessKey == "" || s.SessionToken == "" || s.ExpiresAt <= time.Now().Unix()+30 {
		return nil, errors.New("storage session invalid or expiring")
	}
	signer := &cos.AuthorizationTransport{SecretID: s.AccessKeyID, SecretKey: s.SecretAccessKey, SessionToken: s.SessionToken, Transport: http.DefaultTransport}
	return signer.RoundTrip(req)
}
