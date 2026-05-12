package cloudladder

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

type Options struct {
	Enabled        bool
	GatewayBaseURL string
	Caller         string
	Secret         string
}

func (o Options) Validate() error {
	if !o.Enabled {
		return nil
	}
	if strings.TrimSpace(o.GatewayBaseURL) == "" {
		return errors.New("cloudladder gateway base url is required when enabled")
	}
	if strings.TrimSpace(o.Caller) == "" {
		return errors.New("cloudladder caller is required when enabled")
	}
	if o.Secret == "" {
		return errors.New("cloudladder hmac secret is required when enabled")
	}
	if _, err := url.ParseRequestURI(o.GatewayBaseURL); err != nil {
		return fmt.Errorf("cloudladder gateway base url: %w", err)
	}
	return nil
}

func (o Options) TransportForEndpoint(endpoint string) (http.RoundTripper, error) {
	if !o.Enabled {
		return nil, nil
	}
	if err := o.Validate(); err != nil {
		return nil, err
	}
	routeID, err := o.ValidateEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	return cloudladdertransport.New(cloudladdertransport.Options{
		GatewayBaseURL: o.GatewayBaseURL,
		RouteID:        routeID,
		Caller:         o.Caller,
		Secret:         o.Secret,
	})
}

func (o Options) ValidateEndpoint(endpoint string) (string, error) {
	if !o.Enabled {
		return "", nil
	}
	if err := o.Validate(); err != nil {
		return "", err
	}
	return RouteIDForEndpoint(endpoint)
}

func RouteIDForEndpoint(endpoint string) (string, error) {
	host := normalizeEndpointHost(endpoint)
	switch host {
	case "account.dev.tencentcloudapi.com":
		return "tcapi-account-cn-dev", nil
	case "billing.dev.tencentcloudapi.com":
		return "tcapi-billing-cn-dev", nil
	case "account.test.tencentcloudapi.com":
		return "tcapi-account-cn-test", nil
	case "cam.test.tencentcloudapi.com":
		return "tcapi-cam-cn-test", nil
	case "sts.test.tencentcloudapi.com":
		return "tcapi-sts-cn-test", nil
	default:
		return "", fmt.Errorf("unsupported cloudladder tencentcloud endpoint %q", endpoint)
	}
}

func normalizeEndpointHost(endpoint string) string {
	value := strings.TrimSpace(strings.ToLower(endpoint))
	if value == "" {
		return ""
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return strings.TrimSpace(strings.ToLower(endpoint))
	}
	return parsed.Hostname()
}
