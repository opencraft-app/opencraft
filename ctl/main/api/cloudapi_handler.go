package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"ctl/pkg/errcode"
	passlogic "ctl/pkg/logic/pass"

	"github.com/google/uuid"
)

const (
	cloudAPIActionDescribePass = "DescribePass"
	cloudAPIDefaultService     = "lightvela"
	cloudAPIDefaultVersion     = "2026-08-06"
	cloudAPIDefaultMaxSkew     = 5 * time.Minute
)

var cloudAPINow = time.Now

type cloudAPIConfig struct {
	SecretID       string
	SecretKey      string
	Service        string
	Version        string
	AllowedRegions map[string]struct{}
	MaxSkew        time.Duration
}

type describePassCloudAPIRequest struct {
	Uin    int64  `json:"Uin"`
	AppID  int64  `json:"AppId"`
	PassID string `json:"PassId"`
}

type cloudAPIPass struct {
	PassID       string `json:"PassId"`
	UserID       string `json:"UserId"`
	BundleID     string `json:"BundleId"`
	Uin          int64  `json:"Uin"`
	AppID        int64  `json:"AppId"`
	Status       string `json:"Status"`
	CreatedTime  string `json:"CreatedTime,omitempty"`
	ExpiredTime  string `json:"ExpiredTime"`
	IsolatedTime string `json:"IsolatedTime,omitempty"`
	UpdatedTime  string `json:"UpdatedTime,omitempty"`
}

type cloudAPIErrorBody struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

func (h *passHandler) handleCloudAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeCloudAPIError(w, r, "InvalidAction", "method not allowed")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeCloudAPIError(w, r, "InvalidParameter.RequestBody", "request body is too large")
		return
	}

	cfg := loadCloudAPIConfigFromEnv()
	if err := verifyCloudAPISignature(r, body, cfg); err != nil {
		writeCloudAPIError(w, r, cloudAPIErrorCode(err), err.Error())
		return
	}
	if err := validateCloudAPIHeaders(r, cfg); err != nil {
		writeCloudAPIError(w, r, cloudAPIErrorCode(err), err.Error())
		return
	}

	var req describePassCloudAPIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeCloudAPIError(w, r, "InvalidParameter.RequestBody", "request body must be valid json")
		return
	}
	if req.Uin <= 0 {
		writeCloudAPIError(w, r, "InvalidParameter.Uin", "Uin must be > 0")
		return
	}
	if req.AppID <= 0 {
		writeCloudAPIError(w, r, "InvalidParameter.AppId", "AppId must be > 0")
		return
	}
	req.PassID = strings.TrimSpace(req.PassID)
	if req.PassID == "" {
		writeCloudAPIError(w, r, "InvalidParameter.PassId", "PassId is required")
		return
	}

	detail, err := h.logic.DescribePassByCloudAccount(req.Uin, req.AppID, req.PassID)
	if err != nil {
		writeCloudAPIError(w, r, cloudAPIErrorCode(err), err.Error())
		return
	}
	writeCloudAPISuccess(w, r, map[string]any{
		"RequestId": cloudAPIRequestID(r),
		"Pass":      detailToCloudAPIPass(detail),
	})
}

func loadCloudAPIConfigFromEnv() cloudAPIConfig {
	service := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_SERVICE"))
	if service == "" {
		service = cloudAPIDefaultService
	}
	version := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_VERSION"))
	if version == "" {
		version = cloudAPIDefaultVersion
	}
	maxSkew := cloudAPIDefaultMaxSkew
	if raw := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_TIMESTAMP_SKEW")); raw != "" {
		if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
			maxSkew = parsed
		}
	}
	secretID := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_SECRET_ID"))
	if secretID == "" {
		secretID = strings.TrimSpace(os.Getenv("SecretId"))
	}
	secretKey := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_SECRET_KEY"))
	if secretKey == "" {
		secretKey = strings.TrimSpace(os.Getenv("SecretKey"))
	}
	return cloudAPIConfig{
		SecretID:       secretID,
		SecretKey:      secretKey,
		Service:        service,
		Version:        version,
		AllowedRegions: parseCloudAPIAllowedRegions(os.Getenv("CTL_CLOUDAPI_ALLOWED_REGIONS")),
		MaxSkew:        maxSkew,
	}
}

func parseCloudAPIAllowedRegions(raw string) map[string]struct{} {
	result := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		region := strings.TrimSpace(part)
		if region != "" {
			result[region] = struct{}{}
		}
	}
	return result
}

