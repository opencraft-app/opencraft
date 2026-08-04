package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/google/uuid"
)

var (
	ErrClientInvalid = errors.New("Computer enrollment client 配置无效")
	ErrClaimRejected = errors.New("Computer enrollment claim 被拒绝")
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type ClientConfig struct {
	BaseURL           string
	HTTP              HTTPDoer
	AllowInsecureHTTP bool
}

type ClaimRequest struct {
	Token            string
	SecretPart       string
	OSType           string
	Architecture     string
	InstallerVersion string
}

type ClaimResult struct {
	ServerID     string
	ComputerID   string
	CredentialID string
	Version      uint64
	ExpiresAt    time.Time
	Credential   string
}

type ProviderTag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ProviderRegistration struct {
	Region    string
	CodeID    string
	CodeValue string
	Tags      []ProviderTag
	ExpiresAt time.Time
}

type ProviderResult struct {
	Ready        bool
	OperationID  string
	RetryAfter   time.Duration
	Registration ProviderRegistration
}

type Client struct {
	baseURL string
	http    HTTPDoer
}

func NewClient(config ClientConfig) (*Client, error) {
	baseURL, ok := normalizeInstallBaseURL(config.BaseURL, config.AllowInsecureHTTP)
	if !ok {
		return nil, ErrClientInvalid
	}
	doer := config.HTTP
	if doer == nil {
		doer = &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{baseURL: baseURL, http: doer}, nil
}

func (client *Client) Claim(ctx context.Context, request ClaimRequest) (ClaimResult, error) {
	if client == nil || client.http == nil || ctx == nil || !validClaimRequest(request) {
		return ClaimResult{}, ErrClientInvalid
	}
	digest := sha256.Sum256([]byte(request.SecretPart))
	body, err := common.Marshal(struct {
		OSType           string `json:"osType"`
		Architecture     string `json:"architecture"`
		CredentialDigest string `json:"credentialDigest"`
		InstallerVersion string `json:"installerVersion"`
	}{
		OSType: request.OSType, Architecture: request.Architecture,
		CredentialDigest: hex.EncodeToString(digest[:]),
		InstallerVersion: request.InstallerVersion,
	})
	if err != nil {
		return ClaimResult{}, ErrClientInvalid
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		client.baseURL+"/computer/enrollments:claim",
		bytes.NewReader(body),
	)
	if err != nil {
		return ClaimResult{}, ErrClientInvalid
	}
	httpRequest.Header.Set("Authorization", "Enrollment "+request.Token)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	response, err := client.http.Do(httpRequest)
	if err != nil {
		return ClaimResult{}, fmt.Errorf("%w: 网络请求失败", ErrClaimRejected)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ClaimResult{}, fmt.Errorf("%w: HTTP %d", ErrClaimRejected, response.StatusCode)
	}
	var value struct {
		ServerID          string    `json:"serverId"`
		ComputerID        string    `json:"computerId"`
		CredentialID      string    `json:"credentialId"`
		CredentialVersion int64     `json:"credentialVersion"`
		ExpiresAt         time.Time `json:"expiresAt"`
	}
	if err := decodeLimited(response.Body, &value); err != nil ||
		!uuidV7(value.ServerID) || !uuidV7(value.ComputerID) ||
		!uuidV7(value.CredentialID) || value.CredentialVersion <= 0 ||
		value.ExpiresAt.IsZero() {
		return ClaimResult{}, fmt.Errorf("%w: 响应结构无效", ErrClaimRejected)
	}
	version := uint64(value.CredentialVersion)
	credential := "crc_" + value.ServerID + "." + value.ComputerID + "." +
		strconv.FormatUint(version, 10) + "." + request.SecretPart
	return ClaimResult{
		ServerID: value.ServerID, ComputerID: value.ComputerID,
		CredentialID: value.CredentialID, Version: version,
		ExpiresAt: value.ExpiresAt.UTC(), Credential: credential,
	}, nil
}

func (client *Client) Provider(ctx context.Context, credential string) (ProviderResult, error) {
	if client == nil || client.http == nil || ctx == nil || !validCredential(credential) {
		return ProviderResult{}, ErrClientInvalid
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		client.baseURL+"/bootstrap/provider-registration",
		http.NoBody,
	)
	if err != nil {
		return ProviderResult{}, ErrClientInvalid
	}
	request.Header.Set("Authorization", "ComputerCredential "+credential)
	request.Header.Set("Accept", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return ProviderResult{}, errors.New("provider bootstrap 请求失败")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusAccepted {
		var body struct {
			OperationID       string `json:"operationId"`
			State             string `json:"state"`
			RetryAfterSeconds int    `json:"retryAfterSeconds"`
		}
		if err := decodeLimited(response.Body, &body); err != nil ||
			!uuidV7(body.OperationID) ||
			(body.State != "pending" && body.State != "retry_wait") ||
			body.RetryAfterSeconds < 1 || body.RetryAfterSeconds > 30 {
			return ProviderResult{}, errors.New("provider bootstrap pending 响应无效")
		}
		headerSeconds, err := strconv.Atoi(response.Header.Get("Retry-After"))
		if err != nil || headerSeconds != body.RetryAfterSeconds {
			return ProviderResult{}, errors.New("provider bootstrap Retry-After 无效")
		}
		return ProviderResult{
			OperationID: body.OperationID,
			RetryAfter:  time.Duration(body.RetryAfterSeconds) * time.Second,
		}, nil
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ProviderResult{}, fmt.Errorf("provider bootstrap HTTP %d", response.StatusCode)
	}
	var body struct {
		OperationID       string        `json:"operationId"`
		State             string        `json:"state"`
		Protocol          string        `json:"protocol"`
		Region            string        `json:"region"`
		RegisterCodeID    string        `json:"registerCodeId"`
		RegisterCodeValue string        `json:"registerCodeValue"`
		Tags              []ProviderTag `json:"tags"`
		ExpiresAt         time.Time     `json:"expiresAt"`
	}
	if err := decodeLimited(response.Body, &body); err != nil ||
		!uuidV7(body.OperationID) || body.State != "ready" ||
		body.Protocol != "tencent-tat-register-v1" ||
		strings.TrimSpace(body.Region) == "" ||
		strings.TrimSpace(body.RegisterCodeID) == "" ||
		strings.TrimSpace(body.RegisterCodeValue) == "" ||
		len(body.Tags) < 1 || body.ExpiresAt.IsZero() {
		return ProviderResult{}, errors.New("provider bootstrap ready 响应无效")
	}
	for _, tag := range body.Tags {
		if strings.TrimSpace(tag.Key) == "" || strings.TrimSpace(tag.Value) == "" {
			return ProviderResult{}, errors.New("provider bootstrap tag 无效")
		}
	}
	return ProviderResult{
		Ready: true, OperationID: body.OperationID,
		Registration: ProviderRegistration{
			Region: body.Region, CodeID: body.RegisterCodeID,
			CodeValue: body.RegisterCodeValue,
			Tags:      append([]ProviderTag(nil), body.Tags...),
			ExpiresAt: body.ExpiresAt.UTC(),
		},
	}, nil
}

func decodeLimited(reader io.Reader, target any) error {
	content, err := io.ReadAll(io.LimitReader(reader, 64*1024+1))
	if err != nil || len(content) == 0 || len(content) > 64*1024 {
		return ErrClientInvalid
	}
	return common.Unmarshal(content, target)
}

func normalizeInstallBaseURL(raw string, allowInsecure bool) (string, bool) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/v1") {
		return "", false
	}
	switch parsed.Scheme {
	case "https":
		if allowInsecure {
			return "", false
		}
	case "http":
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if !allowInsecure && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return "", false
		}
	default:
		return "", false
	}
	parsed.Path = "/v1"
	return strings.TrimRight(parsed.String(), "/"), true
}

func validClaimRequest(request ClaimRequest) bool {
	if !validEnrollmentToken(request.Token) || !validComponent(request.InstallerVersion) ||
		request.OSType != "macos" || request.Architecture != "arm64" {
		return false
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(request.SecretPart)
	return err == nil && len(secret) == 32
}

func validEnrollmentToken(value string) bool {
	return len(value) >= 32 && len(value) <= 1024 && strings.TrimSpace(value) == value &&
		!strings.ContainsAny(value, "\r\n\x00")
}

func validCredential(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], "crc_") ||
		!uuidV7(strings.TrimPrefix(parts[0], "crc_")) || !uuidV7(parts[1]) {
		return false
	}
	version, err := strconv.ParseUint(parts[2], 10, 64)
	if err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[2] {
		return false
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	return err == nil && len(secret) == 32
}

func uuidV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7 && parsed.String() == value
}
