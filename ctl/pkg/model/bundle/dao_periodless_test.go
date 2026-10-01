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
		BundleID: "bundle-1", BundleName: "old", AiGatewayPlans: legacy,
	}); err != nil {
		t.Fatal(err)
	}
	if err := dao.Upsert(&bundle.Entity{
		BundleID: "bundle-1", BundleName: "new",
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
}

// SQLite's JSON column affinity does not reject empty strings like MySQL does.
// Enforce that boundary explicitly so a fresh-catalog import cannot pass falsely.
func TestUpsertEmptyOptionalJSONIsValidAndPreservesExistingQuota(t *testing.T) {
	db := testutil.NewSQLiteDB(t, &bundle.Entity{})
	if err := db.Exec(`CREATE TRIGGER bundle_json_insert BEFORE INSERT ON bundle
 BEGIN
 SELECT CASE WHEN NEW.features = '' OR NEW.promotion = '' OR NEW.ai_gateway_plans = '' OR NEW.static_site_quota = ''
 THEN RAISE(ABORT, 'invalid empty JSON') END;
 END`).Error; err != nil {
		t.Fatal(err)
	}
	dao := bundle.NewDao()
	input := &bundle.Entity{BundleID: "bundle-new", BundleName: "new"}
	if err := dao.Upsert(input); err != nil {
		t.Fatal(err)
	}
	if input.Features != "" || input.Promotion != "" || input.AiGatewayPlans != "" || input.StaticSiteQuota != "" {
		t.Fatal("caller entity mutated")
	}
	got, err := dao.GetByBundleID(input.BundleID)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{got.Features, got.Promotion, got.AiGatewayPlans, got.StaticSiteQuota} {
		if value != "null" {
			t.Fatalf("empty JSON = %q, want null", value)
		}
	}
	const quota = `{"max_sites":1}`
	if err := dao.Upsert(&bundle.Entity{BundleID: "bundle-quota", StaticSiteQuota: quota, AiGatewayPlans: `[]`}); err != nil {
		t.Fatal(err)
	}
	if err := dao.Upsert(&bundle.Entity{BundleID: "bundle-quota", BundleName: "updated"}); err != nil {
		t.Fatal(err)
	}
	got, err = dao.GetByBundleID("bundle-quota")
	if err != nil {
		t.Fatal(err)
	}
	if got.StaticSiteQuota != quota || got.AiGatewayPlans != `[]` {
		t.Fatalf("existing quota/legacy plans changed: %q / %q", got.StaticSiteQuota, got.AiGatewayPlans)
	}
}
