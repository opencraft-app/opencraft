package tencentim

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

const (
	modifyGroupBaseInfoPath = "/v4/group_open_http_svc/modify_group_base_info"
	destroyGroupPath        = "/v4/group_open_http_svc/destroy_group"
	sendGroupMessagePath    = "/v4/group_open_http_svc/send_group_msg"

	// PolicyNoticeBusinessID 标识平台规则变化通知；客户端把它渲染为灰色系统提示。
	PolicyNoticeBusinessID = "vela_group_policy"
)

// RESTGroupManager 用 App 管理员身份幂等维护平台创建的腾讯普通群。
type RESTGroupManager struct {
	client *RESTCommunityProvisioner
}

func NewRESTGroupManager(config RESTConfig) (*RESTGroupManager, error) {
	client, err := NewRESTCommunityProvisioner(config)
	if err != nil {
		return nil, err
	}
	return &RESTGroupManager{client: client}, nil
}

// EnsureGroup 创建 Public 群（禁止主动申请加入）；GroupId 已存在时核对群主。
func (manager *RESTGroupManager) EnsureGroup(ctx context.Context, group botimport.TencentGroup) error {
	if manager == nil || ctx == nil || !validPlatformGroupID(group.GroupID) ||
		!imUserIDPattern.MatchString(group.OwnerUserID) ||
		strings.TrimSpace(group.Name) == "" || !utf8.ValidString(group.Name) || len(group.Name) > 100 {
		return newRESTError("tencent_invalid_group", false)
	}
	type member struct {
		MemberAccount string `json:"Member_Account"`
	}
	request := struct {
		OwnerAccount    string   `json:"Owner_Account"`
		Type            string   `json:"Type"`
		GroupID         string   `json:"GroupId"`
		Name            string   `json:"Name"`
		ApplyJoinOption string   `json:"ApplyJoinOption"`
		MemberList      []member `json:"MemberList,omitempty"`
	}{
		OwnerAccount: group.OwnerUserID, Type: "Public", GroupID: group.GroupID,
		Name: group.Name, ApplyJoinOption: "DisableApply",
	}
	for _, userID := range group.MemberUserIDs {
		if !imUserIDPattern.MatchString(userID) {
			return newRESTError("tencent_invalid_group", false)
		}
		request.MemberList = append(request.MemberList, member{MemberAccount: userID})
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupID      string `json:"GroupId"`
	}
	if err := manager.client.postJSON(ctx, createGroupPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		if response.GroupID != "" && response.GroupID != group.GroupID {
			return newRESTError("tencent_group_conflict", false)
		}
		return nil
	}
	if response.ErrorCode == 10021 || response.ErrorCode == 10025 {
		if err := manager.verifyOwner(ctx, group); err != nil {
			return err
		}
		return manager.AddMembers(ctx, group.GroupID, group.MemberUserIDs)
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

func (manager *RESTGroupManager) verifyOwner(ctx context.Context, group botimport.TencentGroup) error {
	request := struct {
		GroupIDList    []string `json:"GroupIdList"`
		ResponseFilter struct {
			GroupBaseInfoFilter []string `json:"GroupBaseInfoFilter"`
		} `json:"ResponseFilter"`
	}{GroupIDList: []string{group.GroupID}}
	request.ResponseFilter.GroupBaseInfoFilter = []string{"Type", "Owner_Account"}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupInfo    []struct {
			GroupID      string `json:"GroupId"`
			Type         string `json:"Type"`
			OwnerAccount string `json:"Owner_Account"`
			ErrorCode    int    `json:"ErrorCode"`
		} `json:"GroupInfo"`
	}
	if err := manager.client.postJSON(ctx, getGroupInfoPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus != "OK" || response.ErrorCode != 0 || len(response.GroupInfo) != 1 {
		return newRESTError("tencent_group_reconcile_failed", true)
	}
	actual := response.GroupInfo[0]
	if actual.ErrorCode != 0 {
		return newRESTError("tencent_"+strconv.Itoa(actual.ErrorCode), retryableCommunityCode(actual.ErrorCode))
	}
	if actual.GroupID != group.GroupID || actual.Type != "Public" || actual.OwnerAccount != group.OwnerUserID {
		return newRESTError("tencent_group_conflict", false)
	}
	return nil
}

// AddMembers 幂等拉人；已在群内的成员视为成功。
func (manager *RESTGroupManager) AddMembers(ctx context.Context, groupID string, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}
	if manager == nil || ctx == nil || !validPlatformGroupID(groupID) {
		return newRESTError("tencent_invalid_group", false)
	}
	type member struct {
		MemberAccount string `json:"Member_Account"`
	}
	request := struct {
		GroupID    string   `json:"GroupId"`
		Silence    int      `json:"Silence"`
		MemberList []member `json:"MemberList"`
	}{GroupID: groupID}
	for _, userID := range userIDs {
		if !imUserIDPattern.MatchString(userID) {
			return newRESTError("tencent_invalid_group_member", false)
		}
		request.MemberList = append(request.MemberList, member{MemberAccount: userID})
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		MemberList   []struct {
			MemberAccount string `json:"Member_Account"`
			Result        int    `json:"Result"`
		} `json:"MemberList"`
	}
	if err := manager.client.postJSON(ctx, addGroupMemberPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus != "OK" || response.ErrorCode != 0 {
		return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
	}
	for _, result := range response.MemberList {
		// Result：0 失败，1 成功，2 已是群成员。
		if result.Result != 1 && result.Result != 2 {
			return newRESTError("tencent_group_member_rejected", false)
		}
	}
	return nil
}

// RemoveMembers 把成员移出群。
func (manager *RESTGroupManager) RemoveMembers(ctx context.Context, groupID string, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}
	if manager == nil || ctx == nil || !validPlatformGroupID(groupID) {
		return newRESTError("tencent_invalid_group", false)
	}
	for _, userID := range userIDs {
		if !imUserIDPattern.MatchString(userID) {
			return newRESTError("tencent_invalid_group_member", false)
		}
	}
	request := struct {
		GroupID             string   `json:"GroupId"`
		Silence             int      `json:"Silence"`
		MemberToDelAccounts []string `json:"MemberToDel_Account"`
	}{GroupID: groupID, MemberToDelAccounts: userIDs}
	var response restEnvelope
	if err := manager.client.postJSON(ctx, deleteGroupMemberPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		return nil
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

// Rename 修改群名。
func (manager *RESTGroupManager) Rename(ctx context.Context, groupID string, name string) error {
	if manager == nil || ctx == nil || !validPlatformGroupID(groupID) ||
		strings.TrimSpace(name) == "" || !utf8.ValidString(name) || len(name) > 100 {
		return newRESTError("tencent_invalid_group", false)
	}
	request := struct {
		GroupID string `json:"GroupId"`
		Name    string `json:"Name"`
	}{GroupID: groupID, Name: name}
	var response restEnvelope
	if err := manager.client.postJSON(ctx, modifyGroupBaseInfoPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		return nil
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

// Destroy 解散群；群已不存在时视为成功。
func (manager *RESTGroupManager) Destroy(ctx context.Context, groupID string) error {
	if manager == nil || ctx == nil || !validPlatformGroupID(groupID) {
		return newRESTError("tencent_invalid_group", false)
	}
	request := struct {
		GroupID string `json:"GroupId"`
	}{GroupID: groupID}
	var response restEnvelope
	if err := manager.client.postJSON(ctx, destroyGroupPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 || response.ErrorCode == 10010 {
		return nil
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

// SendPolicyNotice 以管理员身份向群发送规则变化的自定义消息；不含聊天正文。
func (manager *RESTGroupManager) SendPolicyNotice(
	ctx context.Context,
	groupID string,
	notice botimport.PolicyNotice,
) error {
	if manager == nil || ctx == nil || !validPlatformGroupID(groupID) {
		return newRESTError("tencent_invalid_group", false)
	}
	data, err := json.Marshal(struct {
		BusinessID string `json:"businessID"`
		GroupID    string `json:"groupId"`
		ReplyMode  string `json:"replyMode"`
		Revision   int64  `json:"revision"`
	}{PolicyNoticeBusinessID, notice.GroupID, notice.ReplyMode, notice.Revision})
	if err != nil {
		return newRESTError("tencent_request_encode_failed", false)
	}
	randomBytes := make([]byte, 4)
	if _, err := rand.Read(randomBytes); err != nil {
		return newRESTError("tencent_random_failed", false)
	}
	type content struct {
		Data string `json:"Data"`
		Desc string `json:"Desc"`
	}
	type element struct {
		MsgType    string  `json:"MsgType"`
		MsgContent content `json:"MsgContent"`
	}
	request := struct {
		GroupID string    `json:"GroupId"`
		Random  uint32    `json:"Random"`
		MsgBody []element `json:"MsgBody"`
	}{
		GroupID: groupID,
		Random:  binary.BigEndian.Uint32(randomBytes),
		MsgBody: []element{{MsgType: "TIMCustomElem", MsgContent: content{Data: string(data), Desc: "group_policy"}}},
	}
	var response restEnvelope
	if err := manager.client.postJSON(ctx, sendGroupMessagePath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		return nil
	}
	return newRESTError("tencent_"+strconv.Itoa(response.ErrorCode), retryableCommunityCode(response.ErrorCode))
}

func validPlatformGroupID(groupID string) bool {
	_, ok := botimport.GroupIDFromTencent(groupID)
	return ok
}

var _ botimport.TencentGroups = (*RESTGroupManager)(nil)
