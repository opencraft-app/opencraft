package rescue

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	cvmEndpoint = "cvm.tencentcloudapi.com"
	cvmVersion  = "2017-03-12"
	tatEndpoint = "tat.tencentcloudapi.com"
	tatVersion  = "2020-10-28"
)

type TencentAPIError struct {
	Endpoint string
	Action   string
	Code     string
	Message  string
}

func (e *TencentAPIError) Error() string {
	return fmt.Sprintf("%s %s failed: %s: %s", e.Endpoint, e.Action, e.Code, e.Message)
}

type TencentClient struct {
	SecretID  string
	SecretKey string
	Region    string
	HTTP      *http.Client
}

func LoadTencentCredentials(path string) (string, string, error) {
	if id, key := strings.TrimSpace(os.Getenv("TENCENTCLOUD_SECRET_ID")), strings.TrimSpace(os.Getenv("TENCENTCLOUD_SECRET_KEY")); id != "" && key != "" {
		return id, key, nil
	}
	candidates := []string{}
	if path != "" {
		candidates = append(candidates, path)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".tccli", "default.credential"))
	}
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var payload map[string]string
		if err := json.Unmarshal(data, &payload); err != nil {
			return "", "", err
		}
		if payload["secretId"] != "" && payload["secretKey"] != "" {
			return payload["secretId"], payload["secretKey"], nil
		}
	}
	return "", "", errors.New("missing Tencent credentials; set TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY")
}

func (c TencentClient) Call(ctx context.Context, endpoint, version, action string, payload map[string]any, dryRun bool) (map[string]any, error) {
	if dryRun {
		body, _ := json.Marshal(redact(payload))
		fmt.Printf("[dry-run] %s %s: %s\n", endpoint, action, body)
		return map[string]any{}, nil
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	timestamp := time.Now().Unix()
	date := time.Unix(timestamp, 0).UTC().Format("2006-01-02")
	service := strings.SplitN(endpoint, ".", 2)[0]
	canonicalHeaders := "content-type:application/json; charset=utf-8\n" + "host:" + endpoint + "\n" + "x-tc-action:" + strings.ToLower(action) + "\n"
	signedHeaders := "content-type;host;x-tc-action"
	canonicalRequest := strings.Join([]string{
		"POST",
		"/",
		"",
		canonicalHeaders,
		signedHeaders,
		sha256Hex(body),
	}, "\n")
	credentialScope := date + "/" + service + "/tc3_request"
	stringToSign := strings.Join([]string{
		"TC3-HMAC-SHA256",
		strconv.FormatInt(timestamp, 10),
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	secretDate := hmacSHA256([]byte("TC3"+c.SecretKey), []byte(date))
	secretService := hmacSHA256(secretDate, []byte(service))
	secretSigning := hmacSHA256(secretService, []byte("tc3_request"))
	signature := hex.EncodeToString(hmacSHA256(secretSigning, []byte(stringToSign)))
	auth := fmt.Sprintf("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", c.SecretID, credentialScope, signedHeaders, signature)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Host", endpoint)
	req.Header.Set("X-TC-Action", action)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(timestamp, 10))
	req.Header.Set("X-TC-Version", version)
	req.Header.Set("X-TC-Region", c.Region)
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s failed: HTTP %d: %s", endpoint, action, resp.StatusCode, string(respBody))
	}
	var envelope map[string]any
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return nil, err
	}
	result, _ := envelope["Response"].(map[string]any)
	if result == nil {
		result = envelope
	}
	if errObj, ok := result["Error"].(map[string]any); ok {
		return nil, &TencentAPIError{
			Endpoint: endpoint,
			Action:   action,
			Code:     stringValue(errObj["Code"]),
			Message:  stringValue(errObj["Message"]),
		}
	}
	return result, nil
}

func (c TencentClient) CVM(ctx context.Context, action string, payload map[string]any, dryRun bool) (map[string]any, error) {
	return c.Call(ctx, cvmEndpoint, cvmVersion, action, payload, dryRun)
}

func (c TencentClient) TAT(ctx context.Context, action string, payload map[string]any, dryRun bool) (map[string]any, error) {
	return c.Call(ctx, tatEndpoint, tatVersion, action, payload, dryRun)
}

func ResolveInstanceRegion(ctx context.Context, cfg TencentConfig, req ExportRequest) (InstanceInfo, error) {
	fmt.Printf("[rescue] locating instance=%s preferred_region=%s\n", req.InstanceID, req.Region)
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return InstanceInfo{}, err
	}
	candidates := []string{}
	if req.Region != "" {
		candidates = append(candidates, req.Region)
	} else if cfg.Region != "" {
		candidates = append(candidates, cfg.Region)
	}
	candidates = append(candidates, cfg.RegionCandidates...)
	if len(candidates) == 0 {
		candidates = CommonRegions
	}
	var errs []string
	seen := map[string]bool{}
	for _, region := range candidates {
		if seen[region] {
			continue
		}
		seen[region] = true
		client := TencentClient{SecretID: secretID, SecretKey: secretKey, Region: region}
		info, err := DescribeInstance(ctx, client, req.InstanceID, false)
		if err == nil {
			fmt.Printf("[rescue] located instance=%s region=%s state=%s public_ip=%s private_ip=%s\n", info.InstanceID, info.Region, info.State, info.PublicIP, info.PrivateIP)
			return info, nil
		}
		errs = append(errs, region+": "+err.Error())
		if req.Region != "" || cfg.Region != "" {
			break
		}
	}
	return InstanceInfo{}, fmt.Errorf("could not locate %s; %s", req.InstanceID, strings.Join(errs, "; "))
}

