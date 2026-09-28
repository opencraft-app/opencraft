package cloudbillingclient

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

const personalDevCapabilityHeader = "X-LightVela-Developer-Capability"

type personalDevProxyTransport struct {
	baseURL    *url.URL
	capability string
	base       http.RoundTripper
}

func newPersonalDevProxyTransport(cfg PersonalDevProxyConfig, base http.RoundTripper) (http.RoundTripper, error) {
	baseURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("personal DevCloud billing proxy base URL must include only scheme, host, and path")
	}
	capability := strings.TrimSpace(cfg.Capability)
	if capability == "" {
		return nil, errors.New("personal DevCloud billing capability is required")
	}
	if base == nil {
		base = http.DefaultTransport
	}
	return &personalDevProxyTransport{baseURL: baseURL, capability: capability, base: base}, nil
}

func (t *personalDevProxyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil || request.URL == nil {
		return nil, errors.New("personal DevCloud billing proxy request URL is required")
	}
	out := request.Clone(request.Context())
	target := *t.baseURL
	target.Path = strings.TrimRight(t.baseURL.Path, "/") + "/cloudapi" + request.URL.EscapedPath()
	target.RawPath = ""
	target.RawQuery = request.URL.RawQuery
	out.URL = &target
	out.Host = ""
	out.RequestURI = ""
	out.Header = request.Header.Clone()
	preserveTencentCloudHeaderCase(out.Header)
	// This header selects a testing CloudLadder service route. It is not the
	// business owner's UIN and must be supplied by central testing Trade.
	out.Header.Del(headerXQCloudUserID)
	out.Header.Set(personalDevCapabilityHeader, t.capability)
	return t.base.RoundTrip(out)
}
