// Package testutil ...
package testutil

import (
	"testing"
	"time"

	pctx "ctl/pkg/context"
	modelfactory "ctl/pkg/model/factory"
	modelpass "ctl/pkg/model/pass"
)

// SeedActivePass 为指定 ctx.UserID 写入一行 status=active 的 pass，
// 用于满足 CreateInstance 入口对 active pass 的强校验
// （bundle/design.md §5.1 2026-06-08 更新）。
//
// 同一 ctx 调用多次会因 uk_pass_id 唯一约束 fail；建议每个 test 内部仅调一次。
func SeedActivePass(t *testing.T, ctx pctx.Context) {
	t.Helper()
	dao := modelfactory.DefaultDaoFactory.PassDao(ctx)
	if err := dao.DB().Create(&modelpass.Entity{
		PassID:      "p-test-" + ctx.GetUserID(),
		UserID:      ctx.GetUserID(),
		BundleID:    "b-test-bundle",
		Uin:         700000164995,
		AppID:       251202221,
		ExpiredTime: time.Now().UTC().Add(30 * 24 * time.Hour),
		RenewFlag:   modelpass.RenewFlagManual,
		Status:      modelpass.StatusActive,
	}).Error; err != nil {
		t.Fatalf("seed active pass: %v", err)
	}
}
