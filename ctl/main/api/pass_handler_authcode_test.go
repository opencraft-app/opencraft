// Package main 单测：v1.7.32 双模式鉴权 helper resolveOrderUrlAuth + sameDealNames
// 覆盖设计稿 .tmp/ctl-authcode-codebuddy-design.md §7 单测矩阵 T6 ~ T10
//
// 不变量覆盖：
//   - A1 一次性消费（间接：通过 mock store 的 Consume 错验证）
//   - A2 deal_names 强绑定校验（403 AUTH_CODE_MISMATCH）
//   - A3 pass_id 强绑定校验（403 AUTH_CODE_MISMATCH）
//   - A5 双模式排他（X-User-Id 优先；缺则 auth_code；都缺 401）
package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/authcode"
	"ctl/pkg/errcode"
)

// fakeAuthCodeStore 是 authcode.Store 的测试 stub；仅暴露需要的字段。
type fakeAuthCodeStore struct {
	consumeRet   *authcode.Ticket
	consumeErr   error
	consumeCalls int
	consumedCode string
	revokeCalls  int
}

func (f *fakeAuthCodeStore) Issue(ctx context.Context, t *authcode.Ticket) (string, error) {
	return "", errors.New("Issue not used in handler tests")
}

func (f *fakeAuthCodeStore) Consume(ctx context.Context, code string) (*authcode.Ticket, error) {
	f.consumeCalls++
	f.consumedCode = code
	if f.consumeErr != nil {
		return nil, f.consumeErr
	}
	return f.consumeRet, nil
}

func (f *fakeAuthCodeStore) Revoke(ctx context.Context, code string) error {
	f.revokeCalls++
	return nil
}

// withAuthCodeStore 临时替换全局 DefaultStore，t.Cleanup 自动恢复。
func withAuthCodeStore(t *testing.T, s authcode.Store) {
	t.Helper()
	prev := authcode.DefaultStore
	authcode.DefaultStore = s
	t.Cleanup(func() { authcode.DefaultStore = prev })
}

// makeRequestWithUserID 构造带 X-User-Id 的空 POST 请求（body 不重要，仅鉴权层）。
func makeRequestWithUserID(userID string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/passes/order-url", http.NoBody)
	if userID != "" {
		r.Header.Set("X-User-Id", userID)
	}
	return r
}

// === T6: Bearer 优先（A5）===

// TestResolveOrderUrlAuth_BearerPath_Bypass 验证 X-User-Id 存在时不进 ticket
// 路径，userID 直接来自 header；store.Consume 不被调用（避免误烧 ticket）。
func TestResolveOrderUrlAuth_BearerPath_Bypass(t *testing.T) {
	store := &fakeAuthCodeStore{}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("u-1")
	got, err := resolveOrderUrlAuth(r, "any-auth-code", []string{"deal-1"}, "")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "u-1" {
		t.Errorf("userID: got %q want u-1", got)
	}
	if store.consumeCalls != 0 {
		t.Errorf("Consume should NOT be called when X-User-Id present, got %d", store.consumeCalls)
	}
}

// === T7: auth_code 路径成功（A5）===

// TestResolveOrderUrlAuth_AuthCodePath_Success 验证缺 X-User-Id 但带 auth_code
// 时走 ticket 反查；userID = ticket.UserID。
func TestResolveOrderUrlAuth_AuthCodePath_Success(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeRet: &authcode.Ticket{
			UserID:    "u-from-ticket",
			DealNames: []string{"deal-1"},
		},
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	got, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-1"}, "")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "u-from-ticket" {
		t.Errorf("userID: got %q want u-from-ticket", got)
	}
	if store.consumeCalls != 1 {
		t.Errorf("Consume should be called exactly once, got %d", store.consumeCalls)
	}
	if store.consumedCode != "code-1" {
		t.Errorf("consumed code: got %q want code-1", store.consumedCode)
	}
}

// === T8: deal_names 不匹配（A2）===

// TestResolveOrderUrlAuth_DealNamesMismatch 验证 ticket.deal_names ≠ req.deal_names
// 时返 ErrAuthCodeMismatch（403）。
func TestResolveOrderUrlAuth_DealNamesMismatch(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeRet: &authcode.Ticket{
			UserID:    "u-1",
			DealNames: []string{"deal-A"},
		},
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-B"}, "")
	if !errors.Is(err, errcode.ErrAuthCodeMismatch) {
		t.Fatalf("err: got %v want ErrAuthCodeMismatch", err)
	}
}

