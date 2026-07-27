package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
)

const (
	tencentCloudSaaSLoginURL             = "https://cloud.tencent.com/login/saas/jumpLoginByCode"
	tencentCloudConsoleOrigin            = "https://console.cloud.tencent.com"
	tencentCloudSaaSPlatform             = "Lightclaw"
	defaultTencentCloudConsoleTargetPath = "/developer/security/cancel"
)

func buildTencentCloudConsoleLoginURL(authCode string, targetPath string) (string, error) {
	authCode = strings.TrimSpace(authCode)
	if authCode == "" {
		return "", errors.New("auth code is required")
	}

	targetURL, err := tencentCloudConsoleTargetURL(targetPath)
	if err != nil {
		return "", err
	}

	loginURL, err := url.Parse(tencentCloudSaaSLoginURL)
	if err != nil {
		return "", err
	}
	query := loginURL.Query()
	query.Set("code", authCode)
	query.Set("platform", tencentCloudSaaSPlatform)
	query.Set("s_url", targetURL)
	loginURL.RawQuery = query.Encode()
	return loginURL.String(), nil
}

func tencentCloudConsoleTargetURL(targetPath string) (string, error) {
	targetPath = strings.TrimSpace(targetPath)
	if targetPath == "" {
		targetPath = defaultTencentCloudConsoleTargetPath
	}
	if !strings.HasPrefix(targetPath, "/") ||
		strings.HasPrefix(targetPath, "//") ||
		strings.Contains(targetPath, "\\") ||
		strings.Contains(targetPath, "#") {
		return "", errors.New("target path must be a Tencent Cloud console relative path")
	}

	parsed, err := url.ParseRequestURI(targetPath)
	if err != nil ||
		parsed.IsAbs() ||
		parsed.Host != "" ||
		parsed.User != nil ||
		parsed.Fragment != "" ||
		parsed.Opaque != "" ||
		!strings.HasPrefix(parsed.Path, "/") ||
		strings.HasPrefix(parsed.Path, "//") {
		return "", errors.New("target path must be a Tencent Cloud console relative path")
	}

	return tencentCloudConsoleOrigin + parsed.String(), nil
}

func (h *Handler) CreateTencentCloudRedirect(ctx context.Context, request api.CreateTencentCloudRedirectRequestObject) (api.CreateTencentCloudRedirectResponseObject, error) {
	if gctx := ginContext(ctx); gctx != nil {
		gctx.Header("Cache-Control", "no-store")
	}

	targetPath := ""
	if request.Body != nil {
		targetPath = optionalStringValue(request.Body.TargetPath)
	}
	if _, err := tencentCloudConsoleTargetURL(targetPath); err != nil {
		return api.CreateTencentCloudRedirect400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
				Code:    "invalid_tencent_cloud_target_path",
				Message: "腾讯云控制台跳转路径不合法。",
			}),
		}, nil
	}

	code, err := h.service.IssueTencentCloudConsoleAuthCode(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusUnauthorized:
			return api.CreateTencentCloudRedirect401JSONResponse(body), nil
		case http.StatusConflict:
			return api.CreateTencentCloudRedirect409JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.CreateTencentCloudRedirect503JSONResponse(body), nil
		default:
			return nil, err
		}
	}

	redirectURL, err := buildTencentCloudConsoleLoginURL(code.Code, targetPath)
	if err != nil {
		return nil, err
	}
	return api.CreateTencentCloudRedirect200JSONResponse{
		RedirectUrl: redirectURL,
		ExpiresAt:   code.ExpiresAt,
	}, nil
}