func validateCloudAPIHeaders(r *http.Request, cfg cloudAPIConfig) error {
	if action := strings.TrimSpace(r.Header.Get("X-TC-Action")); action != cloudAPIActionDescribePass {
		return cloudAPIUserError{code: "InvalidAction", message: "unsupported X-TC-Action"}
	}
	if version := strings.TrimSpace(r.Header.Get("X-TC-Version")); version != cfg.Version {
		return cloudAPIUserError{code: "InvalidParameter.Version", message: "unsupported X-TC-Version"}
	}
	region := strings.TrimSpace(r.Header.Get("X-TC-Region"))
	if region == "" {
		return cloudAPIUserError{code: "InvalidParameter.Region", message: "X-TC-Region is required"}
	}
	if len(cfg.AllowedRegions) > 0 {
		if _, ok := cfg.AllowedRegions[region]; !ok {
			return cloudAPIUserError{code: "InvalidParameter.Region", message: "unsupported X-TC-Region"}
		}
	}
	return nil
}

func verifyCloudAPISignature(r *http.Request, body []byte, cfg cloudAPIConfig) error {
	if cfg.SecretID == "" || cfg.SecretKey == "" {
		return cloudAPIUserError{code: "AuthFailure.SecretUnavailable", message: "cloud api secret is not configured"}
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	credential, err := parseTC3Authorization(authHeader)
	if err != nil {
		return err
	}
	if credential.SecretID != cfg.SecretID {
		return cloudAPIUserError{code: "AuthFailure.InvalidSecretId", message: "invalid SecretId"}
	}
	if credential.Service != cfg.Service {
		return cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "invalid credential service"}
	}
	timestamp, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("X-TC-Timestamp")), 10, 64)
	if err != nil || timestamp <= 0 {
		return cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "invalid X-TC-Timestamp"}
	}
	requestTime := time.Unix(timestamp, 0)
	if delta := cloudAPINow().Sub(requestTime); delta > cfg.MaxSkew || delta < -cfg.MaxSkew {
		return cloudAPIUserError{code: "AuthFailure.SignatureExpire", message: "signature timestamp is expired"}
	}

	expected := computeTC3Signature(r, body, cfg.SecretKey, credential, timestamp)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(credential.Signature)) != 1 {
		return cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "signature mismatch"}
	}
	return nil
}

type tc3Credential struct {
	SecretID      string
	Date          string
	Service       string
	SignedHeaders []string
	Signature     string
}

func parseTC3Authorization(header string) (tc3Credential, error) {
	const prefix = "TC3-HMAC-SHA256 "
	if !strings.HasPrefix(header, prefix) {
		return tc3Credential{}, cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "missing TC3 Authorization"}
	}
	values := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(header, prefix), ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return tc3Credential{}, cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "invalid Authorization"}
		}
		values[key] = value
	}
	credentialParts := strings.Split(values["Credential"], "/")
	if len(credentialParts) != 4 || credentialParts[3] != "tc3_request" {
		return tc3Credential{}, cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "invalid Credential"}
	}
	signedHeaders := strings.Split(values["SignedHeaders"], ";")
	for i := range signedHeaders {
		signedHeaders[i] = strings.ToLower(strings.TrimSpace(signedHeaders[i]))
	}
	signedHeaders = compactNonEmptyStrings(signedHeaders)
	if len(signedHeaders) == 0 || values["Signature"] == "" {
		return tc3Credential{}, cloudAPIUserError{code: "AuthFailure.SignatureFailure", message: "invalid Authorization"}
	}
	sort.Strings(signedHeaders)
	return tc3Credential{
		SecretID:      credentialParts[0],
		Date:          credentialParts[1],
		Service:       credentialParts[2],
		SignedHeaders: signedHeaders,
		Signature:     values["Signature"],
	}, nil
}

func computeTC3Signature(r *http.Request, body []byte, secretKey string, credential tc3Credential, timestamp int64) string {
	canonicalRequestHash := sha256.Sum256([]byte(strings.Join([]string{
		r.Method,
		cloudAPICanonicalPath(r),
		cloudAPICanonicalQuery(r),
		cloudAPICanonicalHeaders(r, credential.SignedHeaders),
		strings.Join(credential.SignedHeaders, ";"),
		sha256Hex(body),
	}, "\n")))
	credentialScope := credential.Date + "/" + credential.Service + "/tc3_request"
	stringToSign := strings.Join([]string{
		"TC3-HMAC-SHA256",
		strconv.FormatInt(timestamp, 10),
		credentialScope,
		hex.EncodeToString(canonicalRequestHash[:]),
	}, "\n")
	secretDate := cloudAPIHMACSHA256([]byte("TC3"+secretKey), credential.Date)
	secretService := cloudAPIHMACSHA256(secretDate, credential.Service)
	secretSigning := cloudAPIHMACSHA256(secretService, "tc3_request")
	return hex.EncodeToString(cloudAPIHMACSHA256(secretSigning, stringToSign))
}