func NewTencentClient(cfg TencentConfig, region string) (TencentClient, error) {
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return TencentClient{}, err
	}
	return TencentClient{SecretID: secretID, SecretKey: secretKey, Region: region}, nil
}

func resolveTencentCredentials(cfg TencentConfig) (string, string, error) {
	return LoadTencentCredentials(cfg.CredentialFile)
}

func DescribeInstance(ctx context.Context, client TencentClient, instanceID string, dryRun bool) (InstanceInfo, error) {
	resp, err := client.CVM(ctx, "DescribeInstances", map[string]any{"InstanceIds": []string{instanceID}, "Limit": 1}, dryRun)
	if err != nil {
		return InstanceInfo{}, err
	}
	if dryRun {
		return InstanceInfo{InstanceID: instanceID, Region: client.Region, State: "DRY_RUN"}, nil
	}
	set, _ := resp["InstanceSet"].([]any)
	if len(set) == 0 {
		return InstanceInfo{}, fmt.Errorf("instance %s not found in %s", instanceID, client.Region)
	}
	raw, _ := set[0].(map[string]any)
	return InstanceInfo{
		InstanceID: instanceID,
		Region:     client.Region,
		State:      stringValue(raw["InstanceState"]),
		PublicIP:   firstString(raw["PublicIpAddresses"]),
		PrivateIP:  firstString(raw["PrivateIpAddresses"]),
	}, nil
}

func EnterRescue(ctx context.Context, client TencentClient, req ExportRequest) error {
	password := rescuePasswordFromEnv(req)
	fmt.Printf("[rescue] entering rescue mode instance=%s region=%s username=%s stop_type=%s password_env=%s password_len=%d password_sha256=%s\n",
		req.InstanceID, client.Region, req.RescueUsername, req.StopType, req.RescuePasswordEnv, len(password), shortSecretSHA256(password))
	_, err := client.CVM(ctx, "EnterRescueMode", map[string]any{
		"InstanceId": req.InstanceID,
		"Username":   req.RescueUsername,
		"Password":   password,
		"StopType":   req.StopType,
	}, !req.Execute)
	if isTencentCode(err, "UnsupportedOperation.InstanceStateEnterRescueMode") ||
		isTencentCode(err, "UnsupportedOperation.InstanceStateRescueMode") {
		fmt.Printf("[rescue] enter rescue treated as idempotent success instance=%s code=%v\n", req.InstanceID, err)
		return nil
	}
	if err == nil {
		fmt.Printf("[rescue] enter rescue requested instance=%s\n", req.InstanceID)
	}
	return err
}

func ExitRescue(ctx context.Context, client TencentClient, req ExportRequest) error {
	fmt.Printf("[rescue] exiting rescue mode instance=%s region=%s\n", req.InstanceID, client.Region)
	_, err := client.CVM(ctx, "ExitRescueMode", map[string]any{"InstanceId": req.InstanceID}, !req.Execute)
	if isTencentCode(err, "UnsupportedOperation.InstanceStateExitRescueMode") {
		fmt.Printf("[rescue] exit rescue treated as idempotent success instance=%s code=%v\n", req.InstanceID, err)
		return nil
	}
	if err == nil {
		fmt.Printf("[rescue] exit rescue requested instance=%s\n", req.InstanceID)
	}
	return err
}

func WaitInstanceState(ctx context.Context, client TencentClient, instanceID string, desired map[string]bool, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return last, err
		}
		resp, err := client.CVM(ctx, "DescribeInstancesStatus", map[string]any{"InstanceIds": []string{instanceID}}, false)
		if err != nil {
			return "", temporalActivityError(err)
		}
		set, _ := resp["InstanceStatusSet"].([]any)
		if len(set) > 0 {
			raw, _ := set[0].(map[string]any)
			last = stringValue(raw["InstanceState"])
			recordHeartbeat(ctx, map[string]string{
				"kind":        "instance-state",
				"instance_id": instanceID,
				"state":       last,
			})
			fmt.Printf("[rescue] instance state instance=%s state=%s\n", instanceID, last)
			if desired[last] {
				return last, nil
			}
		}
		if err := sleepContext(ctx, 10*time.Second); err != nil {
			return last, err
		}
	}
	return last, fmt.Errorf("timed out waiting for %s; last=%s", instanceID, last)
}

func isTencentCode(err error, code string) bool {
	var apiErr *TencentAPIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}

func rescuePasswordFromEnv(req ExportRequest) string {
	if req.RescuePasswordEnv == "" {
		return ""
	}
	return os.Getenv(req.RescuePasswordEnv)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func shortSecretSHA256(value string) string {
	if value == "" {
		return "<empty>"
	}
	full := sha256Hex([]byte(value))
	return full[:12]
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func redact(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "content") || strings.Contains(lower, "authorization") {
				out[key] = "<redacted>"
			} else {
				out[key] = redact(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = redact(item)
		}
		return out
	default:
		return value
	}
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func firstString(value any) string {
	items, _ := value.([]any)
	if len(items) == 0 {
		return ""
	}
	return stringValue(items[0])
}
