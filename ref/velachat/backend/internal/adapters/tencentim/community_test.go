package tencentim

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tencentimport "chatserver/internal/ports/tencentim"
)

func TestRESTCommunityProvisionerCreatesCommunity(t *testing.T) {
	var body struct {
		OwnerAccount     string `json:"Owner_Account"`
		Type             string `json:"Type"`
		GroupID          string `json:"GroupId"`
		Name             string `json:"Name"`
		Introduction     string `json:"Introduction"`
		ApplyJoinOption  string `json:"ApplyJoinOption"`
		InviteJoinOption string `json:"InviteJoinOption"`
		SupportTopic     int    `json:"SupportTopic"`
		EnablePermission int    `json:"EnablePermission"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v4/group_open_http_svc/create_group" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","GroupId":"@TGS#_C_canary"}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureCommunity(
		context.Background(),
		testCommunity(),
	)
	if err != nil {
		t.Fatalf("EnsureCommunity() error = %v", err)
	}
	if body.OwnerAccount != "u_owner" ||
		body.Type != "Community" ||
		body.GroupID != "@TGS#_C_canary" ||
		body.Name != "工程部" ||
		body.Introduction != "面向 Agent 的协作空间" ||
		body.ApplyJoinOption != "DisableApply" ||
		body.InviteJoinOption != "DisableInvite" ||
		body.SupportTopic != 1 ||
		body.EnablePermission != 0 {
		t.Fatalf("create body = %#v", body)
	}
}

func TestRESTCommunityProvisionerReconcilesAlreadyUsedGroupID(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests++
		switch request.URL.Path {
		case "/v4/group_open_http_svc/create_group":
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"FAIL","ErrorCode":10021,"ErrorInfo":"already used"}`,
			)
		case "/v4/group_open_http_svc/get_group_info":
			var body struct {
				GroupIDList []string `json:"GroupIdList"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body.GroupIDList) != 1 ||
				body.GroupIDList[0] != "@TGS#_C_canary" {
				t.Fatalf("get body = %#v", body)
			}
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","GroupInfo":[{"GroupId":"@TGS#_C_canary","Type":"Community","Name":"工程部","Owner_Account":"u_owner","ErrorCode":0}]}`,
			)
		default:
			t.Fatalf("unexpected path = %q", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	if err := client.EnsureCommunity(
		context.Background(),
		testCommunity(),
	); err != nil {
		t.Fatalf("EnsureCommunity() error = %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestRESTCommunityProvisionerRejectsMismatchedExistingGroup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		switch request.URL.Path {
		case "/v4/group_open_http_svc/create_group":
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"FAIL","ErrorCode":10025,"ErrorInfo":"already used"}`,
			)
		case "/v4/group_open_http_svc/get_group_info":
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","GroupInfo":[{"GroupId":"@TGS#_C_canary","Type":"Community","Name":"other","Owner_Account":"another_owner","SupportTopic":1,"ErrorCode":0}]}`,
			)
		}
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureCommunity(context.Background(), testCommunity())
	if err == nil {
		t.Fatal("EnsureCommunity() error = nil")
	}
	if got := tencentimport.CodeOf(err); got != "tencent_community_conflict" {
		t.Fatalf("CodeOf() = %q", got)
	}
	if tencentimport.IsRetryable(err) {
		t.Fatal("mismatched Community must not retry")
	}
}

func TestRESTCommunityProvisionerClassifiesTencentFailures(t *testing.T) {
	tests := []struct {
		code      int
		retryable bool
	}{
		{code: 10002, retryable: true},
		{code: 10006, retryable: true},
		{code: 10007, retryable: false},
		{code: 10021, retryable: false},
	}
	for _, test := range tests {
		t.Run(tencentCodeName(test.code), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(
				writer http.ResponseWriter,
				_ *http.Request,
			) {
				_, _ = io.WriteString(
					writer,
					`{"ActionStatus":"FAIL","ErrorCode":`+
						tencentCodeName(test.code)+
						`,"ErrorInfo":"private detail"}`,
				)
			}))
			t.Cleanup(server.Close)
			client := newTestRESTCommunityProvisioner(t, server)

			err := client.EnsureCommunity(
				context.Background(),
				testCommunity(),
			)
			if err == nil {
				t.Fatal("EnsureCommunity() error = nil")
			}
			if got := tencentimport.IsRetryable(err); got != test.retryable {
				t.Fatalf("IsRetryable() = %v", got)
			}
			if strings.Contains(err.Error(), "private detail") {
				t.Fatalf("error leaked Tencent response: %v", err)
			}
		})
	}
}

