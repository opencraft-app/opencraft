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

// InstallStubHandlers 把迭代 4 stub 注册到 dispatcher；迭代 5/6 替换为真实 handler 时
// 调用方改用对应业务包的 InstallHandlers 函数（不在本文件直接 import 业务包，避免循环依赖）。
//
// stub 行为：路由命中后返非零 returnCode `ReturnCodeNotImplemented`，message 注明动作名 + 迭代号；
// 测试可断言 stub 被正确路由（通过 returnCode 区分协议层错 vs 业务层 stub）。
func InstallStubHandlers(d *Dispatcher) {
	d.Register(InterfaceNameCheckCreate, func(ctx context.Context, para json.RawMessage) (Framework, error) {
		// TODO(iteration 5): 替换为 logic/check_create.Handler — Q54 五维校验 + Q56 错误分类
		return d.builder.NewError(
			ReturnCodeNotImplemented,
			fmt.Sprintf("checkCreate handler not implemented yet (planned: iteration 5); seqId=%s", SeqIDFromContext(ctx)),
		), nil
	})
	d.Register(InterfaceNameCreateResource, func(ctx context.Context, para json.RawMessage) (Framework, error) {
		// TODO(iteration 6): 替换为 logic/create_resource.Handler — Q61 抢占式幂等 + Q56 退款响应分类
		return d.builder.NewError(
			ReturnCodeNotImplemented,
			fmt.Sprintf("createResource handler not implemented yet (planned: iteration 6); seqId=%s", SeqIDFromContext(ctx)),
		), nil
	})
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
