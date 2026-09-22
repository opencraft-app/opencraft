package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
)

const (
	personalDevCapabilityHeader       = "X-LightVela-Developer-Capability"
	personalDevUINHeader              = "X-LightVela-Developer-UIN"
	personalDevOriginalAuthHeader     = "X-LightVela-Developer-Original-Authorization"
	personalDevBillingProxyMaxBody    = int64(1 << 20)
	personalDevBillingProxyJifeiKind  = "jifei"
	personalDevBillingProxyCloudKind  = "cloudapi"
	personalDevBillingProxyJifeiPath  = "/resource-center/interface"
	personalDevBillingProxyTimeout    = 30 * time.Second
	personalDevBillingProxyTargetBase = "/internal/trade/personal-dev/billing-proxy"
)

type personalDevBillingProxy struct {
	verifier devroute.CapabilityVerifier
	target   *url.URL
	token    string
	client   *http.Client
}

func newPersonalDevBillingProxy(config ServerConfig) (*personalDevBillingProxy, error) {
	if !config.PersonalDevBillingProxyEnabled {
		return nil, nil
	}
	target, err := url.Parse(strings.TrimRight(strings.TrimSpace(config.PersonalDevBillingProxyURL), "/"))
	if err != nil || target.Scheme == "" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" ||
		(target.Scheme != "http" && target.Scheme != "https") || target.EscapedPath() != personalDevBillingProxyTargetBase {
		return nil, errors.New("personal DevCloud billing proxy URL must be the exact internal Trade proxy base")
	}
	if strings.TrimSpace(config.PersonalDevBillingProxyToken) == "" || config.DeveloperRouteRegistry == nil {
		return nil, errors.New("personal DevCloud billing proxy requires the internal token and developer route registry")
	}
	client := config.PersonalDevBillingProxyClient
	if client == nil {
		client = &http.Client{Timeout: personalDevBillingProxyTimeout}
	}
	return &personalDevBillingProxy{
		verifier: devroute.CapabilityVerifier{Registry: config.DeveloperRouteRegistry},
		target:   target,
		token:    strings.TrimSpace(config.PersonalDevBillingProxyToken),
		client:   client,
	}, nil
}

func registerPersonalDevBillingProxyRoutes(router gin.IRoutes, proxy *personalDevBillingProxy) {
	if proxy == nil {
		return
	}
	router.POST("/auth/dev-environments/billing-proxy/:kind/*path", proxy.handle)
}

func (p *personalDevBillingProxy) handle(ctx *gin.Context) {
	kind := strings.ToLower(strings.TrimSpace(ctx.Param("kind")))
	path := ctx.Param("path")
	if !validPersonalDevBillingProxyTarget(kind, path) {
		ctx.JSON(http.StatusNotFound, api.ErrorResponse{Code: "personal_dev_billing_proxy_target_not_allowed", Message: "testing billing proxy target is not allowed"})
		return
	}
	capability := strings.TrimSpace(ctx.GetHeader(personalDevCapabilityHeader))
	registration, err := p.verifier.Verify(ctx.Request.Context(), capability)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, api.ErrorResponse{Code: "personal_dev_capability_invalid", Message: "personal DevCloud capability is invalid or expired"})
		return
	}
	body, err := readPersonalDevBillingProxyBody(ctx.Request)
	if err != nil {
		ctx.JSON(http.StatusRequestEntityTooLarge, api.ErrorResponse{Code: "request_too_large", Message: err.Error()})
		return
	}
	if err := validatePersonalDevBillingProxyUIN(
		kind,
		body,
		ctx.Request.URL.RawQuery,
		ctx.GetHeader("X-Qcloud-User-Id"),
		ctx.GetHeader("X-TC-Action"),
		registration.UIN,
	); err != nil {
		ctx.JSON(http.StatusForbidden, api.ErrorResponse{Code: "personal_dev_uin_mismatch", Message: "billing request does not belong to the registered testing UIN"})
		return
	}

	target := *p.target
	target.Path = strings.TrimRight(p.target.Path, "/") + "/" + kind + path
	target.RawQuery = ctx.Request.URL.RawQuery
	request, err := http.NewRequestWithContext(ctx.Request.Context(), http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_billing_proxy_unavailable", Message: "could not build testing billing proxy request"})
		return
	}
	copyPersonalDevBillingHeaders(request.Header, ctx.Request.Header)
	if kind == personalDevBillingProxyCloudKind {
		request.Header.Set(personalDevOriginalAuthHeader, strings.TrimSpace(ctx.GetHeader("Authorization")))
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set(personalDevUINHeader, registration.UIN)

	response, err := p.client.Do(request)
	if err != nil {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_billing_proxy_unavailable", Message: "testing billing proxy is unavailable"})
		return
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, personalDevBillingProxyMaxBody+1))
	if readErr != nil || int64(len(responseBody)) > personalDevBillingProxyMaxBody {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_billing_proxy_invalid_response", Message: "testing billing proxy returned an invalid response"})
		return
	}
	if value := strings.TrimSpace(response.Header.Get("Content-Type")); value != "" {
		ctx.Header("Content-Type", value)
	}
	for _, name := range []string{"X-QCloud-Transaction-ID", "X-Request-ID"} {
		if value := strings.TrimSpace(response.Header.Get(name)); value != "" {
			ctx.Header(name, value)
		}
	}
	ctx.Data(response.StatusCode, response.Header.Get("Content-Type"), responseBody)
}

