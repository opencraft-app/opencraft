package jifei

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

// 已注册 interfaceName 常量；新增动作时同步在 InstallStubHandlers 内 Register。
//
// 命名遵循 Q60 拍板格式 `{prefix}.{subProduct}.{action}`：
//   - prefix=lightvela（trade 自家业务前缀，由 config.JifeiOurInterfacePrefix 注入）
//   - subProduct=pass（本期唯一子产品）
//   - action=checkCreate / createResource（PDF 第 5/7 页两个核心动作）
const (
	InterfaceNameCheckCreate    = "lightvela.pass.checkCreate"
	InterfaceNameCreateResource = "lightvela.pass.createResource"

	// 资源反查三件套（trade-resource-query-design §3.1 / 11B）：
	// - getAllAppIds：jifei 每日凌晨对账作业，按 (productCode, subProductCode, payMode) 反查所有持有资源的用户 AppId
	// - getUserResources：按 (uin, appId) 反查某用户名下全部资源清单
	// - queryResource：按 resourceIds 列表反查资源详情（最权威，发货 / 退款 / 对账核实用）
	InterfaceNameGetAllAppIDs     = "lightvela.pass.getAllAppIds"
	InterfaceNameGetUserResources = "lightvela.pass.getUserResources"
	InterfaceNameQueryResource    = "lightvela.pass.queryResource"

	// 隔离 / 流程查询（trade-pass-isolate-design §3 / Sub-4）：
	// - isolateResource：jifei 到期 / 主动隔离回调，trade 反向调 ctl /internal/ctl/passes/{pass_id}/isolate
	//   完成 pass.status active → isolating CAS + 派发后台 task；trade 侧用 trade_flow.id 做 jifei flowId 出参
	// - queryFlow：jifei 查询长事务进度，trade 按 flow_id（= trade_flow.id BIGINT）反查 status 映射
	//   completed → 0 / in_progress → 2 / failed → 3
	InterfaceNameIsolateResource = "lightvela.pass.isolateResource"
	InterfaceNameQueryFlow       = "lightvela.pass.queryFlow"

	// 续费（.tmp/trade-pass-renew-design.md §3.1 / §4 / §5）：
	// - checkRenew：jifei 续费业务校验回调，trade 5 维校验对账（pid / sv_* / timeSpan / timeUnit / goodsNum），
	//   错误码遵循 Q14=a 5 码归并表（InvalidPara/PassNotFound/PassNotRenewable/CurDeadlineMismatch/InternalError），
	//   对齐计费前端配置文档 ID 237110816
	// - renewResource：jifei 续费发货回调，trade 抢占式幂等（trade_flow.flow_type='renew_resource'）+
	//   反向调 ctl /internal/ctl/passes/{pass_id}/renew 推进 pass.status active → renewing CAS + 续期 expired_time
	InterfaceNameCheckRenew    = "lightvela.pass.checkRenew"
	InterfaceNameRenewResource = "lightvela.pass.renewResource"

	// 销毁（.tmp/trade-pass-destroy-design.md §3.4 / §11）：
	// - destroyResource：jifei 主动驱动销毁回调，trade 抢占式幂等（trade_flow.flow_type='destroy_resource'）+
	//   反向调 ctl /internal/ctl/passes/{pass_id}/destroy 推进 pass.status deleting/isolated → terminating CAS +
	//   派发 DestroyPass 父 task；trade 侧用 trade_flow.id 做 jifei flowId 出参（与 isolateResource 抢占式范式对偶）
	InterfaceNameDestroyResource = "lightvela.pass.destroyResource"

	// 外部资源迁入（.tmp/资源迁移+-+transferResource.doc）：
	// - transferResource：jifei 外部资源迁入单发货回调，trade 反向调 ctl 绑定既有 pass
	//   的 uin/app_id 并把免费 bundle 迁移为计费 bundle。
	InterfaceNameTransferResource = "lightvela.pass.transferResource"
)

