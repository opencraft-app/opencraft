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
// 当前已落地（迭代 6 完成后）：
//   - lightvela.pass.checkCreate     → 迭代 5 已落地（trade/internal/logic/checkcreate.Install）
//   - lightvela.pass.createResource  → 迭代 6 已落地（trade/internal/logic/createresource.Install）
//
// 当前没有 stub 占位 — 本函数保留为空实现，向后兼容已有测试 / 调用方。
// 后续迭代如新增续费 / 隔离 / 销毁回调（lightvela.pass.renew / isolate / destroy 等），
// 真 handler 落地之前在本函数补 stub 注册。
//
// 调用方约定：server 装配阶段先调本函数注册剩余 stub（如有），再调具体业务包的 Install
// 注册真 handler — 顺序无所谓（dispatcher 同名 key 重复注册会 panic，配置错就尽早暴露）。
func InstallStubHandlers(d *Dispatcher) {
	// 迭代 6 起 checkCreate / createResource 都已经有真 handler，本函数当前为空。
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
			c.JSON(http.StatusBadRequest, resp)
			return
		}
		resp := d.Dispatch(c.Request.Context(), body)
		// HTTP 状态恒 200：jifei 按 returnCode 判定（PDF 第 7-8 页明示）。
		c.JSON(http.StatusOK, resp)
	}
}
