package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"acp-client/pkg/acp"
)

// ConnectPayload 与前端 WebSocket `op: connect` 对齐（argv 由服务端固定，仅解析目录与 MCP）。
type ConnectPayload struct {
	Op             string          `json:"op"`
	Cwd            string          `json:"cwd"`
	FsRoot         string          `json:"fsRoot"`
	McpServers     json.RawMessage `json:"mcpServers"`
	AutoPermission *bool           `json:"autoPermission"`
	Params         json.RawMessage `json:"params"`
}

type connectInner struct {
	Cwd            string          `json:"cwd"`
	FsRoot         string          `json:"fsRoot"`
	McpServers     json.RawMessage `json:"mcpServers"`
	AutoPermission *bool           `json:"autoPermission"`
}

// ParseConnect 解析连接参数（支持扁平或 params 嵌套）。
func ParseConnect(raw []byte) (cwd, fsRoot string, mcp json.RawMessage, auto *bool, err error) {
	var body ConnectPayload
	if err = json.Unmarshal(raw, &body); err != nil {
		return
	}
	if len(body.Params) > 0 && string(body.Params) != "null" {
		var inner connectInner
		if err = json.Unmarshal(body.Params, &inner); err != nil {
			return
		}
		return inner.Cwd, inner.FsRoot, inner.McpServers, inner.AutoPermission, nil
	}
	return body.Cwd, body.FsRoot, body.McpServers, body.AutoPermission, nil
}

// DefaultACPURL 默认的远程 ACP WebSocket 服务地址。
const DefaultACPURL = "ws://101.42.117.125:8080/acp"

// ConnectedPayload 返回 op:connected 元数据 + PromptQueueSnapshot()（队列与 userTimeline 单一路径，避免重复字段与双算时间线）。
func (b *Bridge) ConnectedPayload(p *acp.Panel) map[string]any {
	agentInfo := map[string]any{
		"name":    p.AgentName,
		"title":   p.AgentTitle,
		"version": p.AgentVersion,
	}
	if p.ModelID != "" {
		agentInfo["modelId"] = p.ModelID
		agentInfo["modelName"] = p.ModelName
	}
	m := map[string]any{
		"op":        "connected",
		"sessionId": p.SessionID,
		"cwd":       p.CWD,
		"fsRoot":    p.FSRoot,
		"agent":     agentInfo,
	}
	if p.ModelID != "" {
		m["model"] = map[string]any{
			"id":   p.ModelID,
			"name": p.ModelName,
		}
		m["currentModel"] = p.ModelID
	}
	for k, v := range b.PromptQueueSnapshot() {
		m[k] = v
	}
	// 附带最近 10 轮事件日志，供前端刷新后重放恢复聊天界面
	events, totalTurns, hasMore := b.EventLogRecentTurns(10)
	m["eventLog"] = events
	m["totalTurns"] = totalTurns
	m["hasMoreTurns"] = hasMore
	return m
}

// StartDefaultAgent 在进程启动后于后台连接远程 ACP 服务；失败仅打日志，浏览器 connect 会重试。
func (b *Bridge) StartDefaultAgent() {
	go func() {
		t := true
		_, err := b.EnsureAgent("", "", nil, &t)
		if err != nil {
			log.Printf("acp: 启动时连接远程 ACP 失败（前端 connect 将重试）: %v", err)
			return
		}
		log.Printf("acp: 已通过 WebSocket 建立远程 ACP 会话（单例）")
	}()
}

// EnsureAgent 若已有 Panel 则直接返回；否则通过 WebSocket 连接远程 ACP 服务。
func (b *Bridge) EnsureAgent(cwd, fsRoot string, mcp json.RawMessage, auto *bool) (*acp.Panel, error) {
	b.ensureMu.Lock()
	defer b.ensureMu.Unlock()

	b.mu.Lock()
	if b.panel != nil {
		p := b.panel
		b.mu.Unlock()
		return p, nil
	}
	b.mu.Unlock()

	if auto == nil {
		t := true
		auto = &t
	}
	b.mu.Lock()
	url := b.acpURL
	b.mu.Unlock()
	if url == "" {
		url = DefaultACPURL
	}
	return b.ConnectWS(url, cwd, fsRoot, mcp, auto)
}

