package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"ctl/pkg/errcode"
	passlogic "ctl/pkg/logic/pass"

	"github.com/google/uuid"
)

const (
	cloudAPIActionDescribePass = "DescribePass"
	cloudAPIDefaultVersion     = "2026-08-06"
)

var (
	cloudAPIConfigOnce   sync.Once
	cachedCloudAPIConfig cloudAPIConfig
)

type cloudAPIConfig struct {
	Version        string
	AllowedRegions map[string]struct{}
}

type describePassCloudAPIRequest struct {
	Uin    string `json:"Uin"`
	AppID  *int64 `json:"AppId"`
	PassID string `json:"PassId"`
}

type cloudAPIPass struct {
	PassID         string `json:"PassId"`
	ExternalUserID string `json:"ExternalUserId"`
	BundleID       string `json:"BundleId"`
	Uin            int64  `json:"Uin"`
	AppID          int64  `json:"AppId"`
	Status         string `json:"Status"`
	CreatedTime    string `json:"CreatedTime,omitempty"`
	ExpiredTime    string `json:"ExpiredTime"`
	IsolatedTime   string `json:"IsolatedTime,omitempty"`
	UpdatedTime    string `json:"UpdatedTime,omitempty"`
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

	cfg := getCloudAPIConfig()
	if err := validateCloudAPIHeaders(r, cfg); err != nil {
		writeCloudAPIError(w, r, cloudAPIErrorCode(err), err.Error())
		return
	}

	var req describePassCloudAPIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeCloudAPIError(w, r, "InvalidParameter.RequestBody", "request body must be valid json")
		return
	}
	uin, err := parseCloudAPIUin(req.Uin)
	if err != nil {
		writeCloudAPIError(w, r, "InvalidParameter.Uin", err.Error())
		return
	}
	var appID int64
	if req.AppID != nil {
		if *req.AppID <= 0 {
			writeCloudAPIError(w, r, "InvalidParameter.AppId", "AppId must be > 0")
			return
		}
		appID = *req.AppID
	}
	req.PassID = strings.TrimSpace(req.PassID)

	detail, err := h.logic.DescribePassByCloudAccount(uin, appID, req.PassID)
	if err != nil {
		writeCloudAPIError(w, r, cloudAPIErrorCode(err), err.Error())
		return
	}
	writeCloudAPISuccess(w, r, map[string]any{
		"RequestId": cloudAPIRequestID(r),
		"Pass":      detailToCloudAPIPass(detail),
	})
}

func getCloudAPIConfig() cloudAPIConfig {
	cloudAPIConfigOnce.Do(func() {
		cachedCloudAPIConfig = loadCloudAPIConfigFromEnv()
	})
	return cachedCloudAPIConfig
}

func loadCloudAPIConfigFromEnv() cloudAPIConfig {
	version := strings.TrimSpace(os.Getenv("CTL_CLOUDAPI_VERSION"))
	if version == "" {
		version = cloudAPIDefaultVersion
	}
	return cloudAPIConfig{
		Version:        version,
		AllowedRegions: parseCloudAPIAllowedRegions(os.Getenv("CTL_CLOUDAPI_ALLOWED_REGIONS")),
	}
}

func resetCloudAPIConfigForTest() {
	cloudAPIConfigOnce = sync.Once{}
	cachedCloudAPIConfig = cloudAPIConfig{}
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

func parseCloudAPIUin(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, cloudAPIUserError{code: "InvalidParameter.Uin", message: "Uin is required"}
	}
	uin, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || uin <= 0 {
		return 0, cloudAPIUserError{code: "InvalidParameter.Uin", message: "Uin must be a positive integer string"}
	}
	return uin, nil
}

func detailToCloudAPIPass(d *passlogic.PassDetail) *cloudAPIPass {
	resp := &cloudAPIPass{
		PassID:         d.PassID,
		ExternalUserID: d.UserID,
		BundleID:       d.BundleID,
		Uin:            d.Uin,
		AppID:          d.AppID,
		Status:         d.Status,
		ExpiredTime:    d.ExpiredTime.UTC().Format(time.RFC3339),
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
