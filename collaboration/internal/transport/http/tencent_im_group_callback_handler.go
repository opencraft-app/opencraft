package httptransport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
)

const (
	groupBeforeCreateCommand = "Group.CallbackBeforeCreateGroup"
	groupAfterJoinCommand    = "Group.CallbackAfterNewMemberJoin"
	groupAfterExitCommand    = "Group.CallbackAfterMemberExit"
	groupAfterDestroyCommand = "Group.CallbackAfterGroupDestroyed"
	groupBeforeSendCommand   = "Group.CallbackBeforeSendMsg"
	c2cBeforeSendCommand     = "C2C.CallbackBeforeSendMsg"
	// 群资料、入群只能经平台改变：客户端直接改名会被改回，申请入群和客户端拉人一律拒绝。
	groupAfterInfoChangedCommand = "Group.CallbackAfterGroupInfoChanged"
	groupBeforeApplyJoinCommand  = "Group.CallbackBeforeApplyJoinGroup"
	groupBeforeInviteJoinCommand = "Group.CallbackBeforeInviteJoinGroup"
)

// TencentIMGroupCallbackConfig 配置平台群对账与封禁回调。
type TencentIMGroupCallbackConfig struct {
	SDKAppID     int64
	Token        []byte
	Clock        clockport.Clock
	MaxBodyBytes int64
	// AdminUserID 是 App 管理员；开启 RestrictClientGroupCreate 后只允许它建群。
	AdminUserID               string
	RestrictClientGroupCreate bool
}

type imGroupCallbackObserver interface {
	ObserveMembersJoined(ctx context.Context, tencentGroupID string, userIDs []string) error
	ObserveMembersLeft(ctx context.Context, tencentGroupID string, userIDs []string) error
	ObserveGroupDestroyed(ctx context.Context, tencentGroupID string) error
	// ObserveGroupRenamed 在群名被绕过平台修改后恢复平台记录的群名。
	ObserveGroupRenamed(ctx context.Context, tencentGroupID, name string) error
	IsRestricted(ctx context.Context, userID string) (bool, error)
	// MayMessage 判断 from 是否可以给 to 发单聊。
	MayMessage(ctx context.Context, from, to string) (bool, error)
}

type tencentIMCallbackDispatcher struct {
	state  http.Handler
	config TencentIMGroupCallbackConfig
	groups imGroupCallbackObserver
}

// NewTencentIMCallbackDispatcher 在同一个腾讯回调地址上按 CallbackCommand 分发。
//
// 腾讯控制台每个 SDKAppID 只能配置一个回调 URL；状态回调仍由原处理器处理。
func NewTencentIMCallbackDispatcher(
	state http.Handler,
	config TencentIMGroupCallbackConfig,
	groups imGroupCallbackObserver,
) (http.Handler, error) {
	if state == nil || groups == nil || config.SDKAppID <= 0 || len(config.Token) == 0 ||
		len(config.Token) > 128 || config.Clock == nil || config.MaxBodyBytes <= 0 ||
		config.MaxBodyBytes > 64<<10 {
		return nil, errors.New("腾讯 IM 回调分发配置无效")
	}
	return &tencentIMCallbackDispatcher{state: state, config: config, groups: groups}, nil
}

