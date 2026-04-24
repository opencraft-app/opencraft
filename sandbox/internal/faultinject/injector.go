package faultinject

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
)

type Injector struct {
	svc                      *service.Service
	cp                       provider.CloudProvider
	db                       *sql.DB
	waitForCleanTimeout      time.Duration
	waitForCleanPollInterval time.Duration
	cleanupDeleteRetryDelay  time.Duration
	cleanupDeleteMaxAttempts int
}

func NewInjector(svc *service.Service, cp provider.CloudProvider, db *sql.DB) *Injector {
	return &Injector{
		svc:                      svc,
		cp:                       cp,
		db:                       db,
		waitForCleanTimeout:      90 * time.Second,
		waitForCleanPollInterval: 2 * time.Second,
		cleanupDeleteRetryDelay:  2 * time.Second,
		cleanupDeleteMaxAttempts: 15,
	}
}

type SGLimitRequest struct {
	TemplateClassID   string   `json:"template_class_id,omitempty"`
	SKUID             string   `json:"sku_id,omitempty"`
	BaseImage         string   `json:"base_image"`
	InstanceType      string   `json:"instance_type"`
	Region            string   `json:"region"`
	Zone              string   `json:"zone"`
	VpcID             string   `json:"vpc_id"`
	SubnetID          string   `json:"subnet_id"`
	SecurityGroups    []string `json:"security_groups"`
	AutoCleanup       bool     `json:"auto_cleanup"`
	NetworkTemplateID string   `json:"network_template_id,omitempty"`
}

type SGLimitResult struct {
	RunID                string   `json:"run_id"`
	TemplateClassID      string   `json:"template_class_id"`
	SKUID                string   `json:"sku_id"`
	SourcePoolID         string   `json:"source_pool_id"`
	NewPoolID            string   `json:"new_pool_id,omitempty"`
	CapacityBundleID     string   `json:"capacity_bundle_id,omitempty"`
	ClonedSecurityGroups []string `json:"cloned_security_groups,omitempty"`
	SourcePoolPaused     bool     `json:"source_pool_paused"`
	SandboxID            string   `json:"sandbox_id,omitempty"`
	AllocatedPoolID      string   `json:"allocated_pool_id,omitempty"`
	AllocatedInstanceID  string   `json:"allocated_instance_id,omitempty"`
	AutoCleanup          bool     `json:"auto_cleanup"`
}

