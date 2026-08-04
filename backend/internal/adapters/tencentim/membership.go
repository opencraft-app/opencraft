package tencentim

import (
	"context"
	"strconv"
	"strings"

	tencentimport "chatserver/internal/ports/tencentim"
)

const (
	addGroupMemberPath    = "/v4/group_open_http_svc/add_group_member"
	deleteGroupMemberPath = "/v4/group_open_http_svc/delete_group_member"
)

// EnsureMember 幂等添加 Community 或私密 Topic 的单个成员。
func (client *RESTCommunityProvisioner) EnsureMember(
	ctx context.Context,
	membership tencentimport.Membership,
) error {
	if client == nil || ctx == nil || !validMembership(membership) {
		return newRESTError("tencent_invalid_membership", false)
	}
	request := struct {
		GroupID    string `json:"GroupId"`
		TopicID    string `json:"TopicId,omitempty"`
		Silence    int    `json:"Silence"`
		MemberList []struct {
			Account string `json:"Member_Account"`
		} `json:"MemberList"`
	}{
		GroupID: membership.GroupID,
		TopicID: membership.TopicID,
		Silence: 1,
		MemberList: []struct {
			Account string `json:"Member_Account"`
		}{{Account: membership.UserID}},
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		MemberList   []struct {
			Account string `json:"Member_Account"`
			Result  int    `json:"Result"`
		} `json:"MemberList"`
	}
	if err := client.postJSON(
		ctx,
		addGroupMemberPath,
		request,
		&response,
	); err != nil {
		return err
	}
	if response.ErrorCode == 10013 {
		return nil
	}
	if response.ActionStatus != "OK" || response.ErrorCode != 0 {
		retryable := retryableMembershipCode(response.ErrorCode)
		if membership.TopicID != "" &&
			(response.ErrorCode == 10010 || response.ErrorCode == 10015) {
			retryable = true
		}
		return newRESTError(
			"tencent_"+strconv.Itoa(response.ErrorCode),
			retryable,
		)
	}
	if len(response.MemberList) != 1 ||
		response.MemberList[0].Account != membership.UserID ||
		(response.MemberList[0].Result != 1 &&
			response.MemberList[0].Result != 2) {
		return newRESTError("tencent_member_add_failed", false)
	}
	return nil
}

// RemoveMember 幂等删除 Community 或私密 Topic 的单个成员。
func (client *RESTCommunityProvisioner) RemoveMember(
	ctx context.Context,
	membership tencentimport.Membership,
) error {
	if client == nil || ctx == nil || !validMembership(membership) {
		return newRESTError("tencent_invalid_membership", false)
	}
	request := struct {
		GroupID   string   `json:"GroupId"`
		TopicID   string   `json:"TopicId,omitempty"`
		Silence   int      `json:"Silence"`
		MemberIDs []string `json:"MemberToDel_Account"`
	}{
		GroupID:   membership.GroupID,
		TopicID:   membership.TopicID,
		Silence:   1,
		MemberIDs: []string{membership.UserID},
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
	}
	if err := client.postJSON(
		ctx,
		deleteGroupMemberPath,
		request,
		&response,
	); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		return nil
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(response.ErrorCode),
		retryableMembershipCode(response.ErrorCode),
	)
}

func validMembership(value tencentimport.Membership) bool {
	if !strings.HasPrefix(value.GroupID, "@TGS#_C_") ||
		len(value.GroupID) > 48 ||
		!imUserIDPattern.MatchString(value.UserID) {
		return false
	}
	return value.TopicID == "" ||
		strings.HasPrefix(value.TopicID, value.GroupID+"@TOPIC#_") &&
			len(value.TopicID) <= 96
}

func retryableMembershipCode(code int) bool {
	switch code {
	case 10003, 10004, 10005, 10007, 10010, 10014, 10015, 10016,
		10019, 10026, 10037, 10038:
		return false
	case 10002, 10006:
		return true
	default:
		return retryableTencentCode(code)
	}
}

var _ tencentimport.MembershipProvisioner = (*RESTCommunityProvisioner)(nil)
