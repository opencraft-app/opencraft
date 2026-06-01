package httpapi

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestWeChatOAuthHTTPClientResolveIdentityUsesTokenUnionID(t *testing.T) {
	t.Parallel()

	client := &wechatOAuthHTTPClient{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if got := req.URL.String(); !strings.Contains(got, "/sns/userinfo?") {
					t.Fatalf("expected userinfo request, got %q", got)
				}
				return jsonHTTPResponse(http.StatusOK, `{"openid":"openid-1","nickname":"微信用户A","headimgurl":"https://wx.example/avatar-a.jpg","unionid":"profile-unionid-a"}`), nil
			}),
		},
	}

	identity, err := client.ResolveIdentity(context.Background(), &WeChatOAuthToken{
		AccessToken: "token-a",
		OpenID:      "openid-1",
		UnionID:     "token-unionid-a",
	})
	if err != nil {
		t.Fatalf("resolve identity failed: %v", err)
	}
	if identity.Provider != "wechat" {
		t.Fatalf("expected provider wechat, got %q", identity.Provider)
	}
	if identity.ProviderSubject != "token-unionid-a" {
		t.Fatalf("expected token unionid subject, got %q", identity.ProviderSubject)
	}
}

func TestWeChatOAuthHTTPClientResolveIdentityFallsBackToProfileUnionID(t *testing.T) {
	t.Parallel()

	client := &wechatOAuthHTTPClient{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				return jsonHTTPResponse(http.StatusOK, `{"openid":"openid-2","nickname":"微信用户B","headimgurl":"https://wx.example/avatar-b.jpg","unionid":"profile-unionid-b"}`), nil
			}),
		},
	}

	identity, err := client.ResolveIdentity(context.Background(), &WeChatOAuthToken{
		AccessToken: "token-b",
		OpenID:      "openid-2",
	})
	if err != nil {
		t.Fatalf("resolve identity failed: %v", err)
	}
	if identity.ProviderSubject != "profile-unionid-b" {
		t.Fatalf("expected profile unionid subject, got %q", identity.ProviderSubject)
	}
}

func TestWeChatOAuthHTTPClientResolveIdentityRejectsOpenIDOnlyIdentity(t *testing.T) {
	t.Parallel()

	client := &wechatOAuthHTTPClient{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				return jsonHTTPResponse(http.StatusOK, `{"openid":"openid-3","nickname":"微信用户C","headimgurl":"https://wx.example/avatar-c.jpg"}`), nil
			}),
		},
	}

	_, err := client.ResolveIdentity(context.Background(), &WeChatOAuthToken{
		AccessToken: "token-c",
		OpenID:      "openid-3",
	})
	if err == nil || !strings.Contains(err.Error(), "unionid missing") {
		t.Fatalf("expected unionid missing error, got %v", err)
	}
}

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func jsonHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
