package pass

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
)

// TestRefundPassParamValidation 覆盖 RefundPass 入口参数校验的纯路径（不打 DB 桩）。
//
// 与 delete_test.go::TestDeletePassParamValidation 同款范式：仅覆盖 short-circuit
// 在 GetByPassID 之前就返错的 case；其它分支（试用 pass / status / expired_time /
// trade 调用）留集成测试覆盖（sandbox-bj-7 测试集群有真实 DB + trade）。
//
// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3 + §11 拍板项
//
// 关键不变量：
//   - passID 缺失（空 / 全空白）→ 返 ErrPassInvalidParam（短路在 strings.TrimSpace 后）
//   - 不打 DAO / trade adapter 桩，避免触发 modelfactory.DefaultDaoFactory.PassDao(nil) 真连 DB
func TestRefundPassParamValidation(t *testing.T) {
	l := &logic{}
	cases := []struct {
		name        string
		passID      string
		operatorUin int64
		reason      string
		wantErrs    []error
	}{
		{name: "empty_pass_id", passID: "", operatorUin: 100012345678, reason: "test", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "whitespace_pass_id", passID: "   ", operatorUin: 100012345678, reason: "test", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "tab_pass_id", passID: " \t ", operatorUin: 100012345678, reason: "test", wantErrs: []error{errcode.ErrPassInvalidParam}},
		// reason / operatorUin 允许为零值（Q4=a 拍板：仅日志透传，不影响校验）
		{name: "empty_pass_id_with_zero_uin", passID: "", operatorUin: 0, reason: "", wantErrs: []error{errcode.ErrPassInvalidParam}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result, err := l.RefundPass(c.passID, c.operatorUin, c.reason)
			if err == nil {
				t.Fatalf("RefundPass(%q, %d, %q) expected non-nil err",
					c.passID, c.operatorUin, c.reason)
			}
			if result != nil {
				t.Errorf("RefundPass should return nil result on error; got %+v", result)
			}
			for _, want := range c.wantErrs {
				if !errors.Is(err, want) {
					t.Fatalf("RefundPass(%q, %d, %q) = %v, want errors.Is %v",
						c.passID, c.operatorUin, c.reason, err, want)
				}
			}
		})
	}
}

// TestRefundResult_Fields 验证 RefundResult struct 字段对齐设计稿 §3.1（PassID / DealName /
// BigDealID / SubmittedAt），避免未来重构改名导致 transport 层序列化失效。
//
// 这是个纯类型守护测试，不打任何外部依赖；与 delete_test 的"轻测试"风格保持一致。
func TestRefundResult_Fields(t *testing.T) {
	// 编译期断言：RefundResult 必须有这 4 个字段且类型一致；任何字段重命名或类型变更会让本测试失败。
	r := RefundResult{
		PassID:    "lhpass-test",
		DealName:  "deal-refund-001",
		BigDealID: "big-deal-refund-001",
	}
	if r.PassID == "" || r.DealName == "" || r.BigDealID == "" {
		t.Fatal("RefundResult fields PassID/DealName/BigDealID must be settable strings")
	}
	// SubmittedAt 是 time.Time，零值合法；本测试仅守护字段存在性。
	_ = r.SubmittedAt
}
