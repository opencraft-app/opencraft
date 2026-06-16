package pass

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
)

// TestDestroyPassParamValidation 覆盖 DestroyPass 入口参数校验的纯路径（不打 DB 桩）
//
// 仅覆盖 short-circuit 在 GetByPassID 之前就返错的 case — 这些 case 走纯字符串校验
// 路径，无需 mock dao；其余分支（status 预判 / CAS / 父 task 派发）留集成测试覆盖
// （sandbox-bj-7 测试集群有真实 DB + MQ，无需在单测里 mock 整条链路）。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.5.2 / §4.5.3 / §11-A Q1 错误语义表
func TestDestroyPassParamValidation(t *testing.T) {
	l := &logic{}
	cases := []struct {
		name          string
		passID        string
		tradeFlowID   int64
		destroyReason string
		wantErrs      []error
	}{
		{name: "empty_pass_id", passID: "", tradeFlowID: 0, destroyReason: "biz",
			wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "whitespace_pass_id", passID: "   ", tradeFlowID: 9001, destroyReason: "qn",
			wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "tab_only_pass_id", passID: "\t\t", tradeFlowID: 0, destroyReason: "",
			wantErrs: []error{errcode.ErrPassInvalidParam}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := l.DestroyPass(c.passID, c.tradeFlowID, c.destroyReason)
			if err == nil {
				t.Fatalf("DestroyPass(%q, %d, %q) expected non-nil err",
					c.passID, c.tradeFlowID, c.destroyReason)
			}
			for _, want := range c.wantErrs {
				if !errors.Is(err, want) {
					t.Fatalf("DestroyPass(%q, %d, %q) = %v, want errors.Is %v",
						c.passID, c.tradeFlowID, c.destroyReason, err, want)
				}
			}
		})
	}
}
