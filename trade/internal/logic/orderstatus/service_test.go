package orderstatus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ============================================================================
// 测试替身：fakeOrderStore / fakeOrderWriter / fakeJifei
// ============================================================================

type fakeOrderStore struct {
	getOrderFn func(ctx context.Context, dealName string) (*store.TradeOrder, error)
	getCalls   atomic.Int32
}

func (f *fakeOrderStore) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	f.getCalls.Add(1)
	if f.getOrderFn != nil {
		return f.getOrderFn(ctx, dealName)
	}
	return nil, store.ErrTradeOrderNotFound
}

type fakeOrderWriter struct {
	createOrderFn         func(ctx context.Context, in store.CreateOrderInput) error
	markProvisionedFn     func(ctx context.Context, dealName, resourceID string) error
	updatePayURLFn        func(ctx context.Context, dealName, payURL string) error
	markCancelledFn       func(ctx context.Context, dealName string) error
	markCancelledCalls    atomic.Int32
	markCancelledLastDeal string
}

func (f *fakeOrderWriter) CreateOrder(ctx context.Context, in store.CreateOrderInput) error {
	if f.createOrderFn != nil {
		return f.createOrderFn(ctx, in)
	}
	return nil
}

func (f *fakeOrderWriter) MarkOrderProvisioned(ctx context.Context, dealName, resourceID string) error {
	if f.markProvisionedFn != nil {
		return f.markProvisionedFn(ctx, dealName, resourceID)
	}
	return nil
}

func (f *fakeOrderWriter) UpdatePayURL(ctx context.Context, dealName, payURL string) error {
	if f.updatePayURLFn != nil {
		return f.updatePayURLFn(ctx, dealName, payURL)
	}
	return nil
}

func (f *fakeOrderWriter) MarkOrderCancelled(ctx context.Context, dealName string) error {
	f.markCancelledCalls.Add(1)
	f.markCancelledLastDeal = dealName
	if f.markCancelledFn != nil {
		return f.markCancelledFn(ctx, dealName)
	}
	return nil
}

type fakeJifei struct {
	getDealsByKeyIndexFn    func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error)
	getDealsByKeyIndexCalls atomic.Int32
	lastDealName            string
}

func (f *fakeJifei) GetPrice(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	return nil, errors.New("fakeJifei: GetPrice not used")
}

func (f *fakeJifei) GenerateDeals(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	return nil, errors.New("fakeJifei: GenerateDeals not used")
}

func (f *fakeJifei) GenerateDealsAndPay(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	return nil, errors.New("fakeJifei: GenerateDealsAndPay not used")
}

func (f *fakeJifei) GetMidasEarmarking(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	return nil, errors.New("fakeJifei: GetMidasEarmarking not used")
}

func (f *fakeJifei) ModifyResourceStatus(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	return nil, errors.New("fakeJifei: ModifyResourceStatus not used")
}

func (f *fakeJifei) GetDealsByKeyIndex(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	f.getDealsByKeyIndexCalls.Add(1)
	if req != nil {
		f.lastDealName = req.Cond.DealName
	}
	if f.getDealsByKeyIndexFn != nil {
		return f.getDealsByKeyIndexFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GetDealsByKeyIndexFn not configured")
}

// ============================================================================
// 测试 helper
// ============================================================================

func newTestService(t *testing.T, store *fakeOrderStore, writer *fakeOrderWriter, jifei *fakeJifei) *Service {
	t.Helper()
	return New(Deps{
		OrderStore:  store,
		OrderWriter: writer,
		JifeiClient: jifei,
	})
}

// fixedTradeOrder 构造一条标准 trade_order 流水（创建态新购订单），便于复用。
func fixedTradeOrder(dealName, userID, status string) *store.TradeOrder {
	return &store.TradeOrder{
		ID:             1,
		BigOrderID:     "BIG-" + dealName,
		DealName:       dealName,
		ExternalUserID: userID,
		Uin:            "700000164995",
		AppID:          "251202221",
		SubProductCode: "sp_pass_subscription",
		BundleID:       "bundle-test",
		OrderType:      store.OrderTypeCreate,
		Status:         status,
		ResourceType:   "pass",
		CreatedTime:    time.Now(),
		UpdatedTime:    time.Now(),
	}
}

// ============================================================================
// T1: B1 本地终态短路 — provisioned
// ============================================================================

func TestQueryStatus_LocalTerminal_Provisioned(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusProvisioned), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-1",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	// B1 短路：Status=success / Source=local
	if out.Status != StatusSuccess {
		t.Errorf("Status = %q, want %q", out.Status, StatusSuccess)
	}
	if out.Source != SourceLocal {
		t.Errorf("Source = %q, want %q", out.Source, SourceLocal)
	}
	// 关键：jifei 调用次数 = 0
	if got := jc.getDealsByKeyIndexCalls.Load(); got != 0 {
		t.Errorf("B1 short-circuit violated: jifei called %d times, want 0", got)
	}
	// 关键：MarkOrderCancelled 调用次数 = 0
	if got := ow.markCancelledCalls.Load(); got != 0 {
		t.Errorf("B1 short-circuit: MarkCancelled called %d times, want 0", got)
	}
	// LocalStatus 透传
	if out.LocalStatus != store.OrderStatusProvisioned {
		t.Errorf("LocalStatus = %q, want %q", out.LocalStatus, store.OrderStatusProvisioned)
	}
}

