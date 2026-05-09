package jifei

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
)

// InstallStubHandlers 把仍未落地的 handler stub 注册到 dispatcher；
// 已落地的真 handler 由各业务包独立 Install 函数注册（避免本包反向依赖业务包）。
//
// 当前已落地：
//   - lightvela.pass.checkCreate     → 迭代 5 已落地（trade/internal/logic/checkcreate.Install）
//
// 仍为 stub：
//   - lightvela.pass.createResource  → 迭代 6 落地
//
// stub 行为：路由命中后返非零 returnCode `ReturnCodeNotImplemented`，message 注明动作名 + 迭代号；
// 测试可断言 stub 被正确路由（通过 returnCode 区分协议层错 vs 业务层 stub）。
//
// 调用方约定：server 装配阶段先调本函数注册剩余 stub，再调具体业务包的 Install
// 注册真 handler — 顺序无所谓（dispatcher 同名 key 重复注册会 panic，配置错就尽早暴露）。
//
// **重要**：迭代 5 起，调用方应改用 InstallStubHandlersExceptCheckCreate（见下方）
// 把 checkCreate 的 stub 跳过，由 checkcreate 包注册真 handler。本函数保持原行为
// 向后兼容（如有测试只想跑 stub 路由不依赖 checkcreate 业务包，仍可用本函数）。
func InstallStubHandlers(d *Dispatcher) {
	d.Register(InterfaceNameCheckCreate, stubHandler(d, InterfaceNameCheckCreate, 5))
	d.Register(InterfaceNameCreateResource, stubHandler(d, InterfaceNameCreateResource, 6))
}

// InstallStubHandlersExceptCheckCreate 仅为迭代 6 之前未落地的 createResource 注册 stub。
//
// 迭代 5 起，server 装配阶段应先调用本函数注册 createResource stub，再调用
// checkcreate.Install 注册 checkCreate 真 handler — 避免 InstallStubHandlers
// 与 checkcreate.Install 之间发生 dispatcher 重复注册 panic。
func InstallStubHandlersExceptCheckCreate(d *Dispatcher) {
	d.Register(InterfaceNameCreateResource, stubHandler(d, InterfaceNameCreateResource, 6))
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
			c.JSON(http.StatusBadRequest, resp)
			return
		}
		resp := d.Dispatch(c.Request.Context(), body)
		// HTTP 状态恒 200：jifei 按 returnCode 判定（PDF 第 7-8 页明示）。
		c.JSON(http.StatusOK, resp)
	}
}
