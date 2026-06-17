package errcode

// === ctl-authcode-codebuddy 设计稿落地（auth_code 鉴权 ticket）===
//
// 设计稿：.tmp/ctl-authcode-codebuddy-design.md §4.5 / §6 错误码表
//
// 与契约文档《CodeBuddy AuthCode 模式》§四错误码约定对齐；ctl 内部统一用
// 大写下划线 Code（与既有 errcode 风格保持一致），HTTP 状态码严格匹配契约。
var (
	// ErrAuthCodeInvalid auth_code 不存在 / 已过期 / 已被消费 → HTTP 401。
	//
	// 触发场景：
	//   - 中转页伪造 auth_code 调 order-url
	//   - ticket TTL 自然过期（设计稿 A4 不变量）
	//   - 同一 ticket 第二次消费（设计稿 A1 不变量：一次性）
	ErrAuthCodeInvalid = Register(New("AUTH_CODE_INVALID", 401, "auth_code invalid or expired"))

	// ErrAuthCodeMismatch ticket 携带的 deal_names / pass_id 与请求不一致 → HTTP 403。
	//
	// 触发场景：
	//   - 用 A 单的 ticket 去拉 B 单的支付 URL（设计稿 A2 不变量）
	//   - 用 pass-X 的续费 ticket 去拉 pass-Y 的续费 URL（设计稿 A3 不变量）
	ErrAuthCodeMismatch = Register(New("AUTH_CODE_MISMATCH", 403, "auth_code deal_names mismatch"))

	// ErrDealNameRevoked 订单已被用户主动取消，但仍凭原 ticket 调 order-url → HTTP 410。
	//
	// 当前 v1.7.32 不实现"主动作废 ticket"链路（DeletePass 只走 trade，不调
	// authcode.Revoke），保留错误码占位待后续启用。
	ErrDealNameRevoked = Register(New("DEAL_NAME_REVOKED", 410, "deal_name revoked by user"))

	// ErrRateLimited auth_code / IP 维度限流触发 → HTTP 429（设计稿 A7 不变量）。
	//
	// 触发场景：
	//   - 单 auth_code 每分钟 ≥ 5 次
	//   - 单 IP 每分钟 ≥ 30 次
	ErrRateLimited = Register(New("RATE_LIMITED", 429, "rate limit exceeded"))
)