func (i *Injector) InjectSGLimit(ctx context.Context, req SGLimitRequest) (SGLimitResult, error) {
	runID := uuid.NewString()
	templateClassID := firstNonEmpty(strings.TrimSpace(req.TemplateClassID), "fi-"+runID)
	skuID := firstNonEmpty(strings.TrimSpace(req.SKUID), "sku-"+runID)
	poolID := "pool-" + runID
	now := time.Now().UTC()

	emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.started", "开始执行 SG limit 故障注入，后续会创建临时控制面对象并触发自动恢复链。", runID,
		attribute.String("template_class_id", templateClassID),
		attribute.String("sku_id", skuID),
		attribute.String("source_pool_name", poolID),
		attribute.String("region", strings.TrimSpace(req.Region)),
		attribute.String("zone", strings.TrimSpace(req.Zone)),
	)

	templateClass, err := i.svc.UpsertTemplateClass(ctx, core.TemplateClass{
		ID:             templateClassID,
		Name:           templateClassID,
		Region:         strings.TrimSpace(req.Region),
		ResolutionMode: core.ResolutionModeSandboxPrimary,
		CreatedAt:      now,
		UpdatedAt:      now,
	})
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在创建临时 TemplateClass 时失败。", runID, attribute.String("stage", "upsert_template_class"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("upsert template class: %w", err)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.template_class_created", "故障注入已创建临时 TemplateClass。", runID, attribute.String("template_class_id", templateClass.ID))
	sku, err := i.svc.UpsertSKU(ctx, core.SKU{
		ID:                     skuID,
		Name:                   skuID,
		TemplateClassID:        templateClass.ID,
		BaseImage:              strings.TrimSpace(req.BaseImage),
		DesiredImageID:         strings.TrimSpace(req.BaseImage),
		InstanceType:           strings.TrimSpace(req.InstanceType),
		NetworkTemplateID:      strings.TrimSpace(req.NetworkTemplateID),
		DefaultDesiredCapacity: 1,
		RolloutState:           core.SKURolloutStateStable,
		CreatedAt:              now,
		UpdatedAt:              now,
	})
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在创建临时 SKU 时失败。", runID, attribute.String("stage", "upsert_sku"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("upsert sku: %w", err)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.sku_created", "故障注入已创建临时 SKU。", runID, attribute.String("sku_id", sku.ID))
	if _, err := i.svc.ReplaceTemplateSkuBindings(ctx, templateClass.ID, []core.TemplateSkuBinding{{
		TemplateClassID:    templateClass.ID,
		SKUID:              sku.ID,
		Priority:           1,
		Weight:             1,
		AdmissionState:     "active",
		RolloutEligibility: true,
		CreatedAt:          now,
		UpdatedAt:          now,
	}}); err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在建立 TemplateClass 到 SKU 绑定时失败。", runID, attribute.String("stage", "replace_template_sku_bindings"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("replace template sku bindings: %w", err)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.binding_created", "故障注入已建立 TemplateClass 到 SKU 的绑定。", runID, attribute.String("template_class_id", templateClass.ID), attribute.String("sku_id", sku.ID))
	sourcePool, err := i.svc.CreatePool(ctx, poolID, "fault-injection", req.BaseImage, 1, req.VpcID, req.SubnetID, req.Zone, req.SecurityGroups)
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在创建临时 source pool 时失败。", runID, attribute.String("stage", "create_source_pool"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("create source pool: %w", err)
	}
	sourcePool.TemplateClassID = templateClass.ID
	sourcePool.SKUID = sku.ID
	sourcePool.InstanceType = req.InstanceType
	if _, err := i.svc.UpdatePool(ctx, sourcePool); err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在回写 source pool 的 TemplateClass/SKU 元数据时失败。", runID, attribute.String("stage", "update_source_pool_metadata"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("update source pool metadata: %w", err)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.source_pool_ready", "故障注入已准备好 source pool，并将在下一步注入 SG limit 故障。", runID, attribute.String("source_pool_id", sourcePool.ID))

	recovery, err := TriggerSGLimitRecovery(ctx, i.svc, i.cp, sourcePool, "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded")
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在触发 SG limit 自动恢复链时失败。", runID, attribute.String("stage", "trigger_sg_limit_recovery"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("trigger sg limit recovery: %w", err)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.sg_limit_recovery_triggered", "故障注入已成功触发 SG limit 自动恢复链。", runID, attribute.Bool("recovery_triggered", recovery.Triggered), attribute.String("source_pool_id", sourcePool.ID))
	if _, err := i.svc.PausePool(ctx, sourcePool.ID, "terminal create error: LimitExceeded.CvmsVifsPerSecGroupLimitExceeded", "LimitExceeded.CvmsVifsPerSecGroupLimitExceeded", "fault injection"); err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在暂停 source pool 时失败。", runID, attribute.String("stage", "pause_source_pool"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("pause source pool: %w", err)
	}
	updatedPool, err := i.svc.GetPool(ctx, sourcePool.ID)
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在重新加载 source pool 状态时失败。", runID, attribute.String("stage", "reload_source_pool"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("reload source pool: %w", err)
	}

	result := SGLimitResult{
		RunID:            runID,
		TemplateClassID:  templateClass.ID,
		SKUID:            sku.ID,
		SourcePoolID:     sourcePool.ID,
		SourcePoolPaused: updatedPool.Status == core.PoolStatusPaused,
		AutoCleanup:      req.AutoCleanup,
	}
	if recovery.Triggered {
		result.NewPoolID = recovery.NewPool.ID
		result.CapacityBundleID = recovery.Bundle.ID
		result.ClonedSecurityGroups = append([]string(nil), recovery.Bundle.SecurityGroupIDs...)
		emitInjectEvent(ctx, "sandbox.faultinject.recovery_succeeded", "故障注入已成功拉起新的 shard pool，并生成真实腾讯云 SG shard。", runID,
			attribute.String("source_pool_id", sourcePool.ID),
			attribute.String("new_pool_id", recovery.NewPool.ID),
			attribute.String("capacity_bundle_id", recovery.Bundle.ID),
			attribute.StringSlice("cloned_security_groups", recovery.Bundle.SecurityGroupIDs),
		)
		if _, err := i.waitForRecoveredPoolClean(ctx, runID, recovery.NewPool.ID); err != nil {
			emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入已拉起新的 shard pool，但在等待 worker 将其补成 CLEAN 库存时超时或失败。", runID, attribute.String("stage", "wait_for_clean_inventory"), attribute.String("error", err.Error()), attribute.String("new_pool_id", recovery.NewPool.ID))
			return SGLimitResult{}, fmt.Errorf("wait for recovered pool CLEAN inventory: %w", err)
		}
	}
	allocation, err := i.svc.AllocateForRequest(ctx, templateClass.ID, "", "")
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在恢复成功后尝试创建真实 sandbox 时失败，说明新 pool 还没有真正进入业务分配链。", runID, attribute.String("stage", "allocate_sandbox"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("allocate sandbox from recovered pool: %w", err)
	}
	if recovery.Triggered && recovery.NewPool.ID != "" && allocation.Pool.ID != recovery.NewPool.ID {
		err := fmt.Errorf("allocation picked pool %s instead of recovered pool %s", allocation.Pool.ID, recovery.NewPool.ID)
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在恢复后确实拿到了可分配库存，但流量没有命中新恢复出来的新 pool。", runID, attribute.String("stage", "assert_allocated_pool"), attribute.String("error", err.Error()), attribute.String("expected_pool_id", recovery.NewPool.ID), attribute.String("actual_pool_id", allocation.Pool.ID))
		return SGLimitResult{}, err
	}
	sandbox, err := i.svc.CreateSandbox(ctx, core.Sandbox{
		InstanceID:           allocation.Instance.ID,
		PoolID:               allocation.Pool.ID,
		TemplateClassID:      templateClass.ID,
		ResolutionMode:       allocation.ResolutionMode,
		ResolutionSource:     allocation.ResolutionSource,
		ResolutionDivergence: allocation.Divergence,
		Region:               templateClass.Region,
		TimeoutSeconds:       600,
		AutoPause:            false,
		Secure:               false,
		AllowInternetAccess:  false,
	})
	if err != nil {
		emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入在创建 sandbox 记录时失败。", runID, attribute.String("stage", "create_sandbox"), attribute.String("error", err.Error()))
		return SGLimitResult{}, fmt.Errorf("create sandbox record: %w", err)
	}
	result.SandboxID = sandbox.ID
	result.AllocatedPoolID = allocation.Pool.ID
	result.AllocatedInstanceID = allocation.Instance.ID
	emitInjectEvent(ctx, "sandbox.faultinject.sandbox_created", "故障注入恢复成功后，系统已经从新 pool 里真实分配出一个 sandbox。", runID,
		attribute.String("sandbox_id", sandbox.ID),
		attribute.String("allocated_pool_id", allocation.Pool.ID),
		attribute.String("allocated_instance_id", allocation.Instance.ID),
		attribute.String("resolution_source", allocation.ResolutionSource),
	)
	if req.AutoCleanup {
		if err := i.cleanup(ctx, result); err != nil {
			emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.failed", "故障注入主流程成功，但自动清理临时资源失败。", runID, attribute.String("stage", "cleanup"), attribute.String("error", err.Error()))
			return SGLimitResult{}, fmt.Errorf("cleanup injected resources: %w", err)
		}
		emitInjectEvent(ctx, "sandbox.faultinject.cleanup_succeeded", "故障注入已完成自动清理，临时 DB 行和克隆出来的 SG 已被删除。", runID)
	}
	emitInjectEvent(ctx, "sandbox.faultinject.sg_limit.completed", "SG limit 故障注入流程已完成。", runID, attribute.Bool("source_pool_paused", result.SourcePoolPaused), attribute.Bool("auto_cleanup", result.AutoCleanup))
	return result, nil
}

