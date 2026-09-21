// 升配收尾后的新建实例规格。需求：TAPD 1010132091137784162 §6 / §10.1
//
// 变配本身不改建机链路：父 task 把 pass.bundle_id 切成目标套餐后，现有建机路径
// 通过 pass.bundle_id → bundle.instance_spec_id 自动拿到目标规格。这条链路是
// "升配完成后新建实例得到巡游 4C8G80G" 的**唯一**依据，所以它必须被钉住——
// 断了不会报错，只会让用户升配后开出来的机器还是 2C4G50G。
package instance

import (
	"context"
	"testing"

	pctx "ctl/pkg/context"
	bundlemodel "ctl/pkg/model/bundle"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

func TestResolveInstanceSpecIDFollowsPassBundleAfterModify(t *testing.T) {
	db := testutil.NewSQLiteDB(t, &bundlemodel.Entity{})
	seed := []bundlemodel.Entity{
		{BundleID: "bundle_launch_01", BundleState: "ONLINE", InstanceSpecID: "spec-2c4g50g"},
		{BundleID: "bundle_cruise_01", BundleState: "ONLINE", InstanceSpecID: "spec-4c8g80g"},
		{BundleID: "bundle_launch_ai_01", BundleState: "ONLINE", InstanceSpecID: "spec-2c4g50g"},
		{BundleID: "bundle_cruise_ai_01", BundleState: "ONLINE", InstanceSpecID: "spec-4c8g80g"},
	}
	for i := range seed {
		if err := db.Create(&seed[i]).Error; err != nil {
			t.Fatalf("seed bundle %s: %v", seed[i].BundleID, err)
		}
	}

	l := &logic{logger: zap.NewNop()}
	ctx := pctx.NewContext(context.Background())

	cases := []struct {
		passBundleID string
		wantSpec     string
	}{
		// 升配前
		{"bundle_launch_01", "spec-2c4g50g"},
		{"bundle_launch_ai_01", "spec-2c4g50g"},
		// 升配后：父 task 已把 pass.bundle_id 切到巡游
		{"bundle_cruise_01", "spec-4c8g80g"},
		{"bundle_cruise_ai_01", "spec-4c8g80g"},
	}
	for _, tc := range cases {
		t.Run(tc.passBundleID, func(t *testing.T) {
			if got := l.resolveInstanceSpecID(ctx, tc.passBundleID); got != tc.wantSpec {
				t.Errorf("spec for pass bundle %q = %q, want %q", tc.passBundleID, got, tc.wantSpec)
			}
		})
	}
}
