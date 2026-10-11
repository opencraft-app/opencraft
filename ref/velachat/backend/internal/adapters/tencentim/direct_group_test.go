package tencentim

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	tencentimport "chatserver/internal/ports/tencentim"
)

func TestRESTCommunityProvisionerCreatesOwnerlessTwoMemberDirectGroup(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != createGroupPath {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupId":"an_dm_direct"}`)
	}))
	t.Cleanup(server.Close)

	client := newTestRESTCommunityProvisioner(t, server)
	if err := client.EnsureDirectGroup(context.Background(), testDirectGroup()); err != nil {
		t.Fatal(err)
	}
	if _, present := body["Owner_Account"]; present {
		t.Fatalf("owner must be absent: %#v", body)
	}
	if body["Type"] != "Private" || body["GroupId"] != "an_dm_direct" ||
		body["Name"] != "Server 内私信" || body["ApplyJoinOption"] != "DisableApply" ||
		body["InviteJoinOption"] != "DisableInvite" || body["MaxMemberNum"] != float64(2) {
		t.Fatalf("create body = %#v", body)
	}
	members, ok := body["MemberList"].([]any)
	if !ok || len(members) != 2 {
		t.Fatalf("members = %#v", body["MemberList"])
	}
	got := []string{
		members[0].(map[string]any)["Member_Account"].(string),
		members[1].(map[string]any)["Member_Account"].(string),
	}
	if want := []string{"u_A", "u_B"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("members = %#v, want %#v", got, want)
	}
}

func TestRESTCommunityProvisionerReconcilesExistingDirectGroup(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case createGroupPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"FAIL","ErrorCode":10021}`)
		case getGroupInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupInfo":[{"GroupId":"an_dm_direct","Type":"Private","Owner_Account":"","MemberNum":2,"ApplyJoinOption":"DisableApply","InviteJoinOption":"DisableInvite","ErrorCode":0}]}`)
		case getGroupMemberInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"MemberList":[{"Member_Account":"u_B"},{"Member_Account":"u_A"}]}`)
		default:
			t.Fatalf("unexpected path = %q", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	client := newTestRESTCommunityProvisioner(t, server)
	if err := client.EnsureDirectGroup(context.Background(), testDirectGroup()); err != nil {
		t.Fatal(err)
	}
	want := []string{createGroupPath, getGroupInfoPath, getGroupMemberInfoPath}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %#v, want %#v", paths, want)
	}
}

func TestRESTCommunityProvisionerRejectsDirectGroupWithWrongParticipants(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case createGroupPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"FAIL","ErrorCode":10025}`)
		case getGroupInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"GroupInfo":[{"GroupId":"an_dm_direct","Type":"Private","Owner_Account":"","MemberNum":2,"ApplyJoinOption":"DisableApply","InviteJoinOption":"DisableInvite","ErrorCode":0}]}`)
		case getGroupMemberInfoPath:
			_, _ = io.WriteString(writer, `{"ActionStatus":"OK","ErrorCode":0,"MemberList":[{"Member_Account":"u_A"},{"Member_Account":"u_OTHER"}]}`)
		}
	}))
	t.Cleanup(server.Close)

	client := newTestRESTCommunityProvisioner(t, server)
	err := client.EnsureDirectGroup(context.Background(), testDirectGroup())
	if code := tencentimport.CodeOf(err); code != "tencent_direct_group_conflict" {
		t.Fatalf("error = %v, code = %q", err, code)
	}
	if tencentimport.IsRetryable(err) {
		t.Fatal("participant conflict must not retry")
	}
}

func testDirectGroup() tencentimport.DirectGroup {
	return tencentimport.DirectGroup{
		GroupID: "an_dm_direct", Name: "Server 内私信",
		MemberAUserID: "u_A", MemberBUserID: "u_B",
	}
}

func TestRESTCommunityProvisionerRejectsTencentReservedDirectGroupID(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(server.Close)
	client := newTestRESTCommunityProvisioner(t, server)
	group := testDirectGroup()
	group.GroupID = "@TGS#_W_direct"

	err := client.EnsureDirectGroup(context.Background(), group)
	if code := tencentimport.CodeOf(err); code != "tencent_invalid_direct_group" {
		t.Fatalf("error = %v, code = %q", err, code)
	}
}