func validPersonalDevBillingProxyTarget(kind, path string) bool {
	switch kind {
	case personalDevBillingProxyJifeiKind:
		return path == personalDevBillingProxyJifeiPath
	case personalDevBillingProxyCloudKind:
		return path == "/"
	default:
		return false
	}
}

func readPersonalDevBillingProxyBody(request *http.Request) ([]byte, error) {
	if request == nil || request.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, personalDevBillingProxyMaxBody+1))
	if err != nil || int64(len(body)) > personalDevBillingProxyMaxBody {
		return nil, errors.New("billing proxy request body is too large")
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}

func validatePersonalDevBillingProxyUIN(kind string, body []byte, rawQuery, cloudUserHeader, cloudActionHeader, expected string) error {
	if kind == personalDevBillingProxyCloudKind {
		action := strings.TrimSpace(cloudActionHeader)
		switch action {
		case "CreatePayUrl", "DescribeOrderList":
		default:
			return errors.New("cloud billing action is not allowed")
		}
		query, err := url.ParseQuery(rawQuery)
		queryActions := query["Action"]
		if err != nil || len(queryActions) != 1 || strings.TrimSpace(queryActions[0]) != action {
			return errors.New("cloud billing query action mismatch")
		}
		// X-Qcloud-User-Id is the testing route's service account, not the
		// purchasing user's UIN. Personal clients must not choose it; central
		// testing Trade injects the site-owned value after capability checks.
		if strings.TrimSpace(cloudUserHeader) != "" {
			return errors.New("cloud billing route UIN must be injected centrally")
		}
		return nil
	}
	var envelope struct {
		Interface struct {
			InterfaceName string `json:"interfaceName"`
			ExtraPara     struct {
				OwnerUIN string `json:"ownerUin"`
			} `json:"extraPara"`
			Para struct {
				UIN string `json:"uin"`
			} `json:"para"`
		} `json:"interface"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Interface.InterfaceName != "qcloud.operation.ModifyResourceStatus" {
		return errors.New("unsupported jifei billing envelope")
	}
	expected = strings.TrimSpace(expected)
	if strings.TrimSpace(envelope.Interface.ExtraPara.OwnerUIN) != expected || strings.TrimSpace(envelope.Interface.Para.UIN) != expected {
		return errors.New("jifei billing UIN mismatch")
	}
	return nil
}

func copyPersonalDevBillingHeaders(destination, source http.Header) {
	for _, name := range []string{
		"Content-Type", "Authorization", "X-TC-Action", "X-TC-Version", "X-TC-Region", "X-TC-Timestamp", "X-TC-Token",
		"X-Qcloud-User-Id", "X-QCloud-Transaction-ID", "X-QCloud-Component-ID", "X-CloudLadder-Signed-Host",
	} {
		for _, value := range source.Values(name) {
			destination.Add(name, value)
		}
	}
}
