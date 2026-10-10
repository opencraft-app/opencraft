package tencentim

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	tencentimport "chatserver/internal/ports/tencentim"
)

type fixedSigIssuer struct {
	value     tencentimport.UserSig
	userID    string
	ttl       time.Duration
	returnErr error
}

func (issuer *fixedSigIssuer) Issue(
	_ context.Context,
	userID string,
	ttl time.Duration,
) (tencentimport.UserSig, error) {
	issuer.userID = userID
	issuer.ttl = ttl
	return issuer.value, issuer.returnErr
}

func TestRESTIdentityProvisionerImportsAccountWithAdminSignature(t *testing.T) {
	var (
		gotQuery url.Values
		gotBody  map[string]string
	)
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s", request.Method)
		}
		if request.URL.Path != "/v4/im_open_login_svc/account_import" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		gotQuery = request.URL.Query()
		if err := json.NewDecoder(request.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":""}`,
		)
	}))
	t.Cleanup(server.Close)
	randomBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(randomBytes, 123456789)
	signatures := &fixedSigIssuer{value: tencentimport.UserSig{Value: "admin-sig"}}
	client, err := NewRESTIdentityProvisioner(RESTConfig{
		SDKAppID:        1600000000,
		AdminUserID:     "platform_admin",
		BaseURL:         server.URL,
		HTTPClient:      server.Client(),
		Random:          strings.NewReader(string(randomBytes)),
		AdminSignatures: signatures,
		AdminSigTTL:     5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("NewRESTIdentityProvisioner() error = %v", err)
	}

	err = client.EnsureIdentity(context.Background(), tencentimport.Identity{
		UserID: "u_F5IDF2DMGMGAIHS3OIOZOJZHT4S5E",
		Nick:   "爱丽丝",
	})
	if err != nil {
		t.Fatalf("EnsureIdentity() error = %v", err)
	}
	if signatures.userID != "platform_admin" ||
		signatures.ttl != 5*time.Minute {
		t.Fatalf("signature request = (%q, %v)", signatures.userID, signatures.ttl)
	}
	if gotQuery.Get("sdkappid") != "1600000000" ||
		gotQuery.Get("identifier") != "platform_admin" ||
		gotQuery.Get("usersig") != "admin-sig" ||
		gotQuery.Get("random") != "123456789" ||
		gotQuery.Get("contenttype") != "json" {
		t.Fatalf("query = %#v", gotQuery)
	}
	if gotBody["UserID"] != "u_F5IDF2DMGMGAIHS3OIOZOJZHT4S5E" ||
		gotBody["Nick"] != "爱丽丝" {
		t.Fatalf("body = %#v", gotBody)
	}
}

func TestRESTIdentityProvisionerKicksAndDeletesAccount(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		paths = append(paths, request.URL.Path)
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v4/im_open_login_svc/kick":
			var body struct {
				UserID string `json:"UserID"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.UserID != "a_delete_test" {
				t.Fatalf("kick body = %#v", body)
			}
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":""}`)
		case "/v4/im_open_login_svc/account_delete":
			var body struct {
				DeleteItem []struct {
					UserID string `json:"UserID"`
				} `json:"DeleteItem"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body.DeleteItem) != 1 || body.DeleteItem[0].UserID != "a_delete_test" {
				t.Fatalf("account_delete body = %#v", body)
			}
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","ResultItem":[{"UserID":"a_delete_test","ResultCode":0,"ResultInfo":""}]}`)
		default:
			t.Fatalf("unexpected path = %s", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	client := newTestRESTIdentityProvisioner(t, server)
	if err := client.KickIdentity(context.Background(), "a_delete_test"); err != nil {
		t.Fatalf("KickIdentity() error = %v", err)
	}
	if err := client.DeleteIdentity(context.Background(), "a_delete_test"); err != nil {
		t.Fatalf("DeleteIdentity() error = %v", err)
	}
	if len(paths) != 2 || paths[0] != "/v4/im_open_login_svc/kick" ||
		paths[1] != "/v4/im_open_login_svc/account_delete" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestRESTIdentityProvisionerClassifiesDeleteResultItem(t *testing.T) {
	tests := []struct {
		name      string
		result    int
		wantError bool
		retryable bool
		code      string
	}{
		{name: "already absent", result: 70107},
		{name: "plan unsupported", result: 71000, wantError: true, code: "tencent_71000"},
		{name: "server timeout", result: 70169, wantError: true, retryable: true, code: "tencent_70169"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(writer, fmt.Sprintf(
					`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","ResultItem":[{"UserID":"a_delete_test","ResultCode":%d,"ResultInfo":"secret detail"}]}`,
					test.result,
				))
			}))
			t.Cleanup(server.Close)
			client := newTestRESTIdentityProvisioner(t, server)
			err := client.DeleteIdentity(context.Background(), "a_delete_test")
			if test.wantError != (err != nil) {
				t.Fatalf("DeleteIdentity() error = %v", err)
			}
			if err != nil && (tencentimport.CodeOf(err) != test.code ||
				tencentimport.IsRetryable(err) != test.retryable ||
				strings.Contains(err.Error(), "secret")) {
				t.Fatalf("classified error = %v", err)
			}
		})
	}
}