func (i *Injector) cleanup(ctx context.Context, result SGLimitResult) error {
	if result.SandboxID != "" {
		if err := i.svc.DeleteSandbox(ctx, result.SandboxID); err != nil {
			return err
		}
	}
	if err := i.cleanupPoolInstances(ctx, result.SourcePoolID, result.NewPoolID); err != nil {
		return err
	}
	if deleter, ok := i.cp.(interface {
		DeleteSecurityGroup(context.Context, string, string) error
	}); ok {
		for _, sgID := range result.ClonedSecurityGroups {
			if err := i.deleteSecurityGroupWithRetry(ctx, deleter, firstNonEmptyEnv("SANDBOX_TENCENT_LIVE_REGION", "TENCENT_REGION"), sgID); err != nil {
				return err
			}
		}
	}
	if i.db == nil {
		return nil
	}
	for _, stmt := range []struct {
		query string
		args  []any
	}{
		{`DELETE FROM template_pool_bindings WHERE pool_id IN (?, ?)`, []any{result.SourcePoolID, result.NewPoolID}},
		{`DELETE FROM instances WHERE pool_id IN (?, ?)`, []any{result.SourcePoolID, result.NewPoolID}},
		{`DELETE FROM pools WHERE id IN (?, ?)`, []any{result.SourcePoolID, result.NewPoolID}},
		{`DELETE FROM capacity_bundles WHERE id = ?`, []any{result.CapacityBundleID}},
		{`DELETE FROM template_sku_bindings WHERE template_class_id = ?`, []any{result.TemplateClassID}},
		{`DELETE FROM skus WHERE id = ?`, []any{result.SKUID}},
		{`DELETE FROM template_classes WHERE id = ?`, []any{result.TemplateClassID}},
	} {
		if strings.Contains(stmt.query, "?, ?") && result.NewPoolID == "" {
			continue
		}
		if strings.HasSuffix(stmt.query, "id = ?") && stmt.args[0] == "" {
			continue
		}
		if _, err := i.db.ExecContext(ctx, stmt.query, stmt.args...); err != nil {
			return err
		}
	}
	return nil
}

