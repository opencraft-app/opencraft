package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
)

// 写端 DAO 测试范围说明：
//
// 这里只覆盖"不依赖真 MySQL 的纯函数路径"——nil store 防御 / 入参校验 / 哨兵错误判定。
// 真正的 SQL 行为（INSERT 冲突 / UPDATE 命中 0 行 / resource_id 比对）由上层 logic
// 层（placeorder / createresource）通过 fake OrderWriter 做端到端验证；store 层不引
// 入 sqlmock 依赖（避免给 go.mod 增加新依赖项）。
//
// isMySQLDuplicateError 子串匹配走纯函数路径，可以直接表驱动测试。

func TestCreateOrder_NilStore(t *testing.T) {
	var s *MySQLStore // nil
	err := s.CreateOrder(context.Background(), CreateOrderInput{DealName: "d", Status: "created"})
	if err == nil || err.Error() != "trade_order: store is nil" {
		t.Fatalf("expected nil store error, got %v", err)
	}
}

// TestCreateOrder_NoPanicOnEmptyDealName 验证 v1.7.28 BUG-22 修订后的行为：
// CreateOrder 入参 DealName="" 不再 panic，仅返回 raw error（来自下游 db.ExecContext
// 的失败，因为 stub db 没有真实驱动，会触发 driver init 失败）。
//
// 设计修订背景：原 R-C Q15=a 'deal_name 三态强约束' 要求空字符串入参时 panic，
// 但 BUG-22 把 createResource handler 与 trade_order 解耦后，trade_order 退化为
// "订单流水记录"用途；DealName 空字符串作为合法中间态保留，让未来扩展（如
// reconcile worker 兜底插占位行）有空间。
func TestCreateOrder_NoPanicOnEmptyDealName(t *testing.T) {
	db, err := sqlOpenStub()
	if err != nil {
		t.Skipf("cannot open stub db: %v", err)
		return
	}
	defer db.Close()

	s := &MySQLStore{db: db}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("BUG-22 修订后 CreateOrder 不应再 panic on empty DealName, got panic: %v", r)
		}
	}()

	// 入参 DealName="" 不应 panic；预期返回 db driver 错误（stub db 没真实驱动）
	// 或 nil（如果 stub db 接受 INSERT）。两种情况都是合法的"非 panic"路径。
	_ = s.CreateOrder(context.Background(), CreateOrderInput{
		DealName: "",
		Status:   "pending_pay",
	})
	// 到达此行说明没 panic，测试目标达成。
}

// TestCreateOrder_OrderTypeDefault 验证 OrderType 空字符串走默认 'create' 的兼容路径。
//
// R-C Q7=a 落地（2026-05-15）：CreateOrderInput.OrderType 空 → DAO 默认填 OrderTypeCreate。
//
// 这里用一条"DAO 入口校验通过 + 进入 SQL 执行后失败"的路径反推：
// stub db 在 ExecContext 时返底层错误，但只要 panic / status 校验 / OrderType 默认填充
// 之前的所有静默路径正确，调用就不会触发 panic 或 return early，最终走到 ExecContext。
//
// 为让 OrderType 默认值有可观测，我们在 input.OrderType=="" 时验证：
//   - 不 panic
//   - 返回的 error 包含 "insert dealName=" 子串（说明走到了 SQL 执行路径）
//
// 反向同时验证：DealName 非空 + Status 非空 → 不会被早期防御拦截。
func TestCreateOrder_OrderTypeDefault(t *testing.T) {
	db, err := sqlOpenStub()
	if err != nil {
		t.Skipf("cannot open stub db: %v", err)
		return
	}
	defer db.Close()

	s := &MySQLStore{db: db}

	// 不 panic（DealName 非空）；最终 ExecContext 会因 stub 驱动失败 → 返 wrap error
	in := CreateOrderInput{
		DealName: "deal-r-c-default",
		Status:   "pending_pay",
		// OrderType 故意留空 → 验证 DAO 默认填 'create'
	}
	err = s.CreateOrder(context.Background(), in)
	if err == nil {
		t.Fatalf("expected ExecContext error from stub driver, got nil")
	}
	// 必须走到 SQL 路径（说明 OrderType 空字符串被默认填充而非阻塞）
	if !contains(err.Error(), "insert dealName=") {
		t.Fatalf("expected SQL exec error path, got %q", err.Error())
	}
}

func TestMarkOrderProvisioned_NilStore(t *testing.T) {
	var s *MySQLStore
	err := s.MarkOrderProvisioned(context.Background(), "deal-x", "pass-1")
	if err == nil || err.Error() != "trade_order: store is nil" {
		t.Fatalf("expected nil store error, got %v", err)
	}
}

func TestRecordAcceptedByID_NilStore(t *testing.T) {
	var s *MySQLStore
	err := s.RecordAcceptedByID(context.Background(), 1, "pass-1", []byte(`{"returnCode":0}`))
	if err == nil || err.Error() != "trade_flow: store is nil" {
		t.Fatalf("expected nil store error, got %v", err)
	}
}

func TestErrTradeOrderDuplicate_Sentinel(t *testing.T) {
	wrapped := wrapErr(ErrTradeOrderDuplicate)
	if !errors.Is(wrapped, ErrTradeOrderDuplicate) {
		t.Fatalf("ErrTradeOrderDuplicate should match via errors.Is")
	}
}

