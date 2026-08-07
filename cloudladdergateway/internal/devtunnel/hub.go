// Package devtunnel 是一个最小化的反向 HTTP 隧道，用于把 tkex 集群内的回调请求
// 送到集群外、只能出站不能被反向连入的开发者机器（DevCloud）。
//
// 为什么需要它：jifei 计费的回调经云梯改派到开发者环境，但云梯所在的 tkex pod
// 反向连不到 DevCloud（实测 10s 超时）；而 DevCloud 出站到云梯是通的。所以由
// DevCloud 侧的 agent 主动出站长轮询本 hub，把"云梯 → 开发者机器"这段反过来走。
//
// 刻意不使用 frp 等开源隧道：它们的握手协议有已知指纹会被安全扫描命中。本实现
// 全程是普通 JSON over HTTP，与正常业务流量无异。
//
// 分流 key 是 Host —— 云梯每条 dev 路由 upstream 盖一个不同的 Host，hub 据此把
// 回调分到对应开发者的 agent 连接。加一个开发者只需一个新 Host + 一个 agent。
package devtunnel

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// TunneledRequest 是 hub 交给 agent 回放的一次请求快照。
type TunneledRequest struct {
	RID     string              `json:"rid"`
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Query   string              `json:"query"`
	Headers map[string][]string `json:"headers"`
	Body    []byte              `json:"body"`
}

// TunneledResponse 是 agent 回放本地服务后交回的应答。
type TunneledResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	Body    []byte              `json:"body"`
}

// pending 是一次在途请求：hub 把它推给某个 env 的等待队列，agent 取走并回放，
// 再通过 reply 把应答送回 replyCh，唤醒阻塞的 ingest。
type pending struct {
	req     TunneledRequest
	replyCh chan TunneledResponse
}

var (
	// ErrTimeout 表示在约定时间内没有 agent 取走请求或没有回应答。
	ErrTimeout = errors.New("devtunnel: timed out waiting for agent")
	// ErrShutdown 表示 hub 正在关闭。
	ErrShutdown = errors.New("devtunnel: hub shutting down")
)

// Hub 按 env（Host）维护每个开发者环境的在途请求队列与应答路由。
//
// 并发模型：
//   - queues[env] 是一个无缓冲 channel，ingest 往里塞 *pending，poll 从里取；
//     用 channel 天然实现"有 agent 在等才交付、否则 ingest 一直阻塞到超时"。
//   - pendingByRID 让 reply 能按 rid 找回对应 *pending 的 replyCh。
type Hub struct {
	mu           sync.Mutex
	queues       map[string]chan *pending
	pendingByRID map[string]*pending
	closed       bool
}

// NewHub 构造一个空 hub。
func NewHub() *Hub {
	return &Hub{
		queues:       make(map[string]chan *pending),
		pendingByRID: make(map[string]*pending),
	}
}

// queueFor 返回（必要时创建）某个 env 的队列 channel。
func (h *Hub) queueFor(env string) chan *pending {
	h.mu.Lock()
	defer h.mu.Unlock()
	q, ok := h.queues[env]
	if !ok {
		q = make(chan *pending)
		h.queues[env] = q
	}
	return q
}

// Dispatch 由 ingest 侧调用：把一次请求投递给 env 对应的 agent 并阻塞等应答。
//
// 语义：
//   - 在 ctx 截止前若无 agent 取走请求，返回 ErrTimeout（此时 hub 已放弃该请求）。
//   - 取走后若 agent 未在 ctx 截止前回应答，同样返回 ErrTimeout。
//   - 成功则返回 agent 回放本地服务得到的应答。
func (h *Hub) Dispatch(ctx context.Context, env string, req TunneledRequest) (TunneledResponse, error) {
	p := &pending{
		req:     req,
		replyCh: make(chan TunneledResponse, 1),
	}

	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return TunneledResponse{}, ErrShutdown
	}
	h.pendingByRID[req.RID] = p
	h.mu.Unlock()

	// 无论走哪个分支，最终都要把 rid 从表里摘掉，避免泄漏。
	defer func() {
		h.mu.Lock()
		delete(h.pendingByRID, req.RID)
		h.mu.Unlock()
	}()

	q := h.queueFor(env)

	// 第一步：把请求交给正在（或即将）poll 的 agent。
	select {
	case q <- p:
	case <-ctx.Done():
		return TunneledResponse{}, ErrTimeout
	}

	// 第二步：等 agent 回放后交回的应答。
	select {
	case resp := <-p.replyCh:
		return resp, nil
	case <-ctx.Done():
		return TunneledResponse{}, ErrTimeout
	}
}

// Poll 由 agent 侧调用：阻塞等待 env 队列上的下一个请求。
//
// 返回 (req, true, nil) 表示取到一个请求；(_, false, nil) 表示在 ctx 截止前
// 队列空闲（agent 应据此重新发起下一次长轮询）。
func (h *Hub) Poll(ctx context.Context, env string) (TunneledRequest, bool, error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return TunneledRequest{}, false, ErrShutdown
	}
	h.mu.Unlock()

	q := h.queueFor(env)
	select {
	case p := <-q:
		return p.req, true, nil
	case <-ctx.Done():
		return TunneledRequest{}, false, nil
	}
}

// Reply 由 agent 侧调用：把某个 rid 的应答送回等待的 ingest。
//
// 返回 false 表示该 rid 已不存在（ingest 已超时放弃，或重复 reply）。
func (h *Hub) Reply(rid string, resp TunneledResponse) bool {
	h.mu.Lock()
	p, ok := h.pendingByRID[rid]
	if ok {
		delete(h.pendingByRID, rid)
	}
	h.mu.Unlock()
	if !ok {
		return false
	}
	// replyCh 容量为 1，且每个 rid 只会被摘一次，这里不会阻塞。
	p.replyCh <- resp
	return true
}

// Close 关闭 hub：拒绝新的 Dispatch/Poll。已在途的请求由各自的 ctx 超时收敛。
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
}

// EncodeRequest / DecodeResponse 是给 HTTP 层复用的小工具，保证两侧 JSON 形状一致。
func EncodeRequest(req TunneledRequest) ([]byte, error) { return json.Marshal(req) }
func DecodeResponse(b []byte) (TunneledResponse, error) {
	var r TunneledResponse
	err := json.Unmarshal(b, &r)
	return r, err
}

// DefaultDispatchTimeout 是 ingest 侧等待 agent 的默认上限。
// 取 8s：小于 jifei generateDeals 同步等 checkCreate 的 ~10s，留出余量。
const DefaultDispatchTimeout = 8 * time.Second

// DefaultPollTimeout 是 agent 单次长轮询的默认挂起时长。
const DefaultPollTimeout = 25 * time.Second
