package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"cvm-mock-e2b/internal/core"
)

func TestNullStringValue(t *testing.T) {
	if got := nullStringValue(sql.NullString{}); got != "" {
		t.Fatalf("expected invalid null string to become empty, got %q", got)
	}
	if got := nullStringValue(sql.NullString{String: "paused", Valid: true}); got != "paused" {
		t.Fatalf("expected valid null string to keep value, got %q", got)
	}
}

func TestVerifySchemaRequiresExpectedTables(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"table_name"}).
		AddRow("instances").
		AddRow("pools").
		AddRow("sandboxes").
		AddRow("skus").
		AddRow("template_classes").
		AddRow("template_sku_bindings").
		AddRow("template_pool_bindings").
		AddRow("pool_autoscale_policies").
		AddRow("capacity_bundles").
		AddRow("vpc_shards").
		AddRow("vpc_shard_subnets").
		AddRow("vpc_shard_blueprint_snapshots").
		AddRow("vpc_shard_provision_progress").
		AddRow("vpc_shard_create_locks").
		AddRow("vpc_shard_cleanup_resources")
	mock.ExpectQuery("SELECT table_name FROM information_schema.tables").
		WithArgs("sandbox_test").
		WillReturnRows(rows)

	if err := verifySchema(db, "sandbox_test"); err != nil {
		t.Fatalf("verifySchema returned err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestSandboxMigrationsPresent(t *testing.T) {
	for _, name := range []string{
		"000001_init_schema.up.sql",
		"000001_init_schema.down.sql",
		"000002_add_sandbox_region.up.sql",
		"000002_add_sandbox_region.down.sql",
		"000003_pool_controller_foundation.up.sql",
		"000003_pool_controller_foundation.down.sql",
		"000004_sku_control_plane.up.sql",
		"000004_sku_control_plane.down.sql",
		"000005_vpc_shard_foundation.up.sql",
		"000005_vpc_shard_foundation.down.sql",
		"000006_add_pause_states.up.sql",
		"000006_add_pause_states.down.sql",
		"000007_add_pool_system_disk_size.up.sql",
		"000007_add_pool_system_disk_size.down.sql",
		"000008_add_sku_system_disk_size.up.sql",
		"000008_add_sku_system_disk_size.down.sql",
	} {
		path := filepath.Join("..", "..", "migrations", name)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected migration %s to exist: %v", path, err)
		}
	}
}

func TestSKUSystemDiskMigrationBackfills4C8GTemplateClass(t *testing.T) {
	path := filepath.Join("..", "..", "migrations", "000008_add_sku_system_disk_size.up.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration %s: %v", path, err)
	}
	migration := string(content)
	for _, expected := range []string{
		"SET system_disk_size = 80",
		"WHERE template_class_id = 'openclaw-4c8g80g'",
	} {
		if !strings.Contains(migration, expected) {
			t.Fatalf("expected migration to contain %q", expected)
		}
	}
}