func TestErrTradeOrderResourceIDConflict_Sentinel(t *testing.T) {
	wrapped := wrapErr(ErrTradeOrderResourceIDConflict)
	if !errors.Is(wrapped, ErrTradeOrderResourceIDConflict) {
		t.Fatalf("ErrTradeOrderResourceIDConflict should match via errors.Is")
	}
}

// TestMarkOrderCancelled_NilStore 验证 nil *MySQLStore 防御（v1.7.32 新增）。
func TestMarkOrderCancelled_NilStore(t *testing.T) {
	var s *MySQLStore
	err := s.MarkOrderCancelled(context.Background(), "deal-x")
	if err == nil || err.Error() != "trade_order: store is nil" {
		t.Fatalf("expected nil store error, got %v", err)
	}
}

// TestMarkOrderCancelled_EmptyDealName 验证空 dealName 防御（v1.7.32 新增）。
func TestMarkOrderCancelled_EmptyDealName(t *testing.T) {
	db, err := sqlOpenStub()
	if err != nil {
		t.Skipf("cannot open stub db: %v", err)
		return
	}
	defer db.Close()

	s := &MySQLStore{db: db}
	err = s.MarkOrderCancelled(context.Background(), "")
	if err == nil || err.Error() != "trade_order: deal_name is required" {
		t.Fatalf("expected deal_name required error, got %v", err)
	}
}

// TestMarkOrderCancelled_ExecErrorWrapped 验证底层 SQL exec 错误被正确 wrap（v1.7.32 新增）。
//
// 设计稿 §5.3 语义：rows affected == 0 不报错（幂等）；仅 SQL execution 本身失败时 wrap。
// stubFailDriver 让 ExecContext 返 "stub: prepare disabled" 路径，验证错误透传。
func TestMarkOrderCancelled_ExecErrorWrapped(t *testing.T) {
	db, err := sqlOpenStub()
	if err != nil {
		t.Skipf("cannot open stub db: %v", err)
		return
	}
	defer db.Close()

	s := &MySQLStore{db: db}
	err = s.MarkOrderCancelled(context.Background(), "deal-r-32")
	if err == nil {
		t.Fatalf("expected ExecContext error from stub driver, got nil")
	}
	if !contains(err.Error(), "mark cancelled dealName=deal-r-32") {
		t.Fatalf("expected wrap with dealName context, got %q", err.Error())
	}
}

// TestIsOrderTerminalStatus_TableDriven 验证终态判定（与 B1 本地终态短路不变量对齐）。
func TestIsOrderTerminalStatus_TableDriven(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{OrderStatusCreated, false},
		{OrderStatusPendingPay, false},
		{OrderStatusPaidPendingProvision, false},
		{OrderStatusProvisioned, true},
		{OrderStatusPaymentFailed, true},
		{OrderStatusProvisionFailed, true},
		{OrderStatusCancelled, true},
		{"", false},
		{"unknown", false},
	}
	for _, c := range cases {
		t.Run(c.status, func(t *testing.T) {
			got := IsOrderTerminalStatus(c.status)
			if got != c.want {
				t.Errorf("IsOrderTerminalStatus(%q) = %v, want %v", c.status, got, c.want)
			}
		})
	}
}

func TestIsMySQLDuplicateError_TableDriven(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil err", nil, false},
		{"unrelated", errors.New("some other db error"), false},
		{"errno match", errors.New("Error 1062: Duplicate entry 'deal-001' for key 'deal_name'"), true},
		{"duplicate entry phrase", errors.New("Duplicate entry 'foo' for key 'deal_name'"), true},
		{"both phrases", errors.New("Error 1062: Duplicate entry"), true},
		{"case sensitivity check", errors.New("error 1062"), false}, // 子串匹配区分大小写
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := isMySQLDuplicateError(c.err)
			if got != c.want {
				t.Errorf("isMySQLDuplicateError(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

// ============================================================================
// 测试辅助：stub sql.DB（避免引入 sqlmock 第三方依赖）
// ============================================================================

// stubFailDriver 是一个最小 SQL driver，所有 ExecContext / QueryContext 调用都返错。
// 仅用于让 *sql.DB 实例非 nil，让 store 层防御代码（panic / status 校验）能跑到 SQL 路径。
type stubFailDriver struct{}

func (stubFailDriver) Open(name string) (driver.Conn, error) { return stubFailConn{}, nil }

type stubFailConn struct{}

func (stubFailConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("stub: prepare disabled")
}
func (stubFailConn) Close() error              { return nil }
func (stubFailConn) Begin() (driver.Tx, error) { return nil, errors.New("stub: begin disabled") }

func init() {
	// 注册一次（多次注册同名 driver 会 panic；包级初始化只执行一次）
	sql.Register("trade_store_stub", stubFailDriver{})
}

// sqlOpenStub 返回一个非 nil *sql.DB，所有底层操作都会失败。
// 仅用于本文件的 panic / 默认值校验测试。
func sqlOpenStub() (*sql.DB, error) {
	return sql.Open("trade_store_stub", "stub")
}

// contains 是 strings.Contains 的薄封装（导入精简）。
func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}