// ============================================================================
// T2: B1 本地终态短路 — cancelled（B6 不可逆兜底）
// ============================================================================

func TestQueryStatus_LocalTerminal_Cancelled(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusCancelled), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-2",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.Status != StatusCancelled {
		t.Errorf("Status = %q, want %q", out.Status, StatusCancelled)
	}
	if out.Source != SourceLocal {
		t.Errorf("Source = %q, want %q", out.Source, SourceLocal)
	}
	if got := jc.getDealsByKeyIndexCalls.Load(); got != 0 {
		t.Errorf("B6 不可逆: jifei 不应被调（已是终态），got %d", got)
	}
}

// ============================================================================
// T3: B2 jifei=canceled → MarkOrderCancelled 推进本地
// ============================================================================

func TestQueryStatus_JifeiCanceled_MarkCancelled(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return &jifeiclient.GetDealsByKeyIndexResponse{
				TotalNum: 1,
				Deals: []jifeiclient.DealQueryItem{
					dealItemWithStatus(t, req.Cond.DealName, jifeiclient.JifeiDealStatusCanceled),
				},
			}, nil
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-3",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	// B2: Status=cancelled / Source=jifei
	if out.Status != StatusCancelled {
		t.Errorf("Status = %q, want %q", out.Status, StatusCancelled)
	}
	if out.Source != SourceJifei {
		t.Errorf("Source = %q, want %q", out.Source, SourceJifei)
	}
	// B2: MarkOrderCancelled 被调 1 次
	if got := ow.markCancelledCalls.Load(); got != 1 {
		t.Errorf("B2 violated: MarkCancelled called %d times, want 1", got)
	}
	if ow.markCancelledLastDeal != "deal-3" {
		t.Errorf("MarkCancelled last dealName = %q, want %q", ow.markCancelledLastDeal, "deal-3")
	}
}

// ============================================================================
// T4: B3 jifei=finished → 不更新本地（callback 链路兜底）
// ============================================================================

func TestQueryStatus_JifeiFinished_NoUpdate(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPaidPendingProvision), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return &jifeiclient.GetDealsByKeyIndexResponse{
				TotalNum: 1,
				Deals: []jifeiclient.DealQueryItem{
					dealItemWithStatus(t, req.Cond.DealName, jifeiclient.JifeiDealStatusFinished),
				},
			}, nil
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-4",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.Status != StatusSuccess {
		t.Errorf("Status = %q, want %q", out.Status, StatusSuccess)
	}
	if out.Source != SourceJifei {
		t.Errorf("Source = %q, want %q", out.Source, SourceJifei)
	}
	// B3: MarkOrderCancelled / 任何 OrderWriter 都不应被调
	if got := ow.markCancelledCalls.Load(); got != 0 {
		t.Errorf("B3 violated: MarkCancelled called %d times, want 0 (callback chain handles terminal)", got)
	}
}

// ============================================================================
// T5: B2 jifei=overdue → 也归 cancelled（Q-OS-2 拍板）
// ============================================================================

func TestQueryStatus_JifeiOverdue_MarkCancelled(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return &jifeiclient.GetDealsByKeyIndexResponse{
				TotalNum: 1,
				Deals: []jifeiclient.DealQueryItem{
					dealItemWithStatus(t, req.Cond.DealName, jifeiclient.JifeiDealStatusOverdue),
				},
			}, nil
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-5",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.Status != StatusCancelled {
		t.Errorf("Status = %q, want %q (overdue maps to cancelled per Q-OS-2)", out.Status, StatusCancelled)
	}
	if got := ow.markCancelledCalls.Load(); got != 1 {
		t.Errorf("B2: overdue should trigger MarkCancelled once, got %d", got)
	}
}

// ============================================================================
// T6: B7 jifei 不可达降级 — 返本地状态 + UpstreamErr，不返 error
// ============================================================================

