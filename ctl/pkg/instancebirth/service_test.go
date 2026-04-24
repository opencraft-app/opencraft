package instancebirth

import (
	"testing"
	"time"

	pctx "ctl/pkg/context"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestRebuildForChinaDateAssignsStableBornNumbers(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := pctx.NewContext(nil)
	ctx.SetRequestId("birth-profile-test")

	entities := []modelinstance.Entity{
		{
			InstanceId: "ins-born-2",
			UserId:     "usr_b",
			SandboxId:  "sbx-2",
			Status:     modelinstance.InstanceStatusRunning,
			TimeoutAt:  time.Date(2026, 3, 29, 17, 1, 0, 0, time.UTC),
			CreatedAt:  time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC),
			UpdatedAt:  time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC),
		},
		{
			InstanceId: "ins-born-1",
			UserId:     "usr_a",
			SandboxId:  "sbx-1",
			Status:     modelinstance.InstanceStatusRunning,
			TimeoutAt:  time.Date(2026, 3, 29, 16, 59, 0, 0, time.UTC),
			CreatedAt:  time.Date(2026, 3, 29, 15, 59, 0, 0, time.UTC),
			UpdatedAt:  time.Date(2026, 3, 29, 15, 59, 0, 0, time.UTC),
		},
		{
			InstanceId: "ins-born-3",
			UserId:     "usr_c",
			SandboxId:  "sbx-3",
			Status:     modelinstance.InstanceStatusRunning,
			TimeoutAt:  time.Date(2026, 3, 29, 17, 1, 30, 0, time.UTC),
			CreatedAt:  time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC),
			UpdatedAt:  time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC),
		},
	}
	if err := resource.GormDB.Table(modelinstance.TableName).Create(&entities).Error; err != nil {
		t.Fatalf("seed instances: %v", err)
	}

	svc := NewService(modelfactory.DefaultDaoFactory.InstanceDao(ctx), modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx))
	for _, day := range []string{"2026-03-29", "2026-03-30"} {
		if err := svc.RebuildForChinaDate(ctx, day); err != nil {
			t.Fatalf("rebuild birth profiles for %s: %v", day, err)
		}
	}

	got1, err := modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx).GetByInstanceID(ctx, "ins-born-1")
	if err != nil {
		t.Fatalf("get ins-born-1 profile: %v", err)
	}
	if got1.BornDateForChina != "2026-03-29" || got1.BornNumberForChina != 1 {
		t.Fatalf("unexpected ins-born-1 profile: %+v", got1)
	}

	got2, err := modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx).GetByInstanceID(ctx, "ins-born-2")
	if err != nil {
		t.Fatalf("get ins-born-2 profile: %v", err)
	}
	if got2.BornDateForChina != "2026-03-30" || got2.BornNumberForChina != 1 {
		t.Fatalf("unexpected ins-born-2 profile: %+v", got2)
	}

	got3, err := modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx).GetByInstanceID(ctx, "ins-born-3")
	if err != nil {
		t.Fatalf("get ins-born-3 profile: %v", err)
	}
	if got3.BornDateForChina != "2026-03-30" || got3.BornNumberForChina != 2 {
		t.Fatalf("unexpected ins-born-3 profile: %+v", got3)
	}
}
