package gojaim

import (
	"context"
	"errors"
	"testing"
)

func TestDefaultNetworkPolicyAllowsTencentIMAndSignedCOSMediaEndpoints(t *testing.T) {
	policy := DefaultNetworkPolicy()
	for _, endpoint := range []struct {
		rawURL string
		kind   EndpointKind
	}{
		{
			rawURL: "wss://1600154578w4c.my-imcloud.com/binfo",
			kind:   EndpointWebSocket,
		},
		{
			rawURL: "wss://wss.im.qcloud.com/binfo",
			kind:   EndpointWebSocket,
		},
		{
			rawURL: "https://events.im.qcloud.com/v3/netcheck/getconninfo",
			kind:   EndpointHTTP,
		},
		{
			rawURL: "https://im-media-1250000000.cos.ap-shanghai.myqcloud.com/object",
			kind:   EndpointHTTP,
		},
		{
			rawURL: "https://im-media-1250000000.cos.ap-shanghai.tencentcos.cn/object",
			kind:   EndpointHTTP,
		},
		{
			rawURL: "https://im-media-1250000000.cos.accelerate.tencentcos.cn/object",
			kind:   EndpointHTTP,
		},
	} {
		if err := policy.Validate(endpoint.rawURL, endpoint.kind); err != nil {
			t.Fatalf("Validate(%q): %v", endpoint.rawURL, err)
		}
	}
}

func TestNetworkHostRejectsDeniedTargetsBeforeDial(t *testing.T) {
	host := NewNetworkHost(NetworkHostConfig{})
	if _, err := host.OpenWebSocket(
		context.Background(),
		"wss://127.0.0.1/binfo",
		func(SocketEvent) {},
	); !errors.Is(err, ErrEndpointDenied) {
		t.Fatalf("OpenWebSocket error = %v, want ErrEndpointDenied", err)
	}
	if _, err := host.StartFetch(
		context.Background(),
		FetchRequest{
			Method: "GET",
			URL:    "https://localhost/check",
		},
		func(FetchResult) {},
	); !errors.Is(err, ErrEndpointDenied) {
		t.Fatalf("StartFetch error = %v, want ErrEndpointDenied", err)
	}
}

func TestDefaultNetworkPolicyRejectsUnsafeEndpoints(t *testing.T) {
	policy := DefaultNetworkPolicy()
	for _, endpoint := range []struct {
		rawURL string
		kind   EndpointKind
	}{
		{"ws://wss.im.qcloud.com/binfo", EndpointWebSocket},
		{"wss://127.0.0.1/binfo", EndpointWebSocket},
		{"wss://wss.im.qcloud.com.evil.example/binfo", EndpointWebSocket},
		{"wss://user@wss.im.qcloud.com/binfo", EndpointWebSocket},
		{"wss://wss.im.qcloud.com:8443/binfo", EndpointWebSocket},
		{"http://events.im.qcloud.com/check", EndpointHTTP},
		{"https://localhost/check", EndpointHTTP},
		{"https://evil.myqcloud.com/object", EndpointHTTP},
		{"https://cos.ap-shanghai.myqcloud.com.evil.example/object", EndpointHTTP},
		{"https://bucket.notcos.ap-shanghai.myqcloud.com/object", EndpointHTTP},
		{"https://bucket.tencentcos.cn/object", EndpointHTTP},
		{"wss://bucket.cos.ap-shanghai.myqcloud.com/object", EndpointWebSocket},
	} {
		err := policy.Validate(endpoint.rawURL, endpoint.kind)
		if !errors.Is(err, ErrEndpointDenied) {
			t.Fatalf(
				"Validate(%q) error = %v, want ErrEndpointDenied",
				endpoint.rawURL,
				err,
			)
		}
	}
}
