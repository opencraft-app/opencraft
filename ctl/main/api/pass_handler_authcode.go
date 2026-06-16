package main

import (
	"errors"
	"net/http"

	"ctl/pkg/authcode"
	"ctl/pkg/errcode"
)

// resolveOrderUrlAuth v1.7.32 双模式鉴权 helper（CodeBuddy AuthCode 模式）。
//
// 设计稿：.tmp/ctl-authcode-codebuddy-design.md §4.2 + A1/A2/A3/A5 不变量。
//
// 鉴权决策树：
//
//	if X-User-Id 存在:
//	    走原有 Bearer 链路，userID = header value（不消费 ticket，A8 协同）
//	elif req.AuthCode 非空:
//	    走 ticket 链路：authcode.DefaultStore.Consume → 校验 deal_names + pass_id → 提取 user_id
//	else:
//	    返 401 unauthorized
//
// 错误返值（HTTP 状态由 errcode 承载）：
//   - 401 UNAUTHORIZED：双缺失（X-User-Id 与 auth_code 都未提供）
//   - 401 AUTH_CODE_INVALID：ticket 不存在 / 已过期 / 已被消费
//   - 403 AUTH_CODE_MISMATCH：ticket.deal_names ≠ req.deal_names 或 ticket.pass_id ≠ passID
//   - 5xx：authcode store 内部错（Redis 网络错等）
//
// 入参：
//   - reqDealNames：请求 body 里的 deal_names（用于 A2 强绑定校验）
//   - passID：续费场景传 path param 上的 pass_id；新购场景传 ""
//
// 注：本 helper 不调用 newRequestContext 重建 pctx —— logic.CreatePassOrderUrl /
// RenewPassOrderUrl 内部用 resource.ZapLogger 自起 logger，trace_id 单独管理；
// userID 字符串透传即可。
func resolveOrderUrlAuth(r *http.Request, authCode string, reqDealNames []string, passID string) (string, error) {
	// 路径 1：X-User-Id 存在 → 走原有 Bearer 链路
	if userID := requestUserID(r); userID != "" {
		return userID, nil
	}

	// 路径 2：缺 X-User-Id 但带 auth_code → 走 ticket 反查
	if authCode != "" {
		store := authcode.DefaultStore
		if store == nil {
			// 启动期未注入 store（理论不会触发）；视为 ticket 路径不可用，退到 401
			return "", errcode.ErrUnauthorized
		}
		ticket, err := store.Consume(r.Context(), authCode)
		if err != nil {
			if errors.Is(err, authcode.ErrTicketNotFound) {
				return "", errcode.ErrAuthCodeInvalid
			}
			// Redis 网络异常等基础设施错 → 5xx，不暴露细节
			return "", errcode.Wrap(errcode.ErrInternalServer, "%s", err.Error())
		}

		// A2 不变量：ticket.deal_names == req.deal_names
		if !sameDealNames(ticket.DealNames, reqDealNames) {
			return "", errcode.ErrAuthCodeMismatch
		}
		// A3 不变量：续费场景 ticket.pass_id == path 上的 pass_id
		if passID != "" && ticket.PassID != passID {
			return "", errcode.ErrAuthCodeMismatch
		}
		return ticket.UserID, nil
	}

	// 路径 3：双缺失
	return "", errcode.ErrUnauthorized
}

// sameDealNames 判断两组 deal_names 是否完全一致（顺序敏感）。
//
// A2 不变量校验：ticket.DealNames 与 req.DealNames 必须完全一致；当前业务侧
// 单订单场景固定 1 元素，本函数同样支持后续多订单扩展。
func sameDealNames(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
