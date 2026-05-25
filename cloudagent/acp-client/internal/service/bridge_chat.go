// 有界 FIFO + 单 worker 串行处理（promptQueue + pumpPromptQueue）。
package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"syscall"

	"acp-client/internal/correl"
	"acp-client/pkg/acp"
)

func (b *Bridge) clearPromptQueue() {
	b.queueMu.Lock()
	b.promptQueue = nil
	b.queueMu.Unlock()
}

func (b *Bridge) BroadcastQueueState() {
	m := b.queueSnapshot()
	m["op"] = "queue_state"
	b.Broadcast(m)
}

// pumpPromptQueue 在「当前无 activeTurn」时从 FIFO 取一条并启动执行。
// 须在启动 goroutine **之前**同步占用 activeTurn，否则连续 Chat 会在首条 runPrompt 尚未设 activeTurn 时再次入泵，导致多条 session/prompt 并发（顺序错乱）；须保证每会话单 worker 串行消费。
func (b *Bridge) pumpPromptQueue() {
	b.turnMu.Lock()
	if b.activeTurn != nil {
		b.turnMu.Unlock()
		b.BroadcastQueueState()
		return
	}

	b.queueMu.Lock()
	if len(b.promptQueue) == 0 {
		b.queueMu.Unlock()
		b.turnMu.Unlock()
		b.BroadcastQueueState()
		return
	}
	item := b.promptQueue[0]
	b.promptQueue = b.promptQueue[1:]
	b.queueMu.Unlock()

	b.mu.Lock()
	p := b.panel
	ctx := b.agentCtx
	b.mu.Unlock()
	if p == nil {
		b.queueMu.Lock()
		b.promptQueue = append([]queuedPrompt{item}, b.promptQueue...)
		b.queueMu.Unlock()
		b.turnMu.Unlock()
		b.BroadcastQueueState()
		return
	}

	oid := item.OpID
	if oid == "" {
		oid = correl.ID()
	}
	turnCtx, cancelTurn := context.WithCancel(ctx)
	th := &promptTurn{cancel: cancelTurn, opID: oid, userText: item.Text, imageCount: len(item.Images)}
	b.activeTurn = th
	b.turnMu.Unlock()

	log.Printf("prompt %s oid=%s: 开始 session/prompt textLen=%d", b.AgentLogPrefix(), oid, len(item.Text))

	b.BroadcastQueueState()
	// 每轮 prompt 边界：避免上一轮未收到 prompt_done 时前端仍把新正文流式接到同一助手块（见 chat_view appendStreamAgent）
	promptBeginData := map[string]any{
		"type":       "prompt_begin",
		"sessionId":  p.SessionID,
		"opId":       oid,
		"text":       item.Text,
		"promptText": item.Text,
	}
	// 将图片转为 data URL 列表，供前端刷新后重放时恢复用户气泡中的图片
	if len(item.Images) > 0 {
		urls := make([]string, 0, len(item.Images))
		for _, img := range item.Images {
			if img.Data == "" {
				continue
			}
			mime := img.MimeType
			if mime == "" {
				mime = "image/png"
			}
			urls = append(urls, "data:"+mime+";base64,"+img.Data)
		}
		if len(urls) > 0 {
			promptBeginData["imageURLs"] = urls
		}
	}
	b.Broadcast(map[string]any{
		"op":   "event",
		"data": promptBeginData,
	})

	go b.executePrompt(p, turnCtx, item, th, cancelTurn)
}

func (b *Bridge) executePrompt(p *acp.Panel, turnCtx context.Context, item queuedPrompt, th *promptTurn, cancelTurn context.CancelFunc) {
	oid := th.opID
	defer func() {
		b.turnMu.Lock()
		if b.activeTurn == th {
			b.activeTurn = nil
		}
		b.turnMu.Unlock()
		cancelTurn()
		b.recordUserTurnDone(item)
		b.pumpPromptQueue()
	}()

	_, err := p.Prompt(turnCtx, item.Text, item.Images)
	if err == nil {
		return
	}
	log.Printf("prompt %s oid=%s: 结束 err=%v", b.AgentLogPrefix(), oid, err)
	if errors.Is(err, context.Canceled) && th.fromUserStop.Load() {
		sid := p.SessionID
		b.Broadcast(map[string]any{
			"op": "event",
			"data": map[string]any{
				"type":       "prompt_done",
				"sessionId":  sid,
				"stopReason": "cancelled",
			},
		})
		return
	}
	if errors.Is(err, context.Canceled) {
		return
	}
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "connection closed") || strings.Contains(low, "broken pipe") ||
		strings.Contains(low, "write |1:") || errors.Is(err, syscall.EPIPE) {
		return
	}
	b.Broadcast(map[string]any{"op": "error", "message": acp.UserFacingAny(err)})
}

func (b *Bridge) CancelPrompt() {
	b.mu.Lock()
	p := b.panel
	b.mu.Unlock()

	var stopTurn context.CancelFunc
	b.turnMu.Lock()
	if t := b.activeTurn; t != nil {
		t.fromUserStop.Store(true)
		stopTurn = t.cancel
	}
	b.turnMu.Unlock()

	// 先通知 Agent（session/cancel + $/cancel_request），再取消本地 wait，避免只断客户端、子进程仍在跑
	if p != nil {
		if err := p.Cancel(); err != nil {
			log.Printf("ws→acp %s: Stop 通知 Agent 失败: %v", b.AgentLogPrefix(), err)
		}
	}
	if stopTurn != nil {
		stopTurn()
	}
	log.Printf("ws→acp %s: CancelPrompt 已执行", b.AgentLogPrefix())
	// 取消当前轮次并丢弃尚未开始处理的排队消息
	b.clearPromptQueue()
	b.BroadcastQueueState()
}

// Chat 将用户消息入队；无 oid 时自动生成（非 WS 入口时仍可有可搜日志键）。
func (b *Bridge) Chat(text string) error {
	return b.ChatWithOpID(text, correl.ID(), "chat", nil)
}

// ChatWithOpID 与 WebSocket 单次 chat 帧共用 oid（与 InMessage.ID 一致）；action 默认 chat。
func (b *Bridge) ChatWithOpID(text, opID, action string, images []PromptImage) error {
	t := strings.TrimSpace(text)
	if t == "" && len(images) == 0 {
		return errors.New("empty message")
	}
	if opID == "" {
		opID = correl.ID()
	}
	action = strings.TrimSpace(action)
	if action == "" {
		action = "chat"
	}
	b.mu.Lock()
	ok := b.panel != nil
	b.mu.Unlock()
	if !ok {
		return errors.New("not connected; send connect first")
	}

	b.enqueueMu.Lock()
	defer b.enqueueMu.Unlock()

	b.queueMu.Lock()
	if len(b.promptQueue) >= MaxPromptQueueItems {
		b.queueMu.Unlock()
		return fmt.Errorf("消息队列已满（最多 %d 条），请等待当前回复结束后再发", MaxPromptQueueItems)
	}
	b.promptQueue = append(b.promptQueue, queuedPrompt{Text: t, OpID: opID, Action: action, Images: images})
	b.queueMu.Unlock()
	b.BroadcastQueueState()
	b.pumpPromptQueue()
	return nil
}
