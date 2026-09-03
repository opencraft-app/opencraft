package devtunnel

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestDispatchDeliveredToPollingAgent 覆盖 happy-path：
// agent 在 poll，ingest 投递请求，agent reply，ingest 拿到应答。
func TestDispatchDeliveredToPollingAgent(t *testing.T) {
	h := NewHub()
	defer h.Close()

	const env = "dev1.tunnel"
	req := TunneledRequest{RID: "r1", Method: "POST", Path: "/trade/jifei/callback", Body: []byte(`{"uin":"700003135209"}`)}

	// agent：先 poll，取到后 reply。
	agentDone := make(chan struct{})
	go func() {
		defer close(agentDone)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		got, ok, err := h.Poll(ctx, env)
		if err != nil || !ok {
			t.Errorf("Poll: ok=%v err=%v", ok, err)
			return
		}
		if got.RID != req.RID || string(got.Body) != string(req.Body) {
			t.Errorf("polled request mismatch: %+v", got)
		}
		h.Reply(got.RID, TunneledResponse{Status: 200, Body: []byte(`{"returnCode":0}`)})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	resp, err := h.Dispatch(ctx, env, req)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if resp.Status != 200 || string(resp.Body) != `{"returnCode":0}` {
		t.Fatalf("unexpected response: %+v", resp)
	}
	<-agentDone
}

// TestDispatchTimesOutWhenNoAgent 验证：没有 agent poll 时，ingest 在 ctx 截止后
// 返回 ErrTimeout，而不是永久阻塞。
func TestDispatchTimesOutWhenNoAgent(t *testing.T) {
	h := NewHub()
	defer h.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := h.Dispatch(ctx, "dev-nobody", TunneledRequest{RID: "r2"})
	if err != ErrTimeout {
		t.Fatalf("expected ErrTimeout, got %v", err)
	}
}

// TestDispatchTimesOutWhenAgentNeverReplies 验证：agent 取走请求但不 reply 时，
// ingest 仍在 ctx 截止后超时，且 rid 不泄漏。
func TestDispatchTimesOutWhenAgentNeverReplies(t *testing.T) {
	h := NewHub()
	defer h.Close()

	const env = "dev-silent"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _, _ = h.Poll(ctx, env) // 取走但不 reply
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := h.Dispatch(ctx, env, TunneledRequest{RID: "r3"})
	if err != ErrTimeout {
		t.Fatalf("expected ErrTimeout, got %v", err)
	}

	h.mu.Lock()
	_, leaked := h.pendingByRID["r3"]
	h.mu.Unlock()
	if leaked {
		t.Fatalf("pending rid r3 leaked after timeout")
	}
}

// TestPollReturnsFalseOnIdle 验证：空闲队列上的 poll 到点返回 (false,nil)，
// 供 agent 重新发起下一轮长轮询。
func TestPollReturnsFalseOnIdle(t *testing.T) {
	h := NewHub()
	defer h.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, ok, err := h.Poll(ctx, "dev-idle")
	if err != nil || ok {
		t.Fatalf("expected idle (false,nil), got ok=%v err=%v", ok, err)
	}
}

// TestReplyUnknownRIDReturnsFalse 验证：对不存在（或已超时摘除）的 rid 回应答返回 false。
func TestReplyUnknownRIDReturnsFalse(t *testing.T) {
	h := NewHub()
	defer h.Close()
	if h.Reply("ghost", TunneledResponse{Status: 200}) {
		t.Fatalf("Reply on unknown rid should return false")
	}
}

// TestEnvIsolation 验证：不同 env 的请求互不串台 —— devA 的 agent 不会收到 devB 的请求。
func TestEnvIsolation(t *testing.T) {
	h := NewHub()
	defer h.Close()

	// devB 的 agent 在 poll；devA 投递请求不应被它取走。
	pollErr := make(chan bool, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		defer cancel()
		_, ok, _ := h.Poll(ctx, "devB")
		pollErr <- ok
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := h.Dispatch(ctx, "devA", TunneledRequest{RID: "rA"})
	if err != ErrTimeout {
		t.Fatalf("devA dispatch should time out (devB agent must not take it), got %v", err)
	}
	if ok := <-pollErr; ok {
		t.Fatalf("devB agent wrongly received devA's request")
	}
}

// TestConcurrentDispatch 压一下并发：多个 ingest 同时投递、一个 agent 循环消费，
// 确保 rid 与应答一一对应、无串台无死锁。
func TestConcurrentDispatch(t *testing.T) {
	h := NewHub()
	defer h.Close()

	const env = "dev-load"
	const n = 50

	// agent：循环 poll → 回一个带 rid 标记的应答。
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			req, ok, _ := h.Poll(ctx, env)
			cancel()
			if ok {
				h.Reply(req.RID, TunneledResponse{Status: 200, Body: []byte(req.RID)})
			}
		}
	}()
	defer close(stop)

	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rid := "r-" + string(rune('A'+i%26)) + time.Now().Format("150405.000000000") + string(rune('0'+i%10))
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			resp, err := h.Dispatch(ctx, env, TunneledRequest{RID: rid})
			if err != nil {
				errs <- err
				return
			}
			if string(resp.Body) != rid {
				t.Errorf("response body %q != rid %q (串台)", resp.Body, rid)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent dispatch error: %v", err)
	}
}

// TestDispatchAfterCloseFails 验证：hub 关闭后新的 Dispatch 直接失败。
func TestDispatchAfterCloseFails(t *testing.T) {
	h := NewHub()
	h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := h.Dispatch(ctx, "dev1", TunneledRequest{RID: "rX"})
	if err != ErrShutdown {
		t.Fatalf("expected ErrShutdown, got %v", err)
	}
}
