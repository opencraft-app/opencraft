package tencentim

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

const testPlatformGroupID = "vg_0198f4c27a357f1486ab2e57552e473f"

func newTestRESTGroupManager(t *testing.T, server *httptest.Server) *RESTGroupManager {
	t.Helper()
	return &RESTGroupManager{client: newTestRESTCommunityProvisioner(t, server)}
}

func TestRESTGroupManagerCreatesPublicGroupOwnedByCreator(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != createGroupPath {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupId":"`+testPlatformGroupID+`"}`)
	}))
	t.Cleanup(server.Close)

	err := newTestRESTGroupManager(t, server).EnsureGroup(context.Background(), botimport.TencentGroup{
		GroupID: testPlatformGroupID, Name: "评审", OwnerUserID: "u_owner", MemberUserIDs: []string{"a_bot"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["Type"] != "Public" || body["Owner_Account"] != "u_owner" || body["GroupId"] != testPlatformGroupID ||
		body["ApplyJoinOption"] != "DisableApply" {
		t.Fatalf("create body = %#v", body)
	}
	members := body["MemberList"].([]any)
	if len(members) != 1 || members[0].(map[string]any)["Member_Account"] != "a_bot" {
		t.Fatalf("members = %#v", members)
	}
}

func TestRESTGroupManagerReconcilesExistingGroupAndAddsMembers(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case createGroupPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"FAIL","ErrorCode":10021}`)
		case getGroupInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupInfo":[{"GroupId":"`+testPlatformGroupID+`","Type":"Public","Owner_Account":"u_owner","ErrorCode":0}]}`)
		case addGroupMemberPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"MemberList":[{"Member_Account":"a_bot","Result":2}]}`)
		default:
			t.Fatalf("unexpected path = %q", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	err := newTestRESTGroupManager(t, server).EnsureGroup(context.Background(), botimport.TencentGroup{
		GroupID: testPlatformGroupID, Name: "评审", OwnerUserID: "u_owner", MemberUserIDs: []string{"a_bot"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{createGroupPath, getGroupInfoPath, addGroupMemberPath}; !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestRESTGroupManagerRejectsExistingGroupWithDifferentOwner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case createGroupPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"FAIL","ErrorCode":10021}`)
		case getGroupInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupInfo":[{"GroupId":"`+testPlatformGroupID+`","Type":"Public","Owner_Account":"u_intruder","ErrorCode":0}]}`)
		default:
			t.Fatalf("unexpected path = %q", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	err := newTestRESTGroupManager(t, server).EnsureGroup(context.Background(), botimport.TencentGroup{
		GroupID: testPlatformGroupID, Name: "评审", OwnerUserID: "u_owner",
	})
	if err == nil || !strings.Contains(err.Error(), "tencent_group_conflict") {
		t.Fatalf("error = %v", err)
	}
}

func TestRESTGroupManagerSendsPolicyNoticeAsCustomElement(t *testing.T) {
	var body struct {
		GroupID string `json:"GroupId"`
		MsgBody []struct {
			MsgType    string `json:"MsgType"`
			MsgContent struct {
				Data string `json:"Data"`
			} `json:"MsgContent"`
		} `json:"MsgBody"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != sendGroupMessagePath {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0}`)
	}))
	t.Cleanup(server.Close)

	err := newTestRESTGroupManager(t, server).SendPolicyNotice(context.Background(), testPlatformGroupID, botimport.PolicyNotice{
		GroupID: "0198f4c2-7a35-7f14-86ab-2e57552e473f", ReplyMode: "mention_context", Revision: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if body.GroupID != testPlatformGroupID || len(body.MsgBody) != 1 || body.MsgBody[0].MsgType != "TIMCustomElem" {
		t.Fatalf("body = %#v", body)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(body.MsgBody[0].MsgContent.Data), &data); err != nil ||
		data["businessID"] != PolicyNoticeBusinessID || data["replyMode"] != "mention_context" || data["revision"] != float64(4) {
		t.Fatalf("notice data = %s", body.MsgBody[0].MsgContent.Data)
	}
}

func TestRESTGroupManagerRejectsNonPlatformGroupIDs(t *testing.T) {
	manager := &RESTGroupManager{client: &RESTCommunityProvisioner{}}
	if err := manager.Destroy(context.Background(), "@TGS#foreign"); err == nil {
		t.Fatal("foreign group id accepted")
	}
}
