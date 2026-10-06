package storagesession

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

type session struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token"`
	ExpiresAt       int64  `json:"expires_at"`
}

func (s session) valid() bool {
	return s.AccessKeyID != "" && s.SecretAccessKey != "" && s.SessionToken != "" && s.ExpiresAt > 0
}

type oidcIssuer struct {
	config    Config
	transport *http.Transport
}

func newOIDCIssuer(c Config) *oidcIssuer {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil // projected identity must not traverse an environment HTTP proxy
	t.DialContext = (&net.Dialer{Timeout: c.timeout(), KeepAlive: 30 * time.Second}).DialContext
	t.TLSHandshakeTimeout = c.timeout()
	t.ResponseHeaderTimeout = c.timeout()
	return &oidcIssuer{config: c, transport: t}
}

// Bound response size and prevent HTTP redirect, SDK retry or transport replay.
// One instance per exchange; POST is non-idempotent and never carries retry keys.
type onceTransport struct {
	base *http.Transport
	sent bool
}

func (t *onceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// The pinned SDK writes non-canonical "X-TC-Action" directly into Header;
	// Header.Get canonicalizes to "X-Tc-Action" and would miss that entry.
	action := ""
	for key, values := range req.Header {
		if strings.EqualFold(key, "X-TC-Action") && len(values) == 1 {
			action = values[0]
		}
	}
	if t.sent || req.URL.Scheme != "https" || req.URL.Host != STSEndpoint || req.Method != http.MethodPost || action != "AssumeRoleWithWebIdentity" {
		return nil, errors.New("sts_request_denied")
	}
	t.sent = true
	req = req.Clone(req.Context())
	req.GetBody = nil
	req.Header.Del("Idempotency-Key")
	req.Header.Del("X-Idempotency-Key")
	res, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, errors.New("sts_transport_failed")
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 32769))
	if err != nil || len(b) > 32768 || res.StatusCode != http.StatusOK {
		return nil, errors.New("sts_response_invalid")
	}
	res.Body = io.NopCloser(bytes.NewReader(b))
	return res, nil
}

func (i *oidcIssuer) issue(ctx context.Context, r Role) (session, error) {
	token, err := projectedToken(i.config)
	if err != nil {
		return session{}, err
	}
	generation, err := randomID()
	if err != nil {
		return session{}, err
	}
	call, cancel := context.WithTimeout(ctx, i.config.timeout())
	defer cancel()
	// Exactly the official NewOIDCRoleArnProvider protocol in common@v1.0.1217,
	// without its private expiredTime or RoleArnCredential's silent refresh/log.
	p := profile.NewClientProfile()
	p.HttpProfile.Endpoint = STSEndpoint
	p.HttpProfile.Scheme = "https"
	p.HttpProfile.ReqMethod = "POST"
	p.HttpProfile.ReqTimeout = int(i.config.RequestTimeoutSeconds)
	p.DisableRegionBreaker = true
	p.NetworkFailureMaxRetries = 0
	p.RateLimitExceededMaxRetries = 0
	p.UnsafeRetryOnConnectionFailure = false
	p.Debug = false
	client := common.NewCommonClient(nil, i.config.Region, p)
	client.WithHttpTransport(&onceTransport{base: i.transport})
	request := tchttp.NewCommonRequest("sts", "2018-08-13", "AssumeRoleWithWebIdentity")
	request.SetSkipSign(true)
	// This SDK version has no SendWithContext. SetContext + Send propagates the
	// same context through sendWithoutSignature to http.Request.WithContext.
	request.SetContext(call)
	if request.SetActionParameters(map[string]interface{}{
		"ProviderId":       i.config.ProviderID,
		"WebIdentityToken": token,
		"RoleArn":          r.ARN,
		"RoleSessionName":  "storage-" + r.Name + "-" + generation,
		"DurationSeconds":  i.config.DurationSeconds,
	}) != nil {
		return session{}, errors.New("sts_request_invalid")
	}
	response := tchttp.NewCommonResponse()
	if client.Send(request, response) != nil || call.Err() != nil {
		return session{}, errors.New("sts_exchange_failed")
	}
	var wire struct {
		Response struct {
			Credentials struct {
				ID    string `json:"TmpSecretId"`
				Key   string `json:"TmpSecretKey"`
				Token string `json:"Token"`
			} `json:"Credentials"`
			ExpiredTime int64           `json:"ExpiredTime"`
			Error       json.RawMessage `json:"Error"`
		} `json:"Response"`
	}
	if json.Unmarshal(response.GetBody(), &wire) != nil || (len(wire.Response.Error) > 0 && string(wire.Response.Error) != "null") {
		return session{}, errors.New("sts_response_invalid")
	}
	s := session{wire.Response.Credentials.ID, wire.Response.Credentials.Key, wire.Response.Credentials.Token, wire.Response.ExpiredTime}
	now := time.Now().Unix()
	if !s.valid() || s.ExpiresAt <= now+i.config.RenewBeforeSeconds+2*i.config.RequestTimeoutSeconds || s.ExpiresAt > now+i.config.DurationSeconds+60 {
		return session{}, errors.New("sts_expiry_invalid")
	}
	return s, nil
}

// This is a local guard, not JWT signature verification; STS verifies the JWT.
// The projected file is re-opened per exchange to follow kubelet rotation.
func projectedToken(c Config) (string, error) {
	bad := errors.New("projected_identity_invalid")
	f, err := os.Open(c.TokenFile)
	if err != nil {
		return "", bad
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil || len(b) > 16384 {
		return "", bad
	}
	token := strings.TrimSpace(string(b))
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return "", bad
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", bad
	}
	var claims struct {
		Audience  json.RawMessage `json:"aud"`
		Subject   string          `json:"sub"`
		Expiry    int64           `json:"exp"`
		NotBefore int64           `json:"nbf"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return "", bad
	}
	var audiences []string
	var single string
	if json.Unmarshal(claims.Audience, &single) == nil {
		audiences = []string{single}
	} else if json.Unmarshal(claims.Audience, &audiences) != nil {
		return "", bad
	}
	found := false
	for _, a := range audiences {
		if a == c.Audience {
			found = true
		}
	}
	now := time.Now().Unix()
	if !found || claims.Subject != "system:serviceaccount:"+c.Namespace+":"+c.ServiceAccount || claims.Expiry <= now+c.RequestTimeoutSeconds+30 || claims.NotBefore > now+5 {
		return "", bad
	}
	return token, nil
}

func randomID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", errors.New("entropy_unavailable")
	}
	return hex.EncodeToString(b[:]), nil
}
