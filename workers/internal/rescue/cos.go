package rescue

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	cos "github.com/tencentyun/cos-go-sdk-v5"
)

type COSUploadTarget struct {
	BucketURL string
	ObjectKey string
	ObjectURL string
	SignedURL string
	ExpiresAt time.Time
}

type COSFederationCredentials struct {
	TmpSecretID  string
	TmpSecretKey string
	Token        string
	ExpiredTime  int64
}

type COSMultipartSession struct {
	BucketURL string
	ObjectKey string
	ObjectURL string
	UploadID  string
}

const (
	stsEndpoint = "sts.tencentcloudapi.com"
	stsVersion  = "2018-08-13"
)

func GenerateCOSMultipartCredentials(ctx context.Context, cfg TencentConfig, req ExportRequest, key string) (COSFederationCredentials, error) {
	resource, err := cosObjectResource(req.COSUploadBucket, req.COSUploadRegion, key)
	if err != nil {
		return COSFederationCredentials{}, err
	}
	policy, err := buildCOSMultipartUploadPolicy(resource)
	if err != nil {
		return COSFederationCredentials{}, err
	}
	client, err := NewTencentClient(cfg, req.COSUploadRegion)
	if err != nil {
		return COSFederationCredentials{}, err
	}
	response, err := client.Call(ctx, stsEndpoint, stsVersion, "GetFederationToken", map[string]any{
		"Name":            "rescuemultipart",
		"Policy":          policy,
		"DurationSeconds": cosMultipartCredentialTTL(req.CommandTimeoutSeconds),
	}, false)
	if err != nil {
		return COSFederationCredentials{}, err
	}
	return parseFederationCredentials(response)
}

func InitiateCOSMultipartUpload(ctx context.Context, cfg TencentConfig, req ExportRequest, key string) (COSMultipartSession, error) {
	client, bucketURL, err := newCOSSDKClient(cfg, req.COSUploadBucket)
	if err != nil {
		return COSMultipartSession{}, err
	}
	result, _, err := client.Object.InitiateMultipartUpload(ctx, key, &cos.InitiateMultipartUploadOptions{
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{ContentType: archiveContentType(req.ArchiveMode)},
	})
	if err != nil {
		return COSMultipartSession{}, err
	}
	if result == nil || strings.TrimSpace(result.UploadID) == "" {
		return COSMultipartSession{}, fmt.Errorf("InitiateMultipartUpload returned no upload ID")
	}
	return COSMultipartSession{
		BucketURL: bucketURL,
		ObjectKey: key,
		ObjectURL: bucketURL + "/" + escapeCOSPath(key),
		UploadID:  result.UploadID,
	}, nil
}

func AbortCOSMultipartUpload(ctx context.Context, cfg TencentConfig, session COSMultipartSession) error {
	client, _, err := newCOSSDKClient(cfg, session.BucketURL)
	if err != nil {
		return err
	}
	_, err = client.Object.AbortMultipartUpload(ctx, session.ObjectKey, session.UploadID)
	if err == nil {
		return nil
	}
	var responseErr *cos.ErrorResponse
	if errors.As(err, &responseErr) && responseErr.Response != nil && responseErr.Response.StatusCode == http.StatusNotFound {
		return nil
	}
	return err
}

func newCOSSDKClient(cfg TencentConfig, rawBucketURL string) (*cos.Client, string, error) {
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return nil, "", err
	}
	bucketURL := strings.TrimRight(strings.TrimSpace(rawBucketURL), "/")
	parsed, err := url.Parse(bucketURL)
	if err != nil {
		return nil, "", err
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return nil, "", fmt.Errorf("COS bucket URL must use https")
	}
	transport := &cos.AuthorizationTransport{SecretID: secretID, SecretKey: secretKey}
	return cos.NewClient(&cos.BaseURL{BucketURL: parsed}, &http.Client{Transport: transport}), bucketURL, nil
}

func archiveContentType(mode string) string {
	if normalizeArchiveMode(mode) == ArchiveModeHermes {
		return "application/zip"
	}
	return "application/gzip"
}