func TestRESTCommunityProvisionerCreatesPrivateTopic(t *testing.T) {
	var body struct {
		GroupID          string `json:"GroupId"`
		TopicID          string `json:"TopicId"`
		TopicName        string `json:"TopicName"`
		FromAccount      string `json:"From_Account"`
		Introduction     string `json:"Introduction"`
		TopicType        string `json:"TopicType"`
		ApplyJoinOption  string `json:"ApplyJoinOption"`
		InviteJoinOption string `json:"InviteJoinOption"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v4/million_group_open_http_svc/create_topic" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"",`+
				`"TopicId":"@TGS#_C_canary@TOPIC#_T_test"}`,
		)
	}))
	defer server.Close()
	client := newTestRESTCommunityProvisioner(t, server)
	err := client.EnsureTopic(context.Background(), tencentimport.Topic{
		GroupID:      "@TGS#_C_canary",
		TopicID:      "@TGS#_C_canary@TOPIC#_T_test",
		TopicName:    "C-TEST",
		OwnerUserID:  "u_owner",
		Introduction: "研发频道",
		Private:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if body.GroupID != "@TGS#_C_canary" ||
		body.TopicID != "@TGS#_C_canary@TOPIC#_T_test" ||
		body.TopicName != "C-TEST" ||
		body.FromAccount != "u_owner" ||
		body.TopicType != "Private" ||
		body.ApplyJoinOption != "DisableApply" ||
		body.InviteJoinOption != "DisableInvite" {
		t.Fatalf("topic body = %#v", body)
	}
}

func TestRESTCommunityProvisionerReconcilesExistingTopic(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		calls++
		switch request.URL.Path {
		case "/v4/million_group_open_http_svc/create_topic":
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"FAIL","ErrorCode":10021,"ErrorInfo":"used"}`,
			)
		case "/v4/million_group_open_http_svc/get_topic":
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"ok",`+
					`"TopicAndSelfInfo":[{"ErrorCode":0,"TopicInfo":{`+
					`"GroupID":"@TGS#_C_canary",`+
					`"TopicId":"@TGS#_C_canary@TOPIC#_T_test",`+
					`"TopicName":"C-TEST","Introduction":"研发频道",`+
					`"TopicType":"Public"}}]}`,
			)
		default:
			t.Fatalf("path = %s", request.URL.Path)
		}
	}))
	defer server.Close()
	client := newTestRESTCommunityProvisioner(t, server)
	err := client.EnsureTopic(context.Background(), tencentimport.Topic{
		GroupID:      "@TGS#_C_canary",
		TopicID:      "@TGS#_C_canary@TOPIC#_T_test",
		TopicName:    "C-TEST",
		OwnerUserID:  "u_owner",
		Introduction: "研发频道",
	})
	if err != nil || calls != 2 {
		t.Fatalf("EnsureTopic() = %v, calls=%d", err, calls)
	}
}

func newTestRESTCommunityProvisioner(
	t *testing.T,
	server *httptest.Server,
) *RESTCommunityProvisioner {
	t.Helper()
	client, err := NewRESTCommunityProvisioner(RESTConfig{
		SDKAppID:    1600000000,
		AdminUserID: "platform_admin",
		BaseURL:     server.URL,
		HTTPClient:  server.Client(),
		Random: strings.NewReader(
			"\x00\x00\x00\x01\x00\x00\x00\x02\x00\x00\x00\x03\x00\x00\x00\x04",
		),
		AdminSignatures: &fixedSigIssuer{value: tencentimport.UserSig{Value: "admin-sig"}},
		AdminSigTTL:     time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func testCommunity() tencentimport.Community {
	return tencentimport.Community{
		GroupID:      "@TGS#_C_canary",
		OwnerUserID:  "u_owner",
		Name:         "工程部",
		Introduction: "面向 Agent 的协作空间",
	}
}

func tencentCodeName(code int) string {
	const digits = "0123456789"
	if code == 0 {
		return "0"
	}
	var reversed [20]byte
	index := len(reversed)
	for code > 0 {
		index--
		reversed[index] = digits[code%10]
		code /= 10
	}
	return string(reversed[index:])
}
