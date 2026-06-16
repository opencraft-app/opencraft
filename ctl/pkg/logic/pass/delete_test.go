package pass

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
)

// TestDeletePassParamValidation 覆盖 DeletePass 入口参数校验的纯路径（不打 DB 桩）
//
// 仅覆盖 short-circuit 在 GetByPassID 之前就返错的 case — 这些 case 走纯字符串校验
// 路径，无需 mock dao；其余分支（status 预判 / CAS / trade 调用）留集成测试覆盖
// （sandbox-bj-7 测试集群有真实 DB + trade，无需在单测里 mock 整条链路）。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.5.1 错误语义表
func TestDeletePassParamValidation(t *testing.T) {
	l := &logic{}
	cases := []struct {
		name     string
		userID   string
		passID   string
		wantErrs []error
	}{
		{name: "empty_user_id", userID: "", passID: "lhpass-12345678", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "whitespace_user_id", userID: "   ", passID: "lhpass-12345678", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "empty_pass_id", userID: "user_123", passID: "", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "whitespace_pass_id", userID: "user_123", passID: "   ", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "both_empty", userID: "", passID: "", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "both_whitespace", userID: "   ", passID: " \t ", wantErrs: []error{errcode.ErrPassInvalidParam}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := l.DeletePass(c.userID, c.passID)
			if err == nil {
				t.Fatalf("DeletePass(%q, %q) expected non-nil err", c.userID, c.passID)
			}
			for _, want := range c.wantErrs {
				if !errors.Is(err, want) {
					t.Fatalf("DeletePass(%q, %q) = %v, want errors.Is %v",
						c.userID, c.passID, err, want)
				}
			}
		})
	}
}
