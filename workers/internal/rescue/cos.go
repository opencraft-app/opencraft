package rescue

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"
)

type COSUploadTarget struct {
	BucketURL string
	ObjectKey string
	ObjectURL string
	SignedURL string
	ExpiresAt time.Time
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