func cosObjectResource(bucketURL, region, key string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(bucketURL, "/"))
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return "", fmt.Errorf("COS bucket URL must use https")
	}
	hostParts := strings.Split(parsed.Hostname(), ".")
	if len(hostParts) == 0 {
		return "", fmt.Errorf("COS bucket host is invalid")
	}
	bucketWithAppID := hostParts[0]
	separator := strings.LastIndex(bucketWithAppID, "-")
	if separator <= 0 || separator == len(bucketWithAppID)-1 {
		return "", fmt.Errorf("COS bucket host must include APPID suffix")
	}
	bucketName := bucketWithAppID[:separator]
	appID := bucketWithAppID[separator+1:]
	for _, char := range appID {
		if char < '0' || char > '9' {
			return "", fmt.Errorf("COS bucket APPID suffix is invalid")
		}
	}
	key = strings.TrimLeft(strings.TrimSpace(key), "/")
	if key == "" || strings.ContainsAny(key, "*?\r\n") || strings.Contains(key, "../") {
		return "", fmt.Errorf("COS object key is unsafe for temporary authorization")
	}
	region = strings.TrimSpace(region)
	if region == "" {
		return "", fmt.Errorf("COS region is required")
	}
	return fmt.Sprintf("qcs::cos:%s:uid/%s:prefix//%s/%s/%s", region, appID, appID, bucketName, key), nil
}

func buildCOSMultipartUploadPolicy(resource string) (string, error) {
	policy := map[string]any{
		"version": "2.0",
		"statement": []map[string]any{{
			"effect": "allow",
			"action": []string{
				"name/cos:UploadPart",
				"name/cos:CompleteMultipartUpload",
			},
			"resource": []string{resource},
		}},
	}
	data, err := json.Marshal(policy)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func cosMultipartCredentialTTL(commandTimeoutSeconds int) int {
	if commandTimeoutSeconds <= 0 {
		return 1800
	}
	ttl := commandTimeoutSeconds + 600
	if ttl < 1800 {
		return 1800
	}
	if ttl > 7200 {
		return 7200
	}
	return ttl
}

func parseFederationCredentials(response map[string]any) (COSFederationCredentials, error) {
	raw, _ := response["Credentials"].(map[string]any)
	credentials := COSFederationCredentials{
		TmpSecretID:  stringValue(raw["TmpSecretId"]),
		TmpSecretKey: stringValue(raw["TmpSecretKey"]),
		Token:        stringValue(raw["Token"]),
		ExpiredTime:  int64(intValue(response["ExpiredTime"])),
	}
	if credentials.TmpSecretID == "" || credentials.TmpSecretKey == "" || credentials.Token == "" {
		return COSFederationCredentials{}, fmt.Errorf("GetFederationToken returned incomplete credentials")
	}
	return credentials, nil
}

func GenerateCOSUploadTarget(ctx context.Context, cfg TencentConfig, req ExportRequest, key string, method string) (COSUploadTarget, error) {
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return COSUploadTarget{}, err
	}
	bucketURL := strings.TrimRight(req.COSUploadBucket, "/")
	if bucketURL == "" {
		return COSUploadTarget{}, fmt.Errorf("--cos-upload-bucket-url is required for streaming COS upload")
	}
	parsed, err := url.Parse(bucketURL)
	if err != nil {
		return COSUploadTarget{}, err
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return COSUploadTarget{}, fmt.Errorf("--cos-upload-bucket-url must be an https COS bucket URL")
	}
	if req.COSUploadRegion != "" && !strings.Contains(parsed.Host, ".cos."+req.COSUploadRegion+".") {
		return COSUploadTarget{}, fmt.Errorf("--cos-upload-bucket-url host %s does not match --cos-upload-region %s", parsed.Host, req.COSUploadRegion)
	}
	ttl := cosURLTTLSeconds(req)
	target := COSUploadTarget{
		BucketURL: bucketURL,
		ObjectKey: key,
		ObjectURL: bucketURL + "/" + escapeCOSPath(key),
		ExpiresAt: time.Now().Add(time.Duration(ttl) * time.Second),
	}
	target.SignedURL = signCOSURL(secretID, secretKey, parsed.Host, "/"+escapeCOSPath(key), ttl, method)
	_ = ctx
	return target, nil
}

func cosURLTTLSeconds(req ExportRequest) int {
	if req.COSUploadURLTTLSeconds > 0 {
		return req.COSUploadURLTTLSeconds
	}
	return 3600
}