func TestMySQLStoreTemplateClassRoundTrip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	store := &MySQLStore{db: db}
	now := time.Now().UTC()
	templateClass := core.TemplateClass{
		ID:             "openclaw-default",
		Name:           "OpenClaw Default",
		ResolutionMode: core.ResolutionModeSandboxPrimary,
		Status:         core.TemplateClassStatusActive,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	mock.ExpectExec("INSERT INTO template_classes").
		WithArgs(templateClass.ID, templateClass.Name, templateClass.Description, templateClass.WorkloadType, templateClass.Region, templateClass.DefaultPoolSelectionPolicy, templateClass.ResolutionMode, templateClass.Status, templateClass.ImportGeneration, templateClass.DivergenceMessage, templateClass.CreatedAt, templateClass.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.UpsertTemplateClass(context.Background(), templateClass); err != nil {
		t.Fatalf("upsert template class: %v", err)
	}

	rows := sqlmock.NewRows([]string{"id", "name", "description", "workload_type", "region", "default_pool_selection_policy", "resolution_mode", "status", "import_generation", "divergence_message", "created_at", "updated_at"}).
		AddRow(templateClass.ID, templateClass.Name, nil, templateClass.WorkloadType, templateClass.Region, templateClass.DefaultPoolSelectionPolicy, templateClass.ResolutionMode, templateClass.Status, templateClass.ImportGeneration, nil, templateClass.CreatedAt, templateClass.UpdatedAt)
	mock.ExpectQuery("SELECT id, name, description, workload_type, region, default_pool_selection_policy, resolution_mode, status, import_generation, divergence_message, created_at, updated_at FROM template_classes").
		WithArgs(templateClass.ID).
		WillReturnRows(rows)
	got, err := store.GetTemplateClass(context.Background(), templateClass.ID)
	if err != nil {
		t.Fatalf("get template class: %v", err)
	}
	if got.ID != templateClass.ID || got.ResolutionMode != templateClass.ResolutionMode {
		t.Fatalf("unexpected template class roundtrip: %+v", got)
	}
	if got.Description != "" || got.DivergenceMessage != "" {
		t.Fatalf("expected nullable text fields to become empty strings, got description=%q divergence=%q", got.Description, got.DivergenceMessage)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestMySQLStoreSKURoundTrip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	store := &MySQLStore{db: db}
	now := time.Now().UTC()
	sku := core.SKU{
		ID:              "sku-default",
		Name:            "Default SKU",
		TemplateClassID: "openclaw-default",
		BaseImage:       "img-base",
		DesiredImageID:  "img-new",
		StableImageID:   "img-old",
		InstanceType:    "SA9.MEDIUM2",
		SystemDiskSize:  80,
		RolloutState:    core.SKURolloutStateRolling,
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	mock.ExpectExec("INSERT INTO skus").
		WithArgs(sku.ID, sku.Name, sku.Description, sku.TemplateClassID, sku.BaseImage, sku.DesiredImageID, sku.StableImageID, sku.InstanceType, sku.SystemDiskSize, sku.NetworkTemplateID, sku.SecurityGroupRuleTemplateID, sku.AutoscalePolicyID, sku.DefaultDesiredCapacity, sku.RolloutState, sku.RolloutCursorPoolID, sku.Generation, sku.ConvergedPoolCount, sku.TotalPoolCount, sku.PoolsPendingRollout, sku.LastRolloutStartedAt, sku.LastRolloutError, sku.CreatedAt, sku.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.UpsertSKU(context.Background(), sku); err != nil {
		t.Fatalf("upsert sku: %v", err)
	}

	rows := sqlmock.NewRows([]string{"id", "name", "description", "template_class_id", "base_image", "desired_image_id", "stable_image_id", "instance_type", "system_disk_size", "network_template_id", "security_group_rule_template_id", "autoscale_policy_id", "default_desired_capacity", "rollout_state", "rollout_cursor_pool_id", "generation", "converged_pool_count", "total_pool_count", "pools_pending_rollout", "last_rollout_started_at", "last_rollout_error", "created_at", "updated_at"}).
		AddRow(sku.ID, sku.Name, nil, sku.TemplateClassID, sku.BaseImage, sku.DesiredImageID, sku.StableImageID, sku.InstanceType, sku.SystemDiskSize, sku.NetworkTemplateID, sku.SecurityGroupRuleTemplateID, sku.AutoscalePolicyID, sku.DefaultDesiredCapacity, sku.RolloutState, sku.RolloutCursorPoolID, sku.Generation, sku.ConvergedPoolCount, sku.TotalPoolCount, sku.PoolsPendingRollout, nil, nil, sku.CreatedAt, sku.UpdatedAt)
	mock.ExpectQuery("SELECT id, name, description, template_class_id, base_image, desired_image_id, stable_image_id").
		WithArgs(sku.ID).
		WillReturnRows(rows)
	got, err := store.GetSKU(context.Background(), sku.ID)
	if err != nil {
		t.Fatalf("get sku: %v", err)
	}
	if got.ID != sku.ID || got.DesiredImageID != sku.DesiredImageID || got.SystemDiskSize != sku.SystemDiskSize {
		t.Fatalf("unexpected sku roundtrip: %+v", got)
	}
	if got.Description != "" || got.LastRolloutError != "" {
		t.Fatalf("expected nullable text fields to become empty strings, got description=%q last_rollout_error=%q", got.Description, got.LastRolloutError)
	}
}

func TestMySQLStoreTemplateBindingsAndPolicyRoundTrip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	store := &MySQLStore{db: db}
	now := time.Now().UTC()
	binding := core.TemplatePoolBinding{
		TemplateClassID: "openclaw-default",
		PoolID:          "pool-1",
		Priority:        1,
		Weight:          2,
		Role:            core.PoolBindingRolePrimary,
		AdmissionState:  core.BindingAdmissionStateActive,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	mock.ExpectExec("INSERT INTO template_pool_bindings").
		WithArgs(binding.TemplateClassID, binding.PoolID, binding.Priority, binding.Weight, binding.Role, binding.AdmissionState, binding.Reason, binding.CreatedAt, binding.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.UpsertTemplatePoolBinding(context.Background(), binding); err != nil {
		t.Fatalf("upsert template pool binding: %v", err)
	}

	bindingRows := sqlmock.NewRows([]string{"template_class_id", "pool_id", "priority", "weight", "role", "admission_state", "reason", "created_at", "updated_at"}).
		AddRow(binding.TemplateClassID, binding.PoolID, binding.Priority, binding.Weight, binding.Role, binding.AdmissionState, binding.Reason, binding.CreatedAt, binding.UpdatedAt)
	mock.ExpectQuery("SELECT template_class_id, pool_id, priority, weight, role, admission_state, reason, created_at, updated_at FROM template_pool_bindings").
		WithArgs(binding.TemplateClassID).
		WillReturnRows(bindingRows)
	bindings, err := store.ListTemplatePoolBindings(context.Background(), binding.TemplateClassID)
	if err != nil {
		t.Fatalf("list template pool bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].PoolID != binding.PoolID {
		t.Fatalf("unexpected bindings roundtrip: %+v", bindings)
	}

	policy := core.PoolAutoscalePolicy{
		TemplateClassID:          binding.TemplateClassID,
		MinPoolCount:             1,
		MaxPoolCount:             4,
		WarmBundleTarget:         2,
		CapacityPressureLimitPct: 80,
		CreatedAt:                now,
		UpdatedAt:                now,
	}
	mock.ExpectExec("INSERT INTO pool_autoscale_policies").
		WithArgs(policy.TemplateClassID, policy.MinPoolCount, policy.MaxPoolCount, policy.MinCleanPerPool, policy.TargetCleanPerPool, policy.MaxCleanPerPool, policy.WarmBundleTarget, policy.SlowHorizonTarget, policy.ScaleOutCooldownSeconds, policy.ScaleInCooldownSeconds, policy.RefillFailureThreshold, policy.ZoneFailureThreshold, policy.CapacityPressureLimitPct, policy.CreatedAt, policy.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.UpsertPoolAutoscalePolicy(context.Background(), policy); err != nil {
		t.Fatalf("upsert pool autoscale policy: %v", err)
	}

	policyRows := sqlmock.NewRows([]string{"template_class_id", "min_pool_count", "max_pool_count", "min_clean_per_pool", "target_clean_per_pool", "max_clean_per_pool", "warm_bundle_target", "slow_horizon_target", "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "refill_failure_threshold", "zone_failure_threshold", "capacity_pressure_limit_pct", "created_at", "updated_at"}).
		AddRow(policy.TemplateClassID, policy.MinPoolCount, policy.MaxPoolCount, policy.MinCleanPerPool, policy.TargetCleanPerPool, policy.MaxCleanPerPool, policy.WarmBundleTarget, policy.SlowHorizonTarget, policy.ScaleOutCooldownSeconds, policy.ScaleInCooldownSeconds, policy.RefillFailureThreshold, policy.ZoneFailureThreshold, policy.CapacityPressureLimitPct, policy.CreatedAt, policy.UpdatedAt)
	mock.ExpectQuery("SELECT template_class_id, min_pool_count, max_pool_count, min_clean_per_pool, target_clean_per_pool, max_clean_per_pool, warm_bundle_target, slow_horizon_target, scale_out_cooldown_seconds, scale_in_cooldown_seconds, refill_failure_threshold, zone_failure_threshold, capacity_pressure_limit_pct, created_at, updated_at FROM pool_autoscale_policies").
		WithArgs(policy.TemplateClassID).
		WillReturnRows(policyRows)
	gotPolicy, err := store.GetPoolAutoscalePolicy(context.Background(), policy.TemplateClassID)
	if err != nil {
		t.Fatalf("get pool autoscale policy: %v", err)
	}
	if gotPolicy.TemplateClassID != policy.TemplateClassID || gotPolicy.WarmBundleTarget != policy.WarmBundleTarget {
		t.Fatalf("unexpected policy roundtrip: %+v", gotPolicy)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestMySQLStoreReplaceTemplatePoolBindingsUsesTransaction(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	store := &MySQLStore{db: db}
	now := time.Now().UTC()
	bindings := []core.TemplatePoolBinding{
		{
			TemplateClassID: "openclaw-default",
			PoolID:          "pool-a",
			Priority:        1,
			Weight:          2,
			Role:            core.PoolBindingRolePrimary,
			AdmissionState:  core.BindingAdmissionStateActive,
			CreatedAt:       now,
			UpdatedAt:       now,
		},
	}

	mock.ExpectBegin()
	mock.ExpectExec("DELETE FROM template_pool_bindings").
		WithArgs("openclaw-default").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectPrepare("INSERT INTO template_pool_bindings")
	mock.ExpectExec("INSERT INTO template_pool_bindings").
		WithArgs(bindings[0].TemplateClassID, bindings[0].PoolID, bindings[0].Priority, bindings[0].Weight, bindings[0].Role, bindings[0].AdmissionState, bindings[0].Reason, bindings[0].CreatedAt, bindings[0].UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	got, err := store.ReplaceTemplatePoolBindings(context.Background(), "openclaw-default", bindings)
	if err != nil {
		t.Fatalf("replace template bindings: %v", err)
	}
	if len(got) != 1 || got[0].PoolID != "pool-a" {
		t.Fatalf("unexpected replace result: %+v", got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestMySQLStoreCapacityBundleAndSandboxRoundTrip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	store := &MySQLStore{db: db}
	now := time.Now().UTC()
	bundle := core.CapacityBundle{
		ID:               "bundle-1",
		Region:           "ap-beijing",
		Zone:             "ap-beijing-8",
		VpcID:            "vpc-1",
		SubnetID:         "subnet-1",
		SecurityGroupIDs: []string{"sg-1", "sg-2"},
		Status:           core.CapacityBundleStatusWarm,
		LineageTags:      map[string]string{"owner": "sandbox"},
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	mock.ExpectExec("INSERT INTO capacity_bundles").
		WithArgs(bundle.ID, bundle.Region, bundle.Zone, bundle.VpcID, bundle.SubnetID, "sg-1,sg-2", bundle.NetworkTemplateID, bundle.Status, bundle.BootstrapGeneration, `{"owner":"sandbox"}`, bundle.LastValidationResult, bundle.CreatedAt, bundle.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.UpsertCapacityBundle(context.Background(), bundle); err != nil {
		t.Fatalf("upsert capacity bundle: %v", err)
	}

	bundleRows := sqlmock.NewRows([]string{"id", "region", "zone", "vpc_id", "subnet_id", "security_group_ids", "network_template_id", "status", "bootstrap_generation", "lineage_tags", "last_validation_result", "created_at", "updated_at"}).
		AddRow(bundle.ID, bundle.Region, bundle.Zone, bundle.VpcID, bundle.SubnetID, "sg-1,sg-2", bundle.NetworkTemplateID, bundle.Status, bundle.BootstrapGeneration, `{"owner":"sandbox"}`, bundle.LastValidationResult, bundle.CreatedAt, bundle.UpdatedAt)
	mock.ExpectQuery("SELECT id, region, zone, vpc_id, subnet_id, security_group_ids, network_template_id, status, bootstrap_generation, lineage_tags, last_validation_result, created_at, updated_at FROM capacity_bundles").
		WithArgs(bundle.ID).
		WillReturnRows(bundleRows)
	gotBundle, err := store.GetCapacityBundle(context.Background(), bundle.ID)
	if err != nil {
		t.Fatalf("get capacity bundle: %v", err)
	}
	if gotBundle.ID != bundle.ID || len(gotBundle.SecurityGroupIDs) != 2 {
		t.Fatalf("unexpected bundle roundtrip: %+v", gotBundle)
	}

	sb := core.Sandbox{
		ID:                   "sb-1",
		InstanceID:           "inst-1",
		PoolID:               "pool-1",
		TemplateClassID:      "openclaw-default",
		ResolutionMode:       core.ResolutionModeShadow,
		ResolutionSource:     "shadow_legacy",
		ResolutionDivergence: "legacy pool differs",
		Region:               "ap-beijing",
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	mock.ExpectExec("INSERT INTO sandboxes").
		WithArgs(sb.ID, sb.InstanceID, sb.PoolID, sb.TemplateClassID, sb.ResolutionMode, sb.ResolutionSource, sb.ResolutionDivergence, sb.Region, "", "", sb.TimeoutSeconds, sb.AutoPause, sb.Secure, sb.AllowInternetAccess, sb.CreatedAt, sb.UpdatedAt).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if _, err := store.CreateSandbox(context.Background(), sb); err != nil {
		t.Fatalf("create sandbox: %v", err)
	}

	sbRows := sqlmock.NewRows([]string{"id", "instance_id", "pool_id", "template_class_id", "resolution_mode", "resolution_source", "resolution_divergence", "region", "metadata", "env_vars", "timeout_seconds", "auto_pause", "secure", "allow_internet", "created_at", "updated_at"}).
		AddRow(sb.ID, sb.InstanceID, sb.PoolID, sb.TemplateClassID, sb.ResolutionMode, sb.ResolutionSource, sb.ResolutionDivergence, sb.Region, "", "", sb.TimeoutSeconds, sb.AutoPause, sb.Secure, sb.AllowInternetAccess, sb.CreatedAt, sb.UpdatedAt)
	mock.ExpectQuery("SELECT id, instance_id, pool_id, template_class_id, resolution_mode, resolution_source, resolution_divergence, region, metadata, env_vars, timeout_seconds, auto_pause, secure, allow_internet, created_at, updated_at FROM sandboxes").
		WithArgs(sb.ID).
		WillReturnRows(sbRows)
	gotSandbox, err := store.GetSandbox(context.Background(), sb.ID)
	if err != nil {
		t.Fatalf("get sandbox: %v", err)
	}
	if gotSandbox.ResolutionDivergence != sb.ResolutionDivergence {
		t.Fatalf("expected divergence %q, got %q", sb.ResolutionDivergence, gotSandbox.ResolutionDivergence)
	}

	sbNullRows := sqlmock.NewRows([]string{"id", "instance_id", "pool_id", "template_class_id", "resolution_mode", "resolution_source", "resolution_divergence", "region", "metadata", "env_vars", "timeout_seconds", "auto_pause", "secure", "allow_internet", "created_at", "updated_at"}).
		AddRow(sb.ID, sb.InstanceID, sb.PoolID, sb.TemplateClassID, sb.ResolutionMode, sb.ResolutionSource, nil, sb.Region, "", "", sb.TimeoutSeconds, sb.AutoPause, sb.Secure, sb.AllowInternetAccess, sb.CreatedAt, sb.UpdatedAt)
	mock.ExpectQuery("SELECT id, instance_id, pool_id, template_class_id, resolution_mode, resolution_source, resolution_divergence, region, metadata, env_vars, timeout_seconds, auto_pause, secure, allow_internet, created_at, updated_at FROM sandboxes").
		WithArgs(sb.ID).
		WillReturnRows(sbNullRows)
	gotSandbox, err = store.GetSandbox(context.Background(), sb.ID)
	if err != nil {
		t.Fatalf("get sandbox with null divergence: %v", err)
	}
	if gotSandbox.ResolutionDivergence != "" {
		t.Fatalf("expected empty divergence for null db value, got %q", gotSandbox.ResolutionDivergence)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}
