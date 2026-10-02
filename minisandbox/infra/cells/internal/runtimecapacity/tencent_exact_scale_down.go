package runtimecapacity

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	tencentTKEAction  = "DeleteClusterMachines"
	tencentTKEVersion = "2022-05-01"
	tencentTKEService = "tke"
	tencentTKEHost    = "tke.internal.tencentcloudapi.com"
	maxTencentBody    = 1 << 20
)

// TencentExactScaleDownClient implements the narrow cloud-side capability the
// controller needs. The credential mounted into this client must grant only
// tke:DeleteClusterMachines for the owned cluster; it is never reused for
// discovery or general infrastructure mutation.
type TencentExactScaleDownClient struct {
	SecretID    string
	SecretKey   string
	Token       string
	Credentials TencentCredentialProvider
	Region      string
	ClusterID   string
	Endpoint    string
	HTTPClient  *http.Client
	Now         func() time.Time
}

func (c *TencentExactScaleDownClient) DeleteMachineAndScaleDown(
	ctx context.Context, request ExactScaleDownRequest,
) (ExactScaleDownResponse, error) {
	credential, err := c.credential()
	if err != nil {
		return ExactScaleDownResponse{}, err
	}
	if c.Region == "" || c.ClusterID == "" {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down credentials and identity are required")
	}
	if request.ClusterID != c.ClusterID || request.MachineName == "" || request.MachineUID == "" ||
		request.NodeName == "" || request.NodeUID == "" || request.MachineSetName == "" ||
		request.MachineSetUID == "" || request.ToReplicas != request.FromReplicas-1 {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down request identity or bounds mismatch")
	}
	payload, err := json.Marshal(struct {
		ClusterID          string   `json:"ClusterId"`
		MachineNames       []string `json:"MachineNames"`
		EnableScaleDown    bool     `json:"EnableScaleDown"`
		InstanceDeleteMode string   `json:"InstanceDeleteMode"`
	}{
		ClusterID: c.ClusterID, MachineNames: []string{request.MachineName},
		EnableScaleDown: true, InstanceDeleteMode: "terminate",
	})
	if err != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("encode Tencent exact scale-down request: %w", err)
	}
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "https://" + tencentTKEHost
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery != "" {
		return ExactScaleDownResponse{}, fmt.Errorf("invalid Tencent TKE endpoint")
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	authorization := c.authorizationWithCredential(parsed, payload, now, credential)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(payload))
	if err != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("create Tencent exact scale-down request: %w", err)
	}
	httpRequest.Header.Set("Authorization", authorization)
	httpRequest.Header.Set("Content-Type", "application/json; charset=utf-8")
	httpRequest.Header.Set("X-TC-Action", tencentTKEAction)
	httpRequest.Header.Set("X-TC-Version", tencentTKEVersion)
	httpRequest.Header.Set("X-TC-Region", c.Region)
	httpRequest.Header.Set("X-TC-Timestamp", strconv.FormatInt(now.Unix(), 10))
	if credential.Token != "" {
		httpRequest.Header.Set("X-TC-Token", credential.Token)
	}
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(httpRequest)
	if err != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("call Tencent exact scale-down API: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxTencentBody+1))
	if err != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("read Tencent exact scale-down response: %w", err)
	}
	if len(body) > maxTencentBody {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down response exceeds limit")
	}
	var envelope struct {
		Response struct {
			RequestID string `json:"RequestId"`
			Error     *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("decode Tencent exact scale-down response (HTTP %d): %w", response.StatusCode, err)
	}
	if envelope.Response.Error != nil {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down API %s: %s", envelope.Response.Error.Code, envelope.Response.Error.Message)
	}
	if response.StatusCode != http.StatusOK {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down API returned HTTP %d", response.StatusCode)
	}
	if envelope.Response.RequestID == "" {
		return ExactScaleDownResponse{}, fmt.Errorf("Tencent exact scale-down API returned no request ID")
	}
	return ExactScaleDownResponse{RequestID: envelope.Response.RequestID}, nil
}

func (c *TencentExactScaleDownClient) authorization(endpoint *url.URL, payload []byte, now time.Time) string {
	return c.authorizationWithCredential(endpoint, payload, now, TencentCredential{
		SecretID: c.SecretID, SecretKey: c.SecretKey, Token: c.Token,
	})
}

func (c *TencentExactScaleDownClient) authorizationWithCredential(
	endpoint *url.URL, payload []byte, now time.Time, credential TencentCredential,
) string {
	contentType := "application/json; charset=utf-8"
	action := strings.ToLower(tencentTKEAction)
	path := endpoint.EscapedPath()
	if path == "" {
		path = "/"
	}
	canonicalHeaders := "content-type:" + contentType + "\n" +
		"host:" + endpoint.Host + "\n" +
		"x-tc-action:" + action + "\n"
	signedHeaders := "content-type;host;x-tc-action"
	canonicalRequest := http.MethodPost + "\n" + path + "\n\n" + canonicalHeaders + "\n" +
		signedHeaders + "\n" + sha256Hex(payload)
	date := now.Format("2006-01-02")
	credentialScope := date + "/" + tencentTKEService + "/tc3_request"
	stringToSign := "TC3-HMAC-SHA256\n" + strconv.FormatInt(now.Unix(), 10) + "\n" +
		credentialScope + "\n" + sha256Hex([]byte(canonicalRequest))
	kDate := hmacSHA256([]byte("TC3"+credential.SecretKey), []byte(date))
	kService := hmacSHA256(kDate, []byte(tencentTKEService))
	kSigning := hmacSHA256(kService, []byte("tc3_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))
	return "TC3-HMAC-SHA256 Credential=" + credential.SecretID + "/" + credentialScope +
		", SignedHeaders=" + signedHeaders + ", Signature=" + signature
}

func (c *TencentExactScaleDownClient) credential() (TencentCredential, error) {
	if c.Credentials != nil {
		credential, err := c.Credentials.GetCredential()
		if err != nil {
			return TencentCredential{}, fmt.Errorf("get Tencent exact scale-down credential: %w", err)
		}
		if credential.SecretID == "" || credential.SecretKey == "" || credential.Token == "" {
			return TencentCredential{}, fmt.Errorf("Tencent OIDC credential is incomplete")
		}
		return credential, nil
	}
	if c.SecretID == "" || c.SecretKey == "" {
		return TencentCredential{}, fmt.Errorf("Tencent exact scale-down credentials and identity are required")
	}
	return TencentCredential{SecretID: c.SecretID, SecretKey: c.SecretKey, Token: c.Token}, nil
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, value []byte) []byte {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write(value)
	return hash.Sum(nil)
}
