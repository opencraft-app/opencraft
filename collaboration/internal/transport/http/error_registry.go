package httptransport

import "net/http"

// ErrorMapping 是稳定错误码的唯一 HTTP 映射。
type ErrorMapping struct {
	Code    string
	Status  int
	Message string
}

var errorMappings = []ErrorMapping{
	{Code: "unauthenticated", Status: http.StatusUnauthorized, Message: "未登录或凭证无效"},
	{Code: "account_already_exists", Status: http.StatusConflict, Message: "该账号已注册"},
	{Code: "token_expired", Status: http.StatusUnauthorized, Message: "登录凭证已过期"},
	{Code: "session_revoked", Status: http.StatusUnauthorized, Message: "登录会话已失效"},
	{Code: "im_identity_not_ready", Status: http.StatusConflict, Message: "IM 身份尚未就绪"},
	{Code: "im_session_unavailable", Status: http.StatusServiceUnavailable, Message: "暂时无法创建 IM 会话"},
	{Code: "direct_conversation_closing", Status: http.StatusConflict, Message: "私信正在关闭，暂时无法恢复"},
	{Code: "runtime_credential_invalid", Status: http.StatusUnauthorized, Message: "Runtime 凭证无效"},
	{Code: "runtime_credential_revoked", Status: http.StatusUnauthorized, Message: "Runtime 凭证已撤销"},
	{Code: "computer_credential_invalid", Status: http.StatusUnauthorized, Message: "Computer 凭证无效"},
	{Code: "computer_credential_revoked", Status: http.StatusUnauthorized, Message: "Computer 凭证已撤销"},
	{Code: "computer_credential_exists", Status: http.StatusConflict, Message: "Computer Runtime Credential 已存在"},
	{Code: "enrollment_invalid", Status: http.StatusUnauthorized, Message: "Computer 接入凭证无效"},
	{Code: "setup_expired", Status: http.StatusUnauthorized, Message: "Computer 安装命令已过期"},
	{Code: "setup_code_invalid", Status: http.StatusUnauthorized, Message: "Computer 安装码无效或已过期"},
	{Code: "computer_already_claimed", Status: http.StatusConflict, Message: "Computer 已完成连接"},
	{Code: "computer_instance_not_owned", Status: http.StatusForbidden, Message: "LightVela 实例不属于当前账号"},
	{Code: "computer_instance_already_attached", Status: http.StatusConflict, Message: "LightVela 实例已归属其他 Server"},
	{Code: "computer_instance_unavailable", Status: http.StatusConflict, Message: "LightVela 实例当前不可作为 Computer"},
	{Code: "enrollment_claim_conflict", Status: http.StatusConflict, Message: "Computer 接入信息不一致"},
	{Code: "assignment_query_invalid", Status: http.StatusBadRequest, Message: "Assignment 查询无效"},
	{Code: "assignment_revision_regressed", Status: http.StatusConflict, Message: "Assignment 版本已回退"},
	{Code: "assignment_stale", Status: http.StatusConflict, Message: "Agent Assignment 已变化"},
	{Code: "computer_credential_not_active", Status: http.StatusForbidden, Message: "Computer 凭证不是 active 版本"},
	{Code: "predecessor_mismatch", Status: http.StatusConflict, Message: "Agent Launch 前序已变化"},
	{Code: "launch_id_conflict", Status: http.StatusConflict, Message: "Agent Launch ID 已冲突"},
	{Code: "stale_launch", Status: http.StatusConflict, Message: "Agent Launch 已失效"},
	{Code: "sequence_conflict", Status: http.StatusConflict, Message: "Observation sequence 已冲突"},
	{Code: "session_temporarily_unavailable", Status: http.StatusServiceUnavailable, Message: "Agent Session 暂时不可用"},

	{Code: "server_not_found", Status: http.StatusNotFound, Message: "Server 不存在"},
	{Code: "server_not_ready", Status: http.StatusConflict, Message: "Server 尚未就绪"},
	{Code: "member_not_found", Status: http.StatusNotFound, Message: "成员不存在"},
	{Code: "member_removed", Status: http.StatusForbidden, Message: "成员已被移除"},
	{Code: "owner_immutable", Status: http.StatusConflict, Message: "Owner 不能通过成员接口变更"},
	{Code: "already_member", Status: http.StatusConflict, Message: "已经是 Server 成员"},
	{Code: "permission_denied", Status: http.StatusForbidden, Message: "没有操作权限"},
	{Code: "forbidden", Status: http.StatusForbidden, Message: "当前身份无权执行该操作"},
	{Code: "revision_conflict", Status: http.StatusConflict, Message: "资源版本已变化"},
	{Code: "resource_not_found", Status: http.StatusNotFound, Message: "资源不存在"},
	{Code: "invite_invalid", Status: http.StatusNotFound, Message: "邀请无效或已失效"},
	{Code: "operation_not_found", Status: http.StatusNotFound, Message: "Operation 不存在"},
	{Code: "channel_not_found", Status: http.StatusNotFound, Message: "Channel 不存在"},
	{Code: "channel_not_ready", Status: http.StatusConflict, Message: "Channel 尚未就绪"},
	{Code: "channel_membership_required", Status: http.StatusForbidden, Message: "需要先加入 Channel"},
	{Code: "channel_membership_not_found", Status: http.StatusNotFound, Message: "Channel 成员关系不存在"},
	{Code: "implicit_membership", Status: http.StatusConflict, Message: "该成员关系由 Channel 规则隐式提供"},
	{Code: "system_channel_immutable", Status: http.StatusConflict, Message: "系统频道由 Server 管理，不能直接修改"},

	{Code: "agent_not_found", Status: http.StatusNotFound, Message: "Agent 不存在"},
	{Code: "agent_not_ready", Status: http.StatusConflict, Message: "Agent 尚未就绪"},
	{Code: "agent_must_be_stopped", Status: http.StatusConflict, Message: "需要先停止 Agent"},
	{Code: "runtime_unavailable", Status: http.StatusServiceUnavailable, Message: "Agent Runtime 暂不可用"},
	{Code: "runtime_config_invalid", Status: http.StatusUnprocessableEntity, Message: "Runtime 配置无效"},
	{Code: "runtime_directory_not_found", Status: http.StatusNotFound, Message: "Runtime 协作目录不存在"},
	{Code: "runtime_channel_not_found", Status: http.StatusNotFound, Message: "Runtime Channel 不存在或不可访问"},
	{Code: "runtime_directory_too_large", Status: http.StatusServiceUnavailable, Message: "Runtime 协作目录超过服务限制"},
	{Code: "computer_not_found", Status: http.StatusNotFound, Message: "Computer 不存在"},
	{Code: "computer_not_ready", Status: http.StatusConflict, Message: "Computer 尚未就绪"},
	{Code: "computer_offline", Status: http.StatusConflict, Message: "Computer 当前离线"},
	{Code: "computer_in_use", Status: http.StatusConflict, Message: "Computer 正在使用中"},
	{Code: "computer_has_bound_agents", Status: http.StatusConflict, Message: "请先迁移或解绑 Computer 上的 Agent"},
	{Code: "computer_already_registered", Status: http.StatusConflict, Message: "Computer 已注册"},
	{Code: "computer_bootstrap_not_allowed", Status: http.StatusConflict, Message: "Computer 当前不能继续连接"},
	{Code: "provider_registration_pending", Status: http.StatusServiceUnavailable, Message: "Computer 连接服务正在处理中"},
	{Code: "provider_registration_failed", Status: http.StatusServiceUnavailable, Message: "Computer 连接服务注册失败"},
	{Code: "provider_registration_expired", Status: http.StatusConflict, Message: "Computer 连接材料已过期"},
	{Code: "computer_os_unsupported", Status: http.StatusUnprocessableEntity, Message: "不支持该操作系统"},
	{Code: "registration_expired", Status: http.StatusConflict, Message: "注册过程已过期"},
	{Code: "tat_operation_failed", Status: http.StatusServiceUnavailable, Message: "TAT 操作失败"},
	{Code: "tat_operation_uncertain", Status: http.StatusServiceUnavailable, Message: "TAT 操作结果暂不确定"},
	{Code: "terminal_session_unavailable", Status: http.StatusServiceUnavailable, Message: "暂时无法创建终端会话"},

	{Code: "task_not_found", Status: http.StatusNotFound, Message: "任务不存在"},
	{Code: "task_assignment_stale", Status: http.StatusConflict, Message: "任务归属已变化"},
	{Code: "thread_not_found", Status: http.StatusNotFound, Message: "Thread 不存在"},
	{Code: "reminder_not_found", Status: http.StatusNotFound, Message: "提醒不存在"},
	{Code: "reminder_occurrence_not_found", Status: http.StatusNotFound, Message: "提醒触发记录不存在"},
	{Code: "schedule_invalid", Status: http.StatusUnprocessableEntity, Message: "提醒计划无效"},
	{Code: "rate_limited", Status: http.StatusTooManyRequests, Message: "请求过于频繁"},
	{Code: "idempotency_conflict", Status: http.StatusConflict, Message: "幂等键与原请求不一致"},

	{Code: "tencent_unavailable", Status: http.StatusServiceUnavailable, Message: "腾讯云服务暂不可用"},
	{Code: "tencent_rate_limited", Status: http.StatusServiceUnavailable, Message: "腾讯云服务请求受限"},
	{Code: "tencent_operation_uncertain", Status: http.StatusServiceUnavailable, Message: "腾讯云操作结果暂不确定"},
	{Code: "tencent_permission_denied", Status: http.StatusServiceUnavailable, Message: "腾讯云服务授权异常"},

	{Code: "routing_key_invalid", Status: http.StatusUnprocessableEntity, Message: "数据路由键无效"},
	{Code: "cross_partition_operation_denied", Status: http.StatusConflict, Message: "不允许执行跨分区操作"},

	{Code: "invalid_request", Status: http.StatusBadRequest, Message: "请求参数无效"},
	{Code: "invalid_cursor", Status: http.StatusBadRequest, Message: "分页游标无效"},
	{Code: "route_not_found", Status: http.StatusNotFound, Message: "接口不存在"},
	{Code: "method_not_allowed", Status: http.StatusMethodNotAllowed, Message: "请求方法不受支持"},
	{Code: "internal_error", Status: http.StatusInternalServerError, Message: "服务暂时无法完成请求"},

	{Code: "bot_agent_not_found", Status: http.StatusNotFound, Message: "Bot IM 身份不存在"},
	{Code: "bot_agent_not_ready", Status: http.StatusConflict, Message: "Bot IM 身份尚未就绪"},
	{Code: "bot_instance_not_owned", Status: http.StatusForbidden, Message: "LightVela 实例或 Bot 不属于当前账号"},
	{Code: "bot_host_unavailable", Status: http.StatusServiceUnavailable, Message: "暂时无法把凭据交付到 Bot 所在实例"},
	{Code: "bot_quota_exceeded", Status: http.StatusConflict, Message: "账号的 Bot IM 身份已达上限"},
	{Code: "im_group_not_found", Status: http.StatusNotFound, Message: "群聊不存在或当前身份不在群内"},
	{Code: "im_group_not_ready", Status: http.StatusConflict, Message: "群聊尚未就绪"},
	{Code: "im_identity_unknown", Status: http.StatusUnprocessableEntity, Message: "IM 身份尚未在平台开通"},
	{Code: "im_identity_restricted", Status: http.StatusForbidden, Message: "该 IM 身份已被限制"},
	{Code: "im_group_invite_invalid", Status: http.StatusGone, Message: "群邀请已失效"},
}

var errorMappingByCode = func() map[string]ErrorMapping {
	result := make(map[string]ErrorMapping, len(errorMappings))
	for _, mapping := range errorMappings {
		if _, exists := result[mapping.Code]; exists {
			panic("重复的 HTTP 错误码: " + mapping.Code)
		}
		result[mapping.Code] = mapping
	}
	return result
}()

// LookupError 返回稳定错误码的 HTTP 映射。
func LookupError(code string) (ErrorMapping, bool) {
	mapping, ok := errorMappingByCode[code]
	return mapping, ok
}

// AllErrorMappings 返回 registry 的副本，供完整性测试和文档工具使用。
func AllErrorMappings() []ErrorMapping {
	result := make([]ErrorMapping, len(errorMappings))
	copy(result, errorMappings)
	return result
}
