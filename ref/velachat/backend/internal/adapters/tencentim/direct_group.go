package tencentim

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	tencentimport "chatserver/internal/ports/tencentim"
)

const getGroupMemberInfoPath = "/v4/group_open_http_svc/get_group_member_info"

// EnsureDirectGroup 创建无群主的双人 Work 群；GroupId 已存在时回查群属性和完整成员集合。
func (client *RESTCommunityProvisioner) EnsureDirectGroup(
	ctx context.Context,
	group tencentimport.DirectGroup,
) error {
	if client == nil || ctx == nil || !validDirectGroup(group) {
		return newRESTError("tencent_invalid_direct_group", false)
	}
	request := struct {
		Type             string `json:"Type"`
		GroupID          string `json:"GroupId"`
		Name             string `json:"Name"`
		ApplyJoinOption  string `json:"ApplyJoinOption"`
		InviteJoinOption string `json:"InviteJoinOption"`
		MaxMemberNum     int    `json:"MaxMemberNum"`
		MemberList       []struct {
			MemberAccount string `json:"Member_Account"`
		} `json:"MemberList"`
	}{
		Type: "Private", GroupID: group.GroupID, Name: group.Name,
		ApplyJoinOption: "DisableApply", InviteJoinOption: "DisableInvite", MaxMemberNum: 2,
	}
	request.MemberList = make([]struct {
		MemberAccount string `json:"Member_Account"`
	}, 2)
	request.MemberList[0].MemberAccount = group.MemberAUserID
	request.MemberList[1].MemberAccount = group.MemberBUserID

	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupID      string `json:"GroupId"`
	}
	if err := client.postJSON(ctx, createGroupPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		if response.GroupID != "" && response.GroupID != group.GroupID {
			return newRESTError("tencent_direct_group_conflict", false)
		}
		return nil
	}
	if response.ErrorCode == 10021 || response.ErrorCode == 10025 {
		return client.reconcileDirectGroup(ctx, group)
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

func (client *RESTCommunityProvisioner) reconcileDirectGroup(
	ctx context.Context,
	group tencentimport.DirectGroup,
) error {
	infoRequest := struct {
		GroupIDList    []string `json:"GroupIdList"`
		ResponseFilter struct {
			GroupBaseInfoFilter []string `json:"GroupBaseInfoFilter"`
		} `json:"ResponseFilter"`
	}{GroupIDList: []string{group.GroupID}}
	infoRequest.ResponseFilter.GroupBaseInfoFilter = []string{
		"Type", "Owner_Account", "MemberNum", "ApplyJoinOption", "InviteJoinOption",
	}
	var infoResponse struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupInfo    []struct {
			GroupID          string `json:"GroupId"`
			Type             string `json:"Type"`
			OwnerAccount     string `json:"Owner_Account"`
			MemberNum        int    `json:"MemberNum"`
			ApplyJoinOption  string `json:"ApplyJoinOption"`
			InviteJoinOption string `json:"InviteJoinOption"`
			ErrorCode        int    `json:"ErrorCode"`
		} `json:"GroupInfo"`
	}
	if err := client.postJSON(ctx, getGroupInfoPath, infoRequest, &infoResponse); err != nil {
		return err
	}
	if infoResponse.ActionStatus != "OK" || infoResponse.ErrorCode != 0 || len(infoResponse.GroupInfo) != 1 {
		return newRESTError("tencent_direct_group_reconcile_failed", true)
	}
	actual := infoResponse.GroupInfo[0]
	if actual.ErrorCode != 0 {
		return newRESTError("tencent_"+strconv.Itoa(actual.ErrorCode), retryableCommunityCode(actual.ErrorCode))
	}
	if actual.GroupID != group.GroupID || actual.Type != "Private" || actual.OwnerAccount != "" ||
		actual.MemberNum != 2 || actual.ApplyJoinOption != "DisableApply" || actual.InviteJoinOption != "DisableInvite" {
		return newRESTError("tencent_direct_group_conflict", false)
	}

	memberRequest := struct {
		GroupID string `json:"GroupId"`
		Limit   int    `json:"Limit"`
	}{GroupID: group.GroupID, Limit: 100}
	var memberResponse struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		MemberList   []struct {
			MemberAccount string `json:"Member_Account"`
		} `json:"MemberList"`
	}
	if err := client.postJSON(ctx, getGroupMemberInfoPath, memberRequest, &memberResponse); err != nil {
		return err
	}
	if memberResponse.ActionStatus != "OK" || memberResponse.ErrorCode != 0 {
		return newRESTError("tencent_direct_group_reconcile_failed", true)
	}
	if len(memberResponse.MemberList) != 2 {
		return newRESTError("tencent_direct_group_conflict", false)
	}
	got := []string{memberResponse.MemberList[0].MemberAccount, memberResponse.MemberList[1].MemberAccount}
	want := []string{group.MemberAUserID, group.MemberBUserID}
	sort.Strings(got)
	sort.Strings(want)
	if got[0] != want[0] || got[1] != want[1] {
		return newRESTError("tencent_direct_group_conflict", false)
	}
	return nil
}

func validDirectGroup(group tencentimport.DirectGroup) bool {
	return strings.HasPrefix(group.GroupID, "an_dm_") && len(group.GroupID) <= 48 &&
		strings.TrimSpace(group.Name) != "" && utf8.ValidString(group.Name) && len(group.Name) <= 100 &&
		imUserIDPattern.MatchString(group.MemberAUserID) && imUserIDPattern.MatchString(group.MemberBUserID) &&
		group.MemberAUserID != group.MemberBUserID
}

var _ tencentimport.DirectGroupProvisioner = (*RESTCommunityProvisioner)(nil)