func (dispatcher *tencentIMCallbackDispatcher) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	command := request.URL.Query().Get("CallbackCommand")
	switch command {
	case tencentIMStateCommand:
		dispatcher.state.ServeHTTP(writer, request)
		return
	case groupBeforeCreateCommand, groupAfterJoinCommand, groupAfterExitCommand,
		groupAfterDestroyCommand, groupBeforeSendCommand, c2cBeforeSendCommand,
		groupAfterInfoChangedCommand, groupBeforeApplyJoinCommand, groupBeforeInviteJoinCommand:
	default:
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !verifyTencentCallback(request, dispatcher.config.SDKAppID, dispatcher.config.Token,
		dispatcher.config.Clock, command) {
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(writer, "invalid content type", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, dispatcher.config.MaxBodyBytes+1))
	if err != nil || int64(len(body)) > dispatcher.config.MaxBodyBytes {
		http.Error(writer, "invalid body", http.StatusBadRequest)
		return
	}
	var callback struct {
		CallbackCommand  string  `json:"CallbackCommand"`
		GroupID          string  `json:"GroupId"`
		OperatorAccount  string  `json:"Operator_Account"`
		RequestorAccount string  `json:"Requestor_Account"`
		FromAccount      string  `json:"From_Account"`
		ToAccount        string  `json:"To_Account"`
		Name             *string `json:"Name"`
		NewMemberList    []struct {
			MemberAccount string `json:"Member_Account"`
		} `json:"NewMemberList"`
		ExitMemberList []struct {
			MemberAccount string `json:"Member_Account"`
		} `json:"ExitMemberList"`
	}
	if err := json.Unmarshal(body, &callback); err != nil || callback.CallbackCommand != command {
		http.Error(writer, "invalid callback", http.StatusBadRequest)
		return
	}
	ctx := request.Context()
	switch command {
	case groupBeforeCreateCommand:
		if dispatcher.config.RestrictClientGroupCreate &&
			strings.TrimSpace(callback.OperatorAccount) != dispatcher.config.AdminUserID {
			dispatcher.reject(writer, "请通过平台创建群聊")
			return
		}
	case groupAfterJoinCommand:
		err = dispatcher.groups.ObserveMembersJoined(ctx, callback.GroupID, memberAccounts(callback.NewMemberList))
	case groupAfterExitCommand:
		err = dispatcher.groups.ObserveMembersLeft(ctx, callback.GroupID, memberAccounts(callback.ExitMemberList))
	case groupAfterDestroyCommand:
		err = dispatcher.groups.ObserveGroupDestroyed(ctx, callback.GroupID)
	case groupBeforeSendCommand, c2cBeforeSendCommand:
		restricted, checkErr := dispatcher.groups.IsRestricted(ctx, callback.FromAccount)
		if checkErr == nil && restricted {
			dispatcher.reject(writer, "该身份已被限制发言")
			return
		}
		if command == c2cBeforeSendCommand && !dispatcher.fromAdmin(callback.FromAccount) {
			allowed, checkErr := dispatcher.groups.MayMessage(ctx, callback.FromAccount, callback.ToAccount)
			if checkErr == nil && !allowed {
				dispatcher.reject(writer, "只能给自己账号下的身份或同群成员发消息")
				return
			}
		}
		// 平台检查暂不可用时放行，避免平台故障阻断全部聊天。
	case groupBeforeApplyJoinCommand, groupBeforeInviteJoinCommand:
		operator := callback.OperatorAccount
		if command == groupBeforeApplyJoinCommand {
			operator = callback.RequestorAccount
		}
		if !dispatcher.fromAdmin(operator) {
			dispatcher.reject(writer, "请通过平台的邀请链接加入群聊")
			return
		}
	case groupAfterInfoChangedCommand:
		if callback.Name != nil && !dispatcher.fromAdmin(callback.OperatorAccount) {
			err = dispatcher.groups.ObserveGroupRenamed(ctx, callback.GroupID, *callback.Name)
		}
	}
	if err != nil {
		http.Error(writer, "temporary failure", http.StatusInternalServerError)
		return
	}
	writeTencentCallbackResult(writer, 0, "")
}

// fromAdmin 是平台自己（App 管理员）通过 REST 发起的操作；未配置管理员时不做来源限制。
func (dispatcher *tencentIMCallbackDispatcher) fromAdmin(account string) bool {
	admin := dispatcher.config.AdminUserID
	return admin == "" || strings.TrimSpace(account) == admin
}

func (dispatcher *tencentIMCallbackDispatcher) reject(writer http.ResponseWriter, info string) {
	writeTencentCallbackResult(writer, 1, info)
}

func writeTencentCallbackResult(writer http.ResponseWriter, code int, info string) {
	payload, _ := json.Marshal(struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		ErrorInfo    string `json:"ErrorInfo"`
	}{"OK", code, info})
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(payload)
}

func memberAccounts(values []struct {
	MemberAccount string `json:"Member_Account"`
}) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if account := strings.TrimSpace(value.MemberAccount); account != "" && len(account) <= 32 {
			result = append(result, account)
		}
	}
	return result
}