func cloudAPICanonicalPath(r *http.Request) string {
	if path := strings.TrimSpace(r.Header.Get("X-CloudLadder-Original-Path")); path != "" {
		return path
	}
	if path := r.URL.EscapedPath(); path != "" {
		return path
	}
	return "/"
}

func cloudAPICanonicalQuery(r *http.Request) string {
	if values := headerValuesCaseInsensitive(r.Header, "X-CloudLadder-Original-Query"); len(values) > 0 {
		return values[0]
	}
	return r.URL.RawQuery
}

func compactNonEmptyStrings(values []string) []string {
	out := values[:0]
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

func headerValuesCaseInsensitive(headers http.Header, name string) []string {
	if values, ok := headers[name]; ok {
		return values
	}
	for key, values := range headers {
		if strings.EqualFold(key, name) {
			return values
		}
	}
	return nil
}

func cloudAPICanonicalHeaders(r *http.Request, signedHeaders []string) string {
	headers := append([]string(nil), signedHeaders...)
	sort.Strings(headers)
	var b strings.Builder
	for _, name := range headers {
		b.WriteString(name)
		b.WriteByte(':')
		b.WriteString(cloudAPICanonicalHeaderValue(r, name))
		b.WriteByte('\n')
	}
	return b.String()
}

func cloudAPICanonicalHeaderValue(r *http.Request, name string) string {
	if name == "host" {
		if host := strings.TrimSpace(r.Header.Get("X-CloudLadder-Original-Host")); host != "" {
			return host
		}
		return strings.TrimSpace(r.Host)
	}
	return strings.Join(strings.Fields(r.Header.Get(name)), " ")
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func cloudAPIHMACSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(data))
	return mac.Sum(nil)
}

func detailToCloudAPIPass(d *passlogic.PassDetail) *cloudAPIPass {
	resp := &cloudAPIPass{
		PassID:      d.PassID,
		UserID:      d.UserID,
		BundleID:    d.BundleID,
		Uin:         d.Uin,
		AppID:       d.AppID,
		Status:      d.Status,
		ExpiredTime: d.ExpiredTime.UTC().Format(time.RFC3339),
	}
	if !d.CreatedTime.IsZero() {
		resp.CreatedTime = d.CreatedTime.UTC().Format(time.RFC3339)
	}
	if d.IsolatedTime != nil {
		resp.IsolatedTime = d.IsolatedTime.UTC().Format(time.RFC3339)
	}
	if !d.UpdatedTime.IsZero() {
		resp.UpdatedTime = d.UpdatedTime.UTC().Format(time.RFC3339)
	}
	return resp
}

func writeCloudAPISuccess(w http.ResponseWriter, _ *http.Request, response map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{"Response": response})
}

func writeCloudAPIError(w http.ResponseWriter, r *http.Request, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"Response": map[string]any{
			"Error":     cloudAPIErrorBody{Code: code, Message: message},
			"RequestId": cloudAPIRequestID(r),
		},
	})
}

func cloudAPIRequestID(r *http.Request) string {
	for _, name := range []string{"X-TC-RequestId", "X-Request-ID", "X-Request-Id", "X-CloudLadder-Request-ID"} {
		if value := strings.TrimSpace(r.Header.Get(name)); value != "" {
			return value
		}
	}
	return uuid.NewString()
}

type cloudAPIUserError struct {
	code    string
	message string
}

func (e cloudAPIUserError) Error() string {
	return e.message
}

func cloudAPIErrorCode(err error) string {
	var userErr cloudAPIUserError
	if errors.As(err, &userErr) {
		return userErr.code
	}
	switch {
	case errors.Is(err, errcode.ErrPassNotFound):
		return "ResourceNotFound.Pass"
	case errors.Is(err, errcode.ErrPassInvalidParam), errors.Is(err, errcode.ErrInvalidParam):
		return "InvalidParameter"
	default:
		return "InternalError"
	}
}