func TestQueryStatus_JifeiUnreachable_FallbackLocal(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jifeiErr := errors.New("connection refused")
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return nil, jifeiErr
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-6",
		ExternalUserID: "u1",
	})
	// B7: 不返 error，返本地状态
	if err != nil {
		t.Fatalf("B7 violated: jifei error should be swallowed, got err: %v", err)
	}

	if out.Status != StatusPending {
		t.Errorf("Status = %q, want %q (local pending_pay maps to pending)", out.Status, StatusPending)
	}
	if out.Source != SourceLocal {
		t.Errorf("Source = %q, want %q (B7 fallback)", out.Source, SourceLocal)
	}
	if !strings.Contains(out.UpstreamErr, "connection refused") {
		t.Errorf("UpstreamErr = %q, want contain 'connection refused'", out.UpstreamErr)
	}
}

// ============================================================================
// T7: B5 续费订单识别（OrderType='renew'）
// ============================================================================

func TestQueryStatus_OrderTypeRenew(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			o := fixedTradeOrder(dealName, "u1", store.OrderStatusProvisioned)
			o.OrderType = store.OrderTypeRenew // 改为续费
			o.ResourceID = "pass-existing"
			return o, nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-7",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.OrderType != store.OrderTypeRenew {
		t.Errorf("OrderType = %q, want %q (B5 透传)", out.OrderType, store.OrderTypeRenew)
	}
	if out.Status != StatusSuccess {
		t.Errorf("Status = %q, want %q", out.Status, StatusSuccess)
	}
}

// ============================================================================
// 加测：B4 越权校验（external_user_id 不匹配）
// ============================================================================

func TestQueryStatus_PermissionDenied(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "owner-user", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	_, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-x",
		ExternalUserID: "attacker-user", // 不匹配
	})
	if err == nil {
		t.Fatalf("expected ErrPermissionDenied, got nil")
	}
	if !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("err is not ErrPermissionDenied: %v", err)
	}
	// 关键：jifei 不应被调
	if got := jc.getDealsByKeyIndexCalls.Load(); got != 0 {
		t.Errorf("B4 violated: jifei called %d times on permission denied", got)
	}
}

// ============================================================================
// 加测：trade_order 不存在 → ErrOrderNotFound
// ============================================================================

func TestQueryStatus_OrderNotFound(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return nil, store.ErrTradeOrderNotFound
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	_, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "non-existent",
		ExternalUserID: "u1",
	})
	if err == nil {
		t.Fatalf("expected ErrOrderNotFound, got nil")
	}
	if !errors.Is(err, ErrOrderNotFound) {
		t.Fatalf("err is not ErrOrderNotFound: %v", err)
	}
}

// ============================================================================
// 加测：入参校验
// ============================================================================

func TestQueryStatus_InvalidInput(t *testing.T) {
	os := &fakeOrderStore{}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}
	s := newTestService(t, os, ow, jc)

	cases := []struct {
		name string
		in   QueryStatusInput
	}{
		{"empty-deal-name", QueryStatusInput{DealName: "", ExternalUserID: "u1"}},
		{"empty-user-id", QueryStatusInput{DealName: "d", ExternalUserID: ""}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.QueryStatus(context.Background(), c.in)
			if err == nil {
				t.Fatalf("expected ErrInvalidInput, got nil")
			}
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("err is not ErrInvalidInput: %v", err)
			}
		})
	}
	// OrderStore 不应被调（入参在最早期被拦截）
	if got := os.getCalls.Load(); got != 0 {
		t.Errorf("OrderStore should not be called on invalid input, got %d", got)
	}
}

// ============================================================================
// 加测：SkipJifei 退化为本地状态（运维 / 测试场景）
// ============================================================================

func TestQueryStatus_SkipJifei(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-skip",
		ExternalUserID: "u1",
		SkipJifei:      true,
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.Status != StatusPending {
		t.Errorf("Status = %q, want %q (pending_pay maps to pending)", out.Status, StatusPending)
	}
	if out.Source != SourceLocal {
		t.Errorf("Source = %q, want %q (SkipJifei)", out.Source, SourceLocal)
	}
	if got := jc.getDealsByKeyIndexCalls.Load(); got != 0 {
		t.Errorf("SkipJifei violated: jifei called %d times, want 0", got)
	}
}

// ============================================================================
// 加测：jifei 返 totalNum=0 → 按 cancelled 兜底（极端场景）
// ============================================================================

func TestQueryStatus_JifeiEmptyResp_TreatAsCancelled(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{}
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return &jifeiclient.GetDealsByKeyIndexResponse{TotalNum: 0, Deals: nil}, nil
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-empty",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("QueryStatus: %v", err)
	}

	if out.Status != StatusCancelled {
		t.Errorf("Status = %q, want %q (empty deals maps to cancelled)", out.Status, StatusCancelled)
	}
	if got := ow.markCancelledCalls.Load(); got != 1 {
		t.Errorf("empty deals: MarkCancelled called %d times, want 1", got)
	}
}

// ============================================================================
// 加测：MarkOrderCancelled 失败不影响响应（best-effort 语义）
// ============================================================================