func (i *Injector) cleanupPoolInstances(ctx context.Context, poolIDs ...string) error {
	seenPools := map[string]struct{}{}
	seenInstances := map[string]struct{}{}
	for _, poolID := range poolIDs {
		poolID = strings.TrimSpace(poolID)
		if poolID == "" {
			continue
		}
		if _, ok := seenPools[poolID]; ok {
			continue
		}
		seenPools[poolID] = struct{}{}
		insts, err := i.svc.ListInstances(ctx, poolID)
		if err != nil {
			return err
		}
		for _, inst := range insts {
			if _, ok := seenInstances[inst.ID]; ok {
				continue
			}
			seenInstances[inst.ID] = struct{}{}
			if strings.TrimSpace(inst.CloudID) != "" {
				if err := i.cp.TerminateInstance(ctx, inst.CloudID); err != nil {
					return err
				}
			}
			if err := i.svc.DeleteInstance(ctx, inst.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (i *Injector) deleteSecurityGroupWithRetry(ctx context.Context, deleter interface {
	DeleteSecurityGroup(context.Context, string, string) error
}, region, securityGroupID string) error {
	attempts := i.cleanupDeleteMaxAttempts
	if attempts <= 0 {
		attempts = 1
	}
	delay := i.cleanupDeleteRetryDelay
	if delay <= 0 {
		delay = time.Second
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		err := deleter.DeleteSecurityGroup(ctx, region, securityGroupID)
		if err == nil {
			return nil
		}
		if !strings.Contains(err.Error(), "ResourceInUse") || attempt == attempts {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return nil
}

func emitInjectEvent(ctx context.Context, name, explanation, runID string, attrs ...attribute.KeyValue) {
	base := []attribute.KeyValue{attribute.String("run_id", runID)}
	observability.EmitEvent(ctx, name, explanation, append(base, attrs...)...)
}

func (i *Injector) waitForRecoveredPoolClean(ctx context.Context, runID string, poolID string) (core.Instance, error) {
	poolID = strings.TrimSpace(poolID)
	if poolID == "" {
		return core.Instance{}, fmt.Errorf("missing recovered pool id")
	}
	timeout := i.waitForCleanTimeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	poll := i.waitForCleanPollInterval
	if poll <= 0 {
		poll = 2 * time.Second
	}

	waitCtx := ctx
	cancel := func() {}
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > timeout {
		waitCtx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()

	emitInjectEvent(waitCtx, "sandbox.faultinject.waiting_for_clean_inventory", "故障注入已创建新 pool，正在等待现有 worker 按正常 refill 流程补出至少一个 CLEAN 实例。", runID,
		attribute.String("new_pool_id", poolID),
		attribute.Int64("wait_timeout_ms", timeout.Milliseconds()),
		attribute.Int64("poll_interval_ms", poll.Milliseconds()),
	)

	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		insts, err := i.svc.ListInstancesByStates(waitCtx, poolID, []core.InstanceState{core.StateClean}, 1)
		if err != nil {
			return core.Instance{}, err
		}
		if len(insts) > 0 {
			emitInjectEvent(waitCtx, "sandbox.faultinject.clean_inventory_observed", "故障注入已观察到恢复出的新 pool 具备 CLEAN 库存，后续将继续走真实分配链。", runID,
				attribute.String("new_pool_id", poolID),
				attribute.String("instance_id", insts[0].ID),
			)
			return insts[0], nil
		}
		select {
		case <-waitCtx.Done():
			return core.Instance{}, waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}
