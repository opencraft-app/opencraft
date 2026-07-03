package errcode

var (
	ErrPassNotFound              = Register(New("PASS_NOT_FOUND", 404, "pass not found"))
	ErrPassInvalidParam          = Register(New("PASS_INVALID_PARAM", 400, "invalid pass parameters"))
	ErrPassInvalidTimeUnit       = Register(New("PASS_INVALID_TIME_UNIT", 400, "invalid time unit, must be m"))
	ErrPassExpired               = Register(New("PASS_EXPIRED", 403, "pass has expired"))
	ErrPassBundleOffline         = Register(New("PASS_BUNDLE_OFFLINE", 400, "cannot create pass for offline bundle"))
	ErrPassNoFieldToUpdate       = Register(New("PASS_NO_FIELD_TO_UPDATE", 400, "no field to update"))
	ErrPassShadowBindingNotFound = Register(New("PASS_SHADOW_BINDING_NOT_FOUND", 404, "shadow binding not found for user"))
	ErrPassShadowBindingRequired = Register(New("PASS_SHADOW_BINDING_REQUIRED", 403, "shadow account binding required"))
	ErrPassQuotaExceeded         = Register(New("PASS_QUOTA_EXCEEDED", 403, "consumed quota exceeds bundle agent_quota limit"))
	ErrPassAlreadyExists         = Register(New("PASS_ALREADY_EXISTS", 409, "user already has an active pass"))
	ErrPassBundleSoldOut         = Register(New("PASS_BUNDLE_SOLD_OUT", 400, "bundle is sold out"))
	ErrPassTrialBundleNotAllowed = Register(New("PASS_TRIAL_BUNDLE_NOT_ALLOWED", 400, "only bundle_free_trial_01 can be created via free trial path"))

	// === trade-pass-isolate 设计稿落地（pass.status 拦截）===
	// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q23 = C1 修订版

	// ErrPassIsolating 用户的 pass 正在被隔离（status='isolating'），CreateInstance 应被拦截
	ErrPassIsolating = Register(New("PASS_ISOLATING", 403, "user pass is being isolated, cannot create instance"))

	// ErrPassIsolated 用户的 pass 已经隔离（status='isolated'），CreateInstance 应被拦截
	ErrPassIsolated = Register(New("PASS_ISOLATED", 403, "user pass has been isolated, cannot create instance"))

	// === trade-pass-renew 设计稿落地（pass.status='renewing' 拦截）===
	// 设计稿：.tmp/trade-pass-renew-design.md §3.1 / §3.4 v3.8

	// ErrPassRenewing 用户的 pass 正在续费中（status='renewing'，到期续费父 task 进行中）：
	//   - CreateInstance 路径下与 isolating 同语义拦截（设计对偶 isolate 链路）
	//   - trade.renewResource 路径下走"拒收+退款"短路（returnCode=352014），不在 ctl 层返此码
	//
	// 设计权衡（§3.1 异常分支注释）：续费可以多次发起（用户多次点续费），但同时只能有一笔在跑；
	// 第二笔单独走 jifei 退款短路码，避免双单并发竞争 isolated_time 基线。
	ErrPassRenewing = Register(New("PASS_RENEWING", 403, "user pass is being renewed, cannot create instance"))

	// ErrPassNotRenewable pass 状态不在可续费集合（active/isolated）中（如 deleting/deleted），续费应被拒收。
	// trade renewResource handler 据此返 returnCode=352014（DeliveryFailRefund）；详见 §2.5 "5 类错误码归并表" PassNotRenewable 行。
	ErrPassNotRenewable = Register(New("PASS_NOT_RENEWABLE", 403, "pass status not renewable"))

	// ErrPassRenewNotImplemented 历史 placeholder（R-B 阶段异步续费分支占位用）。
	//
	// 状态（2026-05-15 R-D-1 起）：**已不再返回**。logic.RenewPass 异步分支
	// （pass.status='isolated' 路径）已完整闭环 — CAS isolated → renewing + 入队父 task RenewPass。
	//
	// 保留导出符号是为了兼容 trade 仓既有 ctlclient 适配层 / 测试用例（如
	// trade/internal/ctlclient/client_test.go: TestRenewPass_NotImplemented 仍把它当作
	// "ctl 上游可能返 501"的模拟样本）；trade 层语义为：识别此错码不进 trade_flow 终态，
	// 也不转 returnCode=352014（避免误退款），降级为 5xx InternalError 让 jifei 重试。
	//
	// 待 trade 仓后续 cleanup 后可移除本符号。
	ErrPassRenewNotImplemented = Register(New("PASS_RENEW_NOT_IMPLEMENTED", 501, "asynchronous renew path not implemented yet (deprecated since R-D-1)"))

	// === trade-pass-destroy 设计稿落地（pass.status 销毁链路扩展）===
	// 设计稿：.tmp/trade-pass-destroy-design.md §4.1 / §4.5.1 / §11-A Q1 / Q2
	//
	// 入口 A（用户主动销毁）状态机：isolated → deleting → terminating → 删除 + 迁移 history_pass
	// 入口 B（计费回调销毁）状态机：isolated → terminating → 删除 + 迁移 history_pass

	// ErrPassNotIsolated DeletePass 入口要求 pass.status='isolated' 才能进入销毁链路；
	// 当 status 处于 active/isolating/renewing/deleting/terminating 等其它态时，CAS 失败应返此码。
	// 调用方（前端）据此提示用户"请先等待隔离完成或处理其它进行中的销毁/续费流程"。
	ErrPassNotIsolated = Register(New("PASS_NOT_ISOLATED", 400, "pass is not in isolated status, cannot delete"))

	// ErrPassDeleting pass 已处于 status='deleting' 中间态（用户已点击销毁，jifei 尚未回调）；
	// 重复点击销毁按钮时 ctl.DeletePass 返此码做幂等防重；前端应灰化按钮 + 显示"销毁中"占位。
	ErrPassDeleting = Register(New("PASS_DELETING", 403, "user pass is being deleted, please wait"))

	// ErrPassTerminating pass 已处于 status='terminating' 销毁主链中；与 deleting 同语义但更靠近终态，
	// 销毁父 task 已被派发并正在执行；前端应保持灰化态直到 pass 从前端列表消失（迁移 history_pass）。
	ErrPassTerminating = Register(New("PASS_TERMINATING", 403, "user pass is being terminated, please wait"))

	// === trade-pass-isolate 退费分支扩展（v1.7.30 BUG-35）===
	// 设计稿：.tmp/jifei_pdf_txt/预付费资源隔离接口+-+isolateResource.md §2.2 退费场景
	//
	// jifei isolateResource 退费场景下会同时传 dealName + newDeadline；ctl 父 task 终态时
	// 在 CAS isolating→isolated 同事务里把 pass.expired_time 改写为 newDeadline。
	//
	// 退费业务约束：newDeadline 必须严格 < 当前 pass.expired_time（退费只能压缩时长，
	// 不能拉长到期时间，避免 jifei 协议层 bug 让用户被白嫖延长）。

	// ErrPassNewDeadlineInvalid 退费场景下 newDeadline 不满足约束（>= 当前 pass.expired_time）。
	//
	// trade 侧 classifyCTLError 走 4xx 业务永久错分支映射为 600303 IsolateFailed
	// （或 600305 NewDeadlineInvalid，由 trade handler 自行决定），不开新错误码段。
	// 调用方排障：jifei 与 ctl 的 expired_time 视图不一致，需要对账 jifei 大订单时间线。
	ErrPassNewDeadlineInvalid = Register(New("PASS_NEW_DEADLINE_INVALID", 400, "newDeadline must be strictly earlier than current pass expired_time"))

	// === trade-pass-refund 设计稿落地（ctl 主动发起 OnlineRefund 链路前置校验）===
	// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3 + §11 Q1=a/Q2=a/Q5=a 拍板

	// ErrPassNotActive RefundPass 入口要求 pass.status='active' 才能发起退款（Q2=a 拍板）；
	// 当 status 处于 isolating/isolated/deleting/terminating/renewing 等其它态时返此码。
	//
	// 与 ErrPassNotIsolated（销毁链路要求 status=isolated）对偶 — 退款是"在保资源退费"语义，
	// 协议要求 pass 仍处于可用态；已隔离 / 已退款 / 销毁中的 pass 不允许二次退款。
	ErrPassNotActive = Register(New("PASS_NOT_ACTIVE", 400, "pass is not in active status, cannot refund"))

	// ErrPassTrialNotRefundable 免费试用 pass（uin=0 或 app_id=0）不允许走 jifei OnlineRefund 退款。
	//
	// 触发场景：bundle_free_trial_* 系列试用套餐用户在控制台后台被误触发退款；jifei 协议本身
	// 不接受 payMode=0/2，本期试用 pass 在 ctl.pass 表里 uin/app_id 均为 0，不具备 jifei 协议
	// 退款所需的"用户实名 + 资源归属"前提。在 ctl 入口处统一拦截，避免请求穿透到 trade/jifei
	// 后被业务码 100151 等模糊错误拒绝。
	ErrPassTrialNotRefundable = Register(New("PASS_TRIAL_NOT_REFUNDABLE", 400, "free trial pass is not refundable via jifei OnlineRefund"))
)