// === T8b: deal_names 长度不匹配（A2 边界）===
func TestResolveOrderUrlAuth_DealNamesLenMismatch(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeRet: &authcode.Ticket{
			UserID:    "u-1",
			DealNames: []string{"deal-A", "deal-B"},
		},
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-A"}, "")
	if !errors.Is(err, errcode.ErrAuthCodeMismatch) {
		t.Fatalf("err: got %v want ErrAuthCodeMismatch", err)
	}
}

// === T9: 双缺失（A5）===

// TestResolveOrderUrlAuth_BothMissing 验证既无 X-User-Id 也无 auth_code 返 401。
func TestResolveOrderUrlAuth_BothMissing(t *testing.T) {
	store := &fakeAuthCodeStore{}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "", []string{"deal-1"}, "")
	if !errors.Is(err, errcode.ErrUnauthorized) {
		t.Fatalf("err: got %v want ErrUnauthorized", err)
	}
	if store.consumeCalls != 0 {
		t.Errorf("Consume should NOT be called when authCode is empty, got %d", store.consumeCalls)
	}
}

// === T9b: ticket not found（A1 一次性 / A4 过期映射）===

// TestResolveOrderUrlAuth_TicketNotFound 验证 store.Consume 返 ErrTicketNotFound
// 时映射为 ErrAuthCodeInvalid（HTTP 401）。
func TestResolveOrderUrlAuth_TicketNotFound(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeErr: authcode.ErrTicketNotFound,
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "fake", []string{"deal-1"}, "")
	if !errors.Is(err, errcode.ErrAuthCodeInvalid) {
		t.Fatalf("err: got %v want ErrAuthCodeInvalid", err)
	}
}

// === T10: 续费场景 pass_id 强绑定（A3）===

// TestResolveOrderUrlAuth_PassIDMismatch 验证续费场景 ticket.PassID 与 path 上
// 的 pass_id 不一致时返 ErrAuthCodeMismatch。
func TestResolveOrderUrlAuth_PassIDMismatch(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeRet: &authcode.Ticket{
			UserID:    "u-1",
			DealNames: []string{"deal-1"},
			PassID:    "pass-A",
		},
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-1"}, "pass-B")
	if !errors.Is(err, errcode.ErrAuthCodeMismatch) {
		t.Fatalf("err: got %v want ErrAuthCodeMismatch", err)
	}
}

// === T10b: 续费场景 pass_id 一致 ===
func TestResolveOrderUrlAuth_PassIDMatch(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeRet: &authcode.Ticket{
			UserID:    "u-1",
			DealNames: []string{"deal-1"},
			PassID:    "pass-A",
		},
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	got, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-1"}, "pass-A")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "u-1" {
		t.Errorf("userID: got %q want u-1", got)
	}
}

// === DefaultStore=nil 兜底 ===

// TestResolveOrderUrlAuth_DefaultStoreNil 验证启动期未注入 DefaultStore 时
// auth_code 路径降级为 401（不 panic）。
func TestResolveOrderUrlAuth_DefaultStoreNil(t *testing.T) {
	prev := authcode.DefaultStore
	authcode.DefaultStore = nil
	t.Cleanup(func() { authcode.DefaultStore = prev })

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-1"}, "")
	if !errors.Is(err, errcode.ErrUnauthorized) {
		t.Fatalf("err: got %v want ErrUnauthorized", err)
	}
}

// === store internal err（5xx 透传）===

// TestResolveOrderUrlAuth_StoreInternalErr 验证 Consume 返 Redis 网络错时
// 包装成 ErrInternalServer（HTTP 5xx）。
func TestResolveOrderUrlAuth_StoreInternalErr(t *testing.T) {
	store := &fakeAuthCodeStore{
		consumeErr: errors.New("simulated redis net err"),
	}
	withAuthCodeStore(t, store)

	r := makeRequestWithUserID("")
	_, err := resolveOrderUrlAuth(r, "code-1", []string{"deal-1"}, "")
	if !errors.Is(err, errcode.ErrInternalServer) {
		t.Fatalf("err: got %v want ErrInternalServer", err)
	}
}

// === sameDealNames helper ===

func TestSameDealNames(t *testing.T) {
	cases := []struct {
		name string
		a    []string
		b    []string
		want bool
	}{
		{"both empty", []string{}, []string{}, true},
		{"both nil", nil, nil, true},
		{"single equal", []string{"d-1"}, []string{"d-1"}, true},
		{"single diff", []string{"d-1"}, []string{"d-2"}, false},
		{"len mismatch", []string{"d-1"}, []string{"d-1", "d-2"}, false},
		{"order sensitive", []string{"d-1", "d-2"}, []string{"d-2", "d-1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameDealNames(tc.a, tc.b); got != tc.want {
				t.Errorf("sameDealNames(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
