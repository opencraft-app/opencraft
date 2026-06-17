// Package authcode 单测：覆盖 Issue / Consume / Revoke / TTL / 双消费等
// §7 单测矩阵 T1~T5（设计稿 .tmp/ctl-authcode-codebuddy-design.md）。
package authcode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// newTestStore 起一个进程内 miniredis 并返回 (Store, miniredis)；t.Cleanup 自动关。
func newTestStore(t *testing.T, ttl time.Duration) (Store, *miniredis.Miniredis) {
	t.Helper()

	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(func() {
		mr.Close()
	})

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() {
		_ = client.Close()
	})

	return New(client, ttl), mr
}

// TestAuthCodeStore_IssueConsume_HappyPath 验证 A1：签发→消费→ticket 内容回传完整。
func TestAuthCodeStore_IssueConsume_HappyPath(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	in := &Ticket{
		UserID:    "u-1",
		DealNames: []string{"deal-1"},
		PassID:    "pass-1",
	}
	code, err := s.Issue(ctx, in)
	if err != nil {
		t.Fatalf("Issue err: %v", err)
	}
	if code == "" {
		t.Fatalf("Issue: empty code")
	}
	// UUID v4 字符串：36 字节（8-4-4-4-12 + 4 个短横）
	if len(code) != 36 || strings.Count(code, "-") != 4 {
		t.Errorf("code shape unexpected: %q", code)
	}

	out, err := s.Consume(ctx, code)
	if err != nil {
		t.Fatalf("Consume err: %v", err)
	}
	if out.UserID != "u-1" {
		t.Errorf("UserID: got %q want u-1", out.UserID)
	}
	if len(out.DealNames) != 1 || out.DealNames[0] != "deal-1" {
		t.Errorf("DealNames: got %v want [deal-1]", out.DealNames)
	}
	if out.PassID != "pass-1" {
		t.Errorf("PassID: got %q want pass-1", out.PassID)
	}
	if out.IssuedAt == 0 {
		t.Errorf("IssuedAt should be auto-filled")
	}
}

// TestAuthCodeStore_Issue_ParamValidation 验证签发期入参校验：缺 user_id /
// deal_names 直接返错，不写 Redis。
func TestAuthCodeStore_Issue_ParamValidation(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	cases := []struct {
		name string
		in   *Ticket
	}{
		{"nil ticket", nil},
		{"empty user_id", &Ticket{DealNames: []string{"d"}}},
		{"empty deal_names", &Ticket{UserID: "u"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.Issue(ctx, tc.in)
			if err == nil {
				t.Fatalf("expected err, got nil")
			}
		})
	}
}

// TestAuthCodeStore_Consume_NotFound 验证 A1：伪造 auth_code 直接返
// ErrTicketNotFound（不抛 raw redis err）。
func TestAuthCodeStore_Consume_NotFound(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	_, err := s.Consume(ctx, "fake-code-not-existed")
	if !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("err should be ErrTicketNotFound, got %v", err)
	}
}

// TestAuthCodeStore_Consume_EmptyCode 验证 A1：空字符串短路返 ErrTicketNotFound。
func TestAuthCodeStore_Consume_EmptyCode(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	_, err := s.Consume(ctx, "")
	if !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("err should be ErrTicketNotFound, got %v", err)
	}
}

// TestAuthCodeStore_Consume_DoubleConsume 验证 A1（核心）：第二次 Consume
// 返 ErrTicketNotFound（一次性语义）。
func TestAuthCodeStore_Consume_DoubleConsume(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	code, err := s.Issue(ctx, &Ticket{UserID: "u-1", DealNames: []string{"d-1"}})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if _, err := s.Consume(ctx, code); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	_, err = s.Consume(ctx, code)
	if !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("second consume should return ErrTicketNotFound, got %v", err)
	}
}

// TestAuthCodeStore_TTLExpired 验证 A4：TTL 自然过期后再 Consume 返
// ErrTicketNotFound（用 miniredis FastForward 模拟时间流逝）。
func TestAuthCodeStore_TTLExpired(t *testing.T) {
	s, mr := newTestStore(t, 600*time.Second)
	ctx := context.Background()

	code, err := s.Issue(ctx, &Ticket{UserID: "u-1", DealNames: []string{"d-1"}})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// 11 分钟后再消费
	mr.FastForward(11 * time.Minute)

	_, err = s.Consume(ctx, code)
	if !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("expired consume should return ErrTicketNotFound, got %v", err)
	}
}

// TestAuthCodeStore_TTLNotExpired 反向验证 A4：未到 TTL 仍可消费成功。
func TestAuthCodeStore_TTLNotExpired(t *testing.T) {
	s, mr := newTestStore(t, 600*time.Second)
	ctx := context.Background()

	code, err := s.Issue(ctx, &Ticket{UserID: "u-1", DealNames: []string{"d-1"}})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// 9 分钟后仍在窗口内
	mr.FastForward(9 * time.Minute)

	if _, err := s.Consume(ctx, code); err != nil {
		t.Fatalf("within-ttl consume failed: %v", err)
	}
}

// TestAuthCodeStore_Revoke 验证 Revoke 后 Consume 返 ErrTicketNotFound。
func TestAuthCodeStore_Revoke(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	ctx := context.Background()

	code, err := s.Issue(ctx, &Ticket{UserID: "u-1", DealNames: []string{"d-1"}})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if err := s.Revoke(ctx, code); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	_, err = s.Consume(ctx, code)
	if !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("after revoke consume should return ErrTicketNotFound, got %v", err)
	}
}

// TestAuthCodeStore_Revoke_EmptyCode 验证 Revoke 空字符串是 noop（不报错）。
func TestAuthCodeStore_Revoke_EmptyCode(t *testing.T) {
	s, _ := newTestStore(t, DefaultTTL)
	if err := s.Revoke(context.Background(), ""); err != nil {
		t.Fatalf("Revoke empty should be noop, got %v", err)
	}
}

// TestNew_DefaultTTL 验证 New(client, 0) 走 DefaultTTL 兜底。
func TestNew_DefaultTTL(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(func() { mr.Close() })

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	s := New(client, 0).(*store)
	if s.ttl != DefaultTTL {
		t.Fatalf("ttl: got %v want %v", s.ttl, DefaultTTL)
	}
}

// TestInit_DefaultStoreInjection 验证 Init 注入全局 DefaultStore；
// 测试结束清理避免污染其它测试用例。
func TestInit_DefaultStoreInjection(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(func() { mr.Close() })

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	prev := DefaultStore
	t.Cleanup(func() { DefaultStore = prev })

	Init(client, 60*time.Second)
	if DefaultStore == nil {
		t.Fatalf("DefaultStore should be initialized")
	}

	code, err := DefaultStore.Issue(context.Background(),
		&Ticket{UserID: "u-1", DealNames: []string{"d-1"}})
	if err != nil {
		t.Fatalf("Issue via DefaultStore: %v", err)
	}
	if code == "" {
		t.Fatalf("empty code")
	}
}