func TestQueryStatus_MarkCancelledFailure_SwallowedAsBestEffort(t *testing.T) {
	os := &fakeOrderStore{
		getOrderFn: func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
			return fixedTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
		},
	}
	ow := &fakeOrderWriter{
		markCancelledFn: func(ctx context.Context, dealName string) error {
			return errors.New("simulated DB error")
		},
	}
	jc := &fakeJifei{
		getDealsByKeyIndexFn: func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
			return &jifeiclient.GetDealsByKeyIndexResponse{
				TotalNum: 1,
				Deals: []jifeiclient.DealQueryItem{
					dealItemWithStatus(t, req.Cond.DealName, jifeiclient.JifeiDealStatusCanceled),
				},
			}, nil
		},
	}

	s := newTestService(t, os, ow, jc)
	out, err := s.QueryStatus(context.Background(), QueryStatusInput{
		DealName:       "deal-best-effort",
		ExternalUserID: "u1",
	})
	if err != nil {
		t.Fatalf("best-effort: MarkCancelled error should not fail QueryStatus, got: %v", err)
	}
	// 用户视角 status 仍正确返 cancelled
	if out.Status != StatusCancelled {
		t.Errorf("Status = %q, want %q", out.Status, StatusCancelled)
	}
}

// ============================================================================
// 加测：New 构造器 nil 依赖 panic
// ============================================================================

func TestNew_PanicOnNilDeps(t *testing.T) {
	cases := []struct {
		name string
		deps Deps
	}{
		{"nil-OrderStore", Deps{OrderStore: nil, OrderWriter: &fakeOrderWriter{}, JifeiClient: &fakeJifei{}}},
		{"nil-OrderWriter", Deps{OrderStore: &fakeOrderStore{}, OrderWriter: nil, JifeiClient: &fakeJifei{}}},
		{"nil-JifeiClient", Deps{OrderStore: &fakeOrderStore{}, OrderWriter: &fakeOrderWriter{}, JifeiClient: nil}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected panic, got nil")
				}
			}()
			_ = New(c.deps)
		})
	}
}

// ============================================================================
// 加测：mapLocalStatus / mapJifeiStatus 表驱动
// ============================================================================

func TestMapLocalStatus(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{store.OrderStatusCreated, StatusPending},
		{store.OrderStatusPendingPay, StatusPending},
		{store.OrderStatusPaidPendingProvision, StatusPaid},
		{store.OrderStatusProvisioned, StatusSuccess},
		{store.OrderStatusCancelled, StatusCancelled},
		{store.OrderStatusPaymentFailed, StatusFailed},
		{store.OrderStatusProvisionFailed, StatusFailed},
		{"unknown", StatusPending}, // 兜底
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			if got := mapLocalStatus(c.in); got != c.want {
				t.Errorf("mapLocalStatus(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestMapJifeiStatus(t *testing.T) {
	cases := []struct {
		in   int
		want string
	}{
		{jifeiclient.JifeiDealStatusInit, StatusPending},
		{jifeiclient.JifeiDealStatusPaying, StatusPending},
		{jifeiclient.JifeiDealStatusProcessing, StatusPaid},
		{jifeiclient.JifeiDealStatusDelivered, StatusPaid},
		{jifeiclient.JifeiDealStatusFinished, StatusSuccess},
		{jifeiclient.JifeiDealStatusCanceled, StatusCancelled},
		{jifeiclient.JifeiDealStatusOverdue, StatusCancelled},
		{jifeiclient.JifeiDealStatusDelete, StatusCancelled},
		{7, StatusPending},  // jifei 内部未公开中间态 → 兜底 pending
		{0, StatusPending},  // flexInt null/empty 解析为 0 → 兜底 pending
		{99, StatusPending}, // 未知 → 兜底 pending
	}
	for _, c := range cases {
		got := mapJifeiStatus(c.in)
		if got != c.want {
			t.Errorf("mapJifeiStatus(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ============================================================================
// 测试 helper：statusFromInt 返回一个 Status 字段已设为 n 的 DealQueryItem。
// flexInt 是 jifeiclient 包内 unexported 类型，跨包不可直接构造；这里走 JSON 反序列化路径
// 让 flexInt.UnmarshalJSON 自动赋值。
// ============================================================================

func dealItemWithStatus(t *testing.T, dealName string, statusInt int) jifeiclient.DealQueryItem {
	t.Helper()
	raw := []byte(fmt.Sprintf(`{"dealName":%q,"bigDealId":%q,"status":%d}`, dealName, "BIG-"+dealName, statusInt))
	var item jifeiclient.DealQueryItem
	if err := json.Unmarshal(raw, &item); err != nil {
		t.Fatalf("unmarshal DealQueryItem: %v", err)
	}
	return item
}