func DeleteCOSObject(ctx context.Context, cfg TencentConfig, req COSDeleteRequest, dryRun bool) (COSDeleteResult, error) {
	if req.ObjectKey == "" {
		return COSDeleteResult{}, temporalActivityError(fmt.Errorf("COS object key is required for auto delete"))
	}
	bucketURL := strings.TrimRight(req.BucketURL, "/")
	if bucketURL == "" {
		return COSDeleteResult{}, temporalActivityError(fmt.Errorf("--cos-upload-bucket-url is required for COS auto delete"))
	}
	parsed, err := url.Parse(bucketURL)
	if err != nil {
		return COSDeleteResult{}, temporalActivityError(err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return COSDeleteResult{}, temporalActivityError(fmt.Errorf("--cos-upload-bucket-url must be an https COS bucket URL"))
	}
	if req.BucketRegion != "" && !strings.Contains(parsed.Host, ".cos."+req.BucketRegion+".") {
		return COSDeleteResult{}, temporalActivityError(fmt.Errorf("--cos-upload-bucket-url host %s does not match bucket region %s", parsed.Host, req.BucketRegion))
	}
	objectURL := req.ObjectURL
	if objectURL == "" {
		objectURL = bucketURL + "/" + escapeCOSPath(req.ObjectKey)
	}
	result := COSDeleteResult{ObjectKey: req.ObjectKey, ObjectURL: objectURL, DryRun: dryRun}
	if dryRun {
		fmt.Printf("[dry-run] would delete COS object object_url=%s\n", objectURL)
		return result, nil
	}
	secretID, secretKey, err := resolveTencentCredentials(cfg)
	if err != nil {
		return COSDeleteResult{}, temporalActivityError(err)
	}
	deleteURL := signCOSURL(secretID, secretKey, parsed.Host, "/"+escapeCOSPath(req.ObjectKey), 300, http.MethodDelete)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodDelete, deleteURL, nil)
	if err != nil {
		return COSDeleteResult{}, err
	}
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return COSDeleteResult{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusNotFound {
		fmt.Printf("[rescue] COS object already absent object_url=%s\n", objectURL)
		result.Deleted = true
		return result, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return COSDeleteResult{}, fmt.Errorf("delete COS object failed status=%d body=%s object_url=%s", resp.StatusCode, strings.TrimSpace(string(body)), objectURL)
	}
	fmt.Printf("[rescue] deleted COS object object_url=%s\n", objectURL)
	result.Deleted = true
	return result, nil
}

func cosObjectKey(req ExportRequest) string {
	prefix := strings.Trim(req.COSUploadKeyPrefix, "/")
	suffix := ".tar.gz"
	if normalizeArchiveMode(req.ArchiveMode) == ArchiveModeHermes {
		suffix = ".zip"
	}
	name := fmt.Sprintf("%s-%d%s", req.InstanceID, time.Now().Unix(), suffix)
	if prefix == "" {
		return name
	}
	return path.Join(prefix, name)
}

func signCOSURL(secretID, secretKey, host, uri string, ttlSeconds int, method string) string {
	method = strings.ToLower(method)
	now := time.Now().Unix()
	keyTime := fmt.Sprintf("%d;%d", now, now+int64(ttlSeconds))
	headerList := "host"
	urlParamList := ""
	headerString := "host=" + cosEncode(strings.ToLower(host))
	httpString := strings.Join([]string{method, uri, "", headerString}, "\n") + "\n"
	stringToSign := strings.Join([]string{"sha1", keyTime, sha1Hex([]byte(httpString)), ""}, "\n")
	signKey := hmacSHA1Hex([]byte(secretKey), []byte(keyTime))
	signature := hmacSHA1Hex([]byte(signKey), []byte(stringToSign))
	query := map[string]string{
		"q-sign-algorithm": "sha1",
		"q-ak":             secretID,
		"q-sign-time":      keyTime,
		"q-key-time":       keyTime,
		"q-header-list":    headerList,
		"q-url-param-list": urlParamList,
		"q-signature":      signature,
	}
	return "https://" + host + uri + "?" + canonicalQuery(query)
}

func canonicalQuery(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, cosEncode(key)+"="+cosEncode(values[key]))
	}
	return strings.Join(parts, "&")
}

func escapeCOSPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		parts[i] = cosEncode(part)
	}
	return strings.Join(parts, "/")
}

func cosEncode(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func sha1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return hex.EncodeToString(sum[:])
}

func hmacSHA1Hex(key, data []byte) string {
	mac := hmac.New(sha1.New, key)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