// ConnectWS 通过 WebSocket 连接远程 ACP 服务，建立或替换会话。
func (b *Bridge) ConnectWS(wsURL, cwd, fsRoot string, mcp json.RawMessage, auto *bool) (*acp.Panel, error) {
	if wsURL == "" {
		return nil, errors.New("connect: WebSocket URL 不能为空")
	}
	if cwd == "" {
		wd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		cwd = wd
	}
	fsEff := fsRoot
	if fsEff == "" {
		fsEff = cwd
	}
	log.Printf("acp: [WebSocket] 连接 %s cwd=%q fsRoot=%q", wsURL, cwd, fsEff)

	b.mu.Lock()
	if b.panel != nil {
		b.agentCancel()
		_ = b.panel.Close()
		b.panel = nil
	}
	b.agentCtx, b.agentCancel = context.WithCancel(context.Background())
	if auto != nil {
		b.autoPermission = *auto
	}
	ctx := b.agentCtx
	b.mu.Unlock()

	b.clearPromptQueue()
	b.clearUserTurnHistory()
	b.evLog.clear()

	handshakeCtx, handshakeCancel := context.WithTimeout(ctx, 2*time.Minute)
	defer handshakeCancel()

	onEvent := func(ev json.RawMessage) {
		b.Broadcast(map[string]any{"op": "event", "data": ev})
	}
	perm := func(ctx context.Context, rpcID json.RawMessage, raw json.RawMessage) (string, error) {
		return b.permissionChooser(ctx, rpcID, raw)
	}
	panel, err := acp.NewPanelWS(handshakeCtx, wsURL, cwd, fsEff, mcp, onEvent, perm)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	b.panel = panel
	if len(mcp) > 0 && string(mcp) != "null" {
		b.lastMCP = append(json.RawMessage(nil), mcp...)
	} else {
		b.lastMCP = json.RawMessage(`[]`)
	}
	b.mu.Unlock()
	b.exitNoticeMu.Lock()
	b.lastExitBroadcast = time.Time{}
	b.exitNoticeMu.Unlock()
	go b.watchAgentConn(panel)
	b.BroadcastQueueState()
	return panel, nil
}

// watchAgentConn 在远程 ACP 连接断开后清理会话并通知所有 WebSocket 客户端。
func (b *Bridge) watchAgentConn(watched *acp.Panel) {
	conn := watched.Conn()
	if conn == nil {
		return
	}
	<-conn.Done()

	// WebSocket 模式无子进程，Wait 会直接返回 nil
	_ = conn.Wait()

	b.mu.Lock()
	still := b.panel == watched
	var cancel context.CancelFunc
	if still {
		b.panel = nil
		cancel = b.agentCancel
	}
	b.mu.Unlock()
	if !still {
		return
	}
	b.clearPromptQueue()
	b.clearUserTurnHistory()
	b.evLog.clear()
	b.BroadcastQueueState()
	if cancel != nil {
		cancel()
	}
	_ = watched.Close()

	var sb strings.Builder
	sb.WriteString("远程 ACP 连接已断开。")
	if re := conn.ReadErr(); re != nil {
		log.Printf("acp: WebSocket 读结束: %v", re)
		if _, err := fmt.Fprintf(&sb, " 原因: %v。", re); err != nil {
			log.Printf("acp: 构建退出信息失败: %v", err)
		}
	}
	sb.WriteString(" 将在下次操作时自动重连。")
	b.broadcastAgentExitDebounced(sb.String())
}

const agentExitBroadcastMinInterval = 3 * time.Second

func (b *Bridge) broadcastAgentExitDebounced(msg string) {
	b.exitNoticeMu.Lock()
	defer b.exitNoticeMu.Unlock()
	if !b.lastExitBroadcast.IsZero() && time.Since(b.lastExitBroadcast) < agentExitBroadcastMinInterval {
		log.Printf("acp: 已抑制短时间内重复的 Agent 退出通知")
		return
	}
	b.lastExitBroadcast = time.Now()
	b.Broadcast(map[string]any{
		"op":          "error",
		"message":     msg,
		"agentExited": true,
	})
}

// RestartAgent 断开当前连接并重新通过 WebSocket 建立会话，保留 cwd / fsRoot / MCP / 自动授权设置。
func (b *Bridge) RestartAgent() (*acp.Panel, error) {
	b.ensureMu.Lock()
	defer b.ensureMu.Unlock()

	b.mu.Lock()
	var cwd, fsRoot string
	var mcp json.RawMessage
	if p := b.panel; p != nil {
		cwd = p.CWD
		fsRoot = p.FSRoot
		if len(b.lastMCP) > 0 {
			mcp = append(json.RawMessage(nil), b.lastMCP...)
		}
	}
	auto := b.autoPermission
	url := b.acpURL
	b.mu.Unlock()

	if url == "" {
		url = DefaultACPURL
	}
	if cwd == "" {
		wd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		cwd = wd
	}
	if fsRoot == "" {
		fsRoot = cwd
	}
	if len(mcp) == 0 {
		mcp = json.RawMessage(`[]`)
	}
	ap := auto
	log.Printf("acp: 收到重启请求，将重连远程 ACP（url=%s cwd=%q fsRoot=%q）", url, cwd, fsRoot)
	return b.ConnectWS(url, cwd, fsRoot, mcp, &ap)
}