// InstallStubHandlers 把仍未落地的 handler stub 注册到 dispatcher；
// 已落地的真 handler 由各业务包独立 Install 函数注册（避免本包反向依赖业务包）。
//
// 当前已落地（迭代 11B + R-C 完成后）：
//   - lightvela.pass.checkCreate     → 迭代 5 已落地（trade/internal/logic/checkcreate.Install）
//   - lightvela.pass.createResource  → 迭代 6 已落地（trade/internal/logic/createresource.Install）
//   - lightvela.pass.getAllAppIds      → 迭代 11B 已落地（trade/internal/logic/resourcequery.Install）
//   - lightvela.pass.getUserResources  → 迭代 11B 已落地（trade/internal/logic/resourcequery.Install）
//   - lightvela.pass.queryResource     → 迭代 11B 已落地（trade/internal/logic/resourcequery.Install）
//   - lightvela.pass.isolateResource   → Sub-4 已落地（trade/internal/logic/isolateresource.Install）
//   - lightvela.pass.queryFlow         → Sub-4 已落地（trade/internal/logic/queryflow.Install）
//   - lightvela.pass.checkRenew        → R-C 已落地（trade/internal/logic/checkrenew.Install）
//   - lightvela.pass.renewResource     → R-C 已落地（trade/internal/logic/renewresource.Install）
//   - lightvela.pass.destroyResource   → D-1 已落地（trade/internal/logic/destroyresource.Install）—
//     D-1 仅 handler 骨架（抢占 + 返 flowId，不调 ctl）；D-5 切片把 ctlAdapter.DestroyPass 反向调补全
//
// 当前没有 stub 占位 — 本函数保留为空实现，向后兼容已有测试 / 调用方。
// 后续迭代如新增销毁 / 退款等回调，真 handler 落地之前在本函数补 stub 注册。
//
// 调用方约定：server 装配阶段先调本函数注册剩余 stub（如有），再调具体业务包的 Install
// 注册真 handler — 顺序无所谓（dispatcher 同名 key 重复注册会 panic，配置错就尽早暴露）。
func InstallStubHandlers(d *Dispatcher) {
	// R-C 起 checkRenew / renewResource 都已经有真 handler，本函数当前为空。
	// 保留函数签名向后兼容；新增动作的 stub 在此追加。
	_ = d
}

// stubHandler 构造一个统一形态的 stub handler；提取出来减少 InstallStubHandlers /
// InstallStubHandlersExceptCheckCreate 之间重复代码。
func stubHandler(d *Dispatcher, interfaceName string, iteration int) Handler {
	return func(ctx context.Context, _ json.RawMessage) (Framework, error) {
		return d.builder.NewError(
			ReturnCodeNotImplemented,
			fmt.Sprintf("%s handler not implemented yet (planned: iteration %d); seqId=%s",
				interfaceName, iteration, SeqIDFromContext(ctx)),
		), nil
	}
}

// CallbackHandler 构造 gin handler，绑定到 `POST /trade/jifei/callback`（Q60 统一 endpoint）。
//
// 处理流程：
//  1. 读 body（Content-Length 限制由 gin / nginx 上游中间件兜底，本层不做大小校验）
//  2. 交给 dispatcher.Dispatch — 路由 + handler 调用 + framework 出参构造一站式完成
//  3. 恒返 HTTP 200 + framework 出参（jifei 按 returnCode 判定成败而非 HTTP status）
//
// 唯一例外：HTTP body 读取本身失败（极罕见，如客户端连接断开）→ 返 400 + framework 错误响应；
// 此时 jifei 通常已经因连接异常本地处理，不会按 returnCode 解析。
func CallbackHandler(d *Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			resp := d.builder.NewError(ReturnCodeInvalidEnvelope, fmt.Sprintf("read body: %v", err))
			// v1.7.28 联调期临时 dump：入向 read body 失败也打日志（与下方 [jifei-cb-out] 对称）。
			log.Printf("[jifei-cb-in] read body failed: %v", err)
			c.JSON(http.StatusBadRequest, resp)
			return
		}
		// v1.7.28 联调期临时 dump：把 jifei 真实回调入参 raw body 完整打到日志（与 jifeiclient.do
		// 的 [jifei-out]/[jifei-in] 同范式），便于排障 jifei 真实回调字段集 / interfaceName 路由。
		// 联调结束须移除（grep "[jifei-cb-" 删行 + 移除 log import）。
		log.Printf("[jifei-cb-in] body=%s", string(body))
		resp := d.Dispatch(c.Request.Context(), body)
		// 同步 dump 出向 framework 响应（returnCode / returnMessage / data 全字段）。
		log.Printf("[jifei-cb-out] returnCode=%d returnValue=%d returnMessage=%q data=%+v",
			resp.ReturnCode, resp.ReturnValue, resp.ReturnMessage, resp.Data)
		// HTTP 状态恒 200：jifei 按 returnCode 判定（PDF 第 7-8 页明示）。
		c.JSON(http.StatusOK, resp)
	}
}
