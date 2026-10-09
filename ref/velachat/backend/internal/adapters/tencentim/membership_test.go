package tencentim

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	tencentimport "chatserver/internal/ports/tencentim"
)

func TestRESTCommunityProvisionerEnsuresCommunityMember(t *testing.T) {
	var body struct {
		GroupID    string `json:"GroupId"`
		TopicID    string `json:"TopicId"`
		Silence    int    `json:"Silence"`
		MemberList []struct {
			Account string `json:"Member_Account"`
		} `json:"MemberList"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v4/group_open_http_svc/add_group_member" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"MemberList":[`+
				`{"Member_Account":"u_human","Result":2}]}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			UserID:  "u_human",
		},
	)

	if err != nil {
		t.Fatalf("EnsureMember() error = %v", err)
	}
	if body.GroupID != "@TGS#_C_canary" ||
		body.TopicID != "" ||
		body.Silence != 1 ||
		len(body.MemberList) != 1 ||
		body.MemberList[0].Account != "u_human" {
		t.Fatalf("body = %#v", body)
	}
}

func TestRESTCommunityProvisionerEnsuresPrivateTopicMember(t *testing.T) {
	var topicID string
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		var body struct {
			TopicID string `json:"TopicId"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		topicID = body.TopicID
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"MemberList":[`+
				`{"Member_Account":"u_human","Result":1}]}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			TopicID: "@TGS#_C_canary@TOPIC#_T_private",
			UserID:  "u_human",
		},
	)

	if err != nil {
		t.Fatal(err)
	}
	if topicID != "@TGS#_C_canary@TOPIC#_T_private" {
		t.Fatalf("TopicId = %q", topicID)
	}
}

func TestRESTCommunityProvisionerTreatsTopLevelAlreadyMemberAsSuccess(
	t *testing.T,
) {
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"FAIL","ErrorCode":10013,`+
				`"ErrorInfo":"already a group member"}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			UserID:  "u_human",
		},
	)

	if err != nil {
		t.Fatalf("EnsureMember() error = %v", err)
	}
}

func TestRESTCommunityProvisionerRemovesPrivateTopicMember(t *testing.T) {
	var body struct {
		GroupID   string   `json:"GroupId"`
		TopicID   string   `json:"TopicId"`
		Silence   int      `json:"Silence"`
		MemberIDs []string `json:"MemberToDel_Account"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v4/group_open_http_svc/delete_group_member" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.RemoveMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			TopicID: "@TGS#_C_canary@TOPIC#_T_private",
			UserID:  "u_human",
		},
	)

	if err != nil {
		t.Fatal(err)
	}
	if body.GroupID != "@TGS#_C_canary" ||
		body.TopicID != "@TGS#_C_canary@TOPIC#_T_private" ||
		body.Silence != 1 ||
		len(body.MemberIDs) != 1 ||
		body.MemberIDs[0] != "u_human" {
		t.Fatalf("body = %#v", body)
	}
}

func TestRESTCommunityProvisionerRejectsFailedMemberResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"MemberList":[`+
				`{"Member_Account":"u_human","Result":0}]}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			UserID:  "u_human",
		},
	)

	if got := tencentimport.CodeOf(err); got != "tencent_member_add_failed" {
		t.Fatalf("CodeOf() = %q, err = %v", got, err)
	}
}

func TestRESTCommunityProvisionerRetriesPrivateTopicMembershipUntilTopicExists(
	t *testing.T,
) {
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"FAIL","ErrorCode":10010,`+
				`"ErrorInfo":"topic not found"}`,
		)
	}))
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)

	err := client.EnsureMember(
		context.Background(),
		tencentimport.Membership{
			GroupID: "@TGS#_C_canary",
			TopicID: "@TGS#_C_canary@TOPIC#_T_private",
			UserID:  "u_human",
		},
	)

	if err == nil || !tencentimport.IsRetryable(err) {
		t.Fatalf("EnsureMember() error = %v, want retryable", err)
	}
}
