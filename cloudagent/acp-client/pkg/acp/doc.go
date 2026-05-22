// Package acp 是 Cursor Agent Client Protocol (ACP) 的 Go 客户端 SDK。
//
// 该包封装了与 cursor-agent（或任意兼容 ACP 的 Agent）建立 JSON-RPC
// 双向连接、完成 initialize / session/new 握手、转发 session/update
// 通知，以及处理 fs/* 与 terminal/* 反向请求的全部细节，便于宿主程序
// （CLI、网关、IDE 插件等）以最小代码量集成 ACP。
//
// # 快速开始
//
// 通过 WebSocket 连接远端 ACP 服务：
//
//	panel, err := acp.NewPanelWS(ctx, "ws://127.0.0.1:9000/acp",
//	    cwd, fsRoot, mcpServersJSON,
//	    func(ev json.RawMessage) { /* 处理 session_update / fs_write 等事件 */ },
//	    nil, // PermissionChooser，nil 时自动选择 allow_once
//	)
//	if err != nil { return err }
//	defer panel.Close()
//
//	stop, err := panel.Prompt(ctx, "你好", nil)
//
// 通过子进程（stdio）连接本机 cursor-agent：
//
//	panel, err := acp.NewPanel(procCtx, rpcCtx,
//	    []string{"cursor-agent", "acp"}, os.Environ(),
//	    cwd, fsRoot, mcpServersJSON, onEvent, nil,
//	)
//
// # 主要导出
//
//   - [Panel]：一条 ACP 会话的高层句柄；提供 [Panel.Prompt]、[Panel.Cancel]、[Panel.Close]。
//   - [NewPanel] / [NewPanelWS]：分别以子进程 stdio 与 WebSocket 方式建立连接并完成握手。
//   - [PromptImage]：用户消息中的图片附件（base64）。
//   - [PermissionChooser]：可选回调，用于响应 session/request_permission；为 nil 时使用 [DefaultPermissionForParams]。
//   - [UserFacingAny]：把底层 IO / 超时错误翻译为面向终端用户的可读文案。
//   - [Conn]：底层 JSON-RPC 连接，仅在需要直接发送自定义方法时使用。
//
// # 不在本包范围
//
// 本包只负责 ACP 协议层；用户消息排队、广播、HTTP/WebSocket 网关、
// 浏览器 UI 等应用层职责由宿主程序（在本仓库为 internal/service 与
// internal/handler）实现。
package acp
