package gojaim

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

var ErrEndpointDenied = errors.New("LiteChat 网络目标不在允许列表")

type EndpointKind string

const (
	EndpointWebSocket EndpointKind = "websocket"
	EndpointHTTP      EndpointKind = "http"
)

type NetworkPolicy struct {
	webSocketSuffixes []string
	httpSuffixes      []string
}

func DefaultNetworkPolicy() NetworkPolicy {
	return NetworkPolicy{
		webSocketSuffixes: []string{
			"im.qcloud.com",
			"im.tencent.cn",
			"my-cpaas.com",
			"my-imcloud.com",
			"tim.qq.com",
		},
		httpSuffixes: []string{
			"im.qcloud.com",
			"my-imcloud.com",
		},
	}
}

func (p NetworkPolicy) Validate(
	rawURL string,
	kind EndpointKind,
) error {
	parsed, err := url.Parse(rawURL)
	if err != nil ||
		parsed.User != nil ||
		parsed.Hostname() == "" ||
		parsed.Fragment != "" {
		return ErrEndpointDenied
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.HasSuffix(host, ".") || net.ParseIP(host) != nil {
		return ErrEndpointDenied
	}
	port := parsed.Port()
	if port != "" && port != "443" {
		return ErrEndpointDenied
	}

	var expectedScheme string
	var suffixes []string
	switch kind {
	case EndpointWebSocket:
		expectedScheme = "wss"
		suffixes = p.webSocketSuffixes
	case EndpointHTTP:
		expectedScheme = "https"
		suffixes = p.httpSuffixes
	default:
		return ErrEndpointDenied
	}
	if parsed.Scheme != expectedScheme {
		return ErrEndpointDenied
	}
	for _, suffix := range suffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return nil
		}
	}
	if kind == EndpointHTTP && isTencentCOSHost(host) {
		return nil
	}
	return ErrEndpointDenied
}

func isTencentCOSHost(host string) bool {
	for _, suffix := range []string{"myqcloud.com", "tencentcos.cn"} {
		if !strings.HasSuffix(host, "."+suffix) {
			continue
		}
		prefix := strings.TrimSuffix(host, "."+suffix)
		labels := strings.Split(prefix, ".")
		for index, label := range labels {
			if label == "cos" || index > 0 && isTencentCOSServiceLabel(label) {
				return true
			}
		}
	}
	return false
}

func isTencentCOSServiceLabel(label string) bool {
	if strings.HasPrefix(label, "cos-") {
		return true
	}
	if !strings.HasPrefix(label, "cos") || len(label) <= len("cos") {
		return false
	}
	for _, character := range strings.TrimPrefix(label, "cos") {
		if character < 'a' || character > 'z' {
			return false
		}
	}
	return true
}