func TestRESTIdentityProvisionerTreatsKickOfMissingAccountAsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"ActionStatus":"FAIL","ErrorCode":70107,"ErrorInfo":"secret detail"}`)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTIdentityProvisioner(t, server)
	if err := client.KickIdentity(context.Background(), "a_delete_test"); err != nil {
		t.Fatalf("KickIdentity(missing) error = %v", err)
	}
}

func TestRESTIdentityProvisionerClassifiesTencentFailures(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		retryable bool
		code      string
	}{
		{
			name:      "service unavailable",
			status:    http.StatusServiceUnavailable,
			body:      "upstream internals",
			retryable: true,
			code:      "tencent_http_503",
		},
		{
			name:      "timeout business code",
			status:    http.StatusOK,
			body:      `{"ActionStatus":"FAIL","ErrorCode":70169,"ErrorInfo":"internal detail"}`,
			retryable: true,
			code:      "tencent_70169",
		},
		{
			name:      "permission denied",
			status:    http.StatusOK,
			body:      `{"ActionStatus":"FAIL","ErrorCode":70403,"ErrorInfo":"secret detail"}`,
			retryable: false,
			code:      "tencent_70403",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(
				writer http.ResponseWriter,
				_ *http.Request,
			) {
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, test.body)
			}))
			t.Cleanup(server.Close)
			client := newTestRESTIdentityProvisioner(t, server)

			err := client.EnsureIdentity(
				context.Background(),
				tencentimport.Identity{UserID: "u_valid-user"},
			)
			if err == nil {
				t.Fatal("EnsureIdentity() error = nil")
			}
			if got := tencentimport.IsRetryable(err); got != test.retryable {
				t.Fatalf("IsRetryable() = %v", got)
			}
			if got := tencentimport.CodeOf(err); got != test.code {
				t.Fatalf("CodeOf() = %q, want %q", got, test.code)
			}
			if strings.Contains(err.Error(), "detail") ||
				strings.Contains(err.Error(), "internals") {
				t.Fatalf("error leaked upstream body: %v", err)
			}
		})
	}
}

func TestRESTIdentityProvisionerTreatsNetworkFailureAsRetryable(t *testing.T) {
	client, err := NewRESTIdentityProvisioner(RESTConfig{
		SDKAppID:    1600000000,
		AdminUserID: "platform_admin",
		BaseURL:     "https://im.invalid",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial secret internal address")
		})},
		Random:          strings.NewReader("\x00\x00\x00\x01\x00\x00\x00\x02"),
		AdminSignatures: &fixedSigIssuer{value: tencentimport.UserSig{Value: "admin-sig"}},
		AdminSigTTL:     time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	err = client.EnsureIdentity(
		context.Background(),
		tencentimport.Identity{UserID: "u_valid-user"},
	)
	if !tencentimport.IsRetryable(err) ||
		tencentimport.CodeOf(err) != "tencent_network_error" {
		t.Fatalf("EnsureIdentity() error = %v", err)
	}
	if strings.Contains(err.Error(), "secret internal address") {
		t.Fatalf("error leaked network detail: %v", err)
	}
}

func TestRESTIdentityProvisionerNeverFollowsRedirectWithAdminUserSig(t *testing.T) {
	redirected := false
	sink := httptest.NewServer(http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		redirected = true
	}))
	t.Cleanup(sink.Close)
	source := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		http.Redirect(writer, request, sink.URL, http.StatusFound)
	}))
	t.Cleanup(source.Close)
	client := newTestRESTIdentityProvisioner(t, source)

	err := client.EnsureIdentity(
		context.Background(),
		tencentimport.Identity{UserID: "u_valid-user"},
	)
	if err == nil {
		t.Fatal("EnsureIdentity() redirect error = nil")
	}
	if redirected {
		t.Fatal("REST client followed redirect carrying sensitive query")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	return function(request)
}

func newTestRESTIdentityProvisioner(
	t *testing.T,
	server *httptest.Server,
) *RESTIdentityProvisioner {
	t.Helper()
	client, err := NewRESTIdentityProvisioner(RESTConfig{
		SDKAppID:        1600000000,
		AdminUserID:     "platform_admin",
		BaseURL:         server.URL,
		HTTPClient:      server.Client(),
		Random:          strings.NewReader("\x00\x00\x00\x01\x00\x00\x00\x02"),
		AdminSignatures: &fixedSigIssuer{value: tencentimport.UserSig{Value: "admin-sig"}},
		AdminSigTTL:     time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}
