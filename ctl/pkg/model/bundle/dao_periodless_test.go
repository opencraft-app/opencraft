package bundle_test

import (
	"testing"

	"ctl/pkg/model/bundle"
	"ctl/test/testutil"
)

func TestUpsertDoesNotClearLegacyPlanVariants(t *testing.T) {
	testutil.NewSQLiteDB(t, &bundle.Entity{})
	dao := bundle.NewDao()
	const legacy = `[{"plan_id":"legacy-14d"}]`

	if err := dao.Upsert(&bundle.Entity{
		BundleID: "bundle-1", BundleName: "old", BotQuotaPerAgent: 5, AiGatewayPlans: legacy,
	}); err != nil {
		t.Fatal(err)
	}
	if err := dao.Upsert(&bundle.Entity{
		BundleID: "bundle-1", BundleName: "new", BotQuotaPerAgent: 10,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := dao.GetByBundleID("bundle-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.AiGatewayPlans != legacy {
		t.Fatalf("legacy variants were cleared: got=%q want=%q", got.AiGatewayPlans, legacy)
	}
	if got.BotQuotaPerAgent != 10 {
		t.Fatalf("BotQuotaPerAgent = %d, want 10", got.BotQuotaPerAgent)
	}
}
