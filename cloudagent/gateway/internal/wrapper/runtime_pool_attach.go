package wrapper

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (w *AgentSidecarWorker) tryClaimWarmSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest, backend agentSidecarBackend, runtime ACPSessionRuntime, timeline func(string, ...string)) (WarmRuntimeClaim, bool) {
	if w.runtimePool == nil || !runtime.isWispOuterRuntime() {
		return WarmRuntimeClaim{}, false
	}
	poolKey := warmRuntimePoolKeyForRuntime(runtime, backend)
	timeline("acp_runtime_pool_claim_start", "pool_key="+quoteTimelineField(poolKey))
	claim, err := w.runtimePool.ClaimWarmRuntime(ctx, WarmRuntimeClaimRequest{
		PoolKey:     poolKey,
		OwnerID:     runtimeResourceOwnerID(req),
		SessionID:   req.SessionID,
		Generation:  req.Generation,
		TTL:         w.workspaceLeaseTTL,
		MaxReadyAge: envDurationSeconds("GATEWAY_RUNTIME_WARM_POOL_READY_TTL_SECONDS", defaultWorkspaceLeaseTTL),
	})
	if errors.Is(err, ErrWarmRuntimePoolMiss) {
		timeline("acp_runtime_pool_claim_miss", "pool_key="+quoteTimelineField(poolKey))
		return WarmRuntimeClaim{}, false
	}
	if err != nil {
		timeline("acp_runtime_pool_claim_failed", "pool_key="+quoteTimelineField(poolKey), "error="+quoteTimelineField(err.Error()))
		return WarmRuntimeClaim{}, false
	}
	if err := validateWarmRuntimeHost(claim.Host); err != nil {
		timeline("acp_runtime_pool_claim_invalid", "pool_key="+quoteTimelineField(poolKey), "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
		_ = w.runtimePool.DiscardWarmRuntime(ctx, claim, err.Error())
		return WarmRuntimeClaim{}, false
	}
	timeline("acp_runtime_pool_claim_hit",
		"pool_key="+quoteTimelineField(poolKey),
		"item_id="+quoteTimelineField(claim.ItemID),
		"outer_sandbox_id="+quoteTimelineField(claim.Host.OuterSandboxID),
		"inner_sandbox_id="+quoteTimelineField(claim.Host.InnerSandboxID),
		fmt.Sprintf("fence=%d", claim.Fence),
	)
	return claim, true
}

func (w *AgentSidecarWorker) startSessionRuntimeFromWarmClaim(ctx context.Context, req ACPSessionRuntimeStartRequest, backend agentSidecarBackend, runtime ACPSessionRuntime, claim WarmRuntimeClaim, timeline func(string, ...string)) (ACPSessionRuntime, error) {
	host := claim.Host
	runtime.SandboxBackend = firstNonEmpty(host.SandboxBackend, backend.name)
	runtime.OuterSandboxID = host.OuterSandboxID
	runtime.OuterSandboxDomain = host.OuterSandboxDomain
	runtime.OuterEnvdAccessToken = host.OuterEnvdAccessToken
	runtime.OuterTrafficToken = host.OuterTrafficToken
	runtime.InnerSandboxID = host.InnerSandboxID
	runtime.InnerSandboxDomain = host.InnerSandboxDomain
	runtime.InnerEnvdAccessToken = host.InnerEnvdAccessToken
	runtime.WispPackageURL = firstNonEmpty(host.WispPackageURL, runtime.WispPackageURL)
	runtime.WispInstallDir = host.OuterWispInstallDir
	runtime.WispClientPath = host.OuterWispClientPath
	runtime.WorkspaceWispClient = host.InnerWispClientPath

	claimedBackend, ok := w.backendForName(runtime.SandboxBackend)
	if !ok {
		return ACPSessionRuntime{}, fmt.Errorf("warm runtime backend %q is not configured", runtime.SandboxBackend)
	}
	outerSandbox := runtimeOuterSandbox(runtime)
	innerSandbox := RuntimeHostTarget{
		ID:              runtime.InnerSandboxID,
		HostType:        claimedBackend.name,
		Domain:          runtime.InnerSandboxDomain,
		EnvdAccessToken: runtime.InnerEnvdAccessToken,
	}
	if err := w.upsertRuntimeResource(ctx, req, runtime.RuntimeID, claimedBackend.name, "creating", runtime.OuterSandboxID, runtime.InnerSandboxID, ""); err != nil {
		return ACPSessionRuntime{}, err
	}
	var (
		space        agentWispSMHSpace
		cleanupSpace bool
		err          error
	)
	if strings.TrimSpace(runtime.WispSMHSpaceID) != "" {
		var token string
		token, err = w.issueWispSMHToken(ctx, runtime.WispSMHSpaceID, "admin")
		if err != nil {
			_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
			return ACPSessionRuntime{}, err
		}
		space = agentWispSMHSpace{SpaceID: runtime.WispSMHSpaceID, AccessToken: token, Owned: false}
	} else {
		spacePrepare := w.startWispSMHSpacePrepare(ctx, timeline)
		space, err = spacePrepare.await()
		if err != nil {
			_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
			return ACPSessionRuntime{}, err
		}
		cleanupSpace = space.Owned
	}
	defer func() {
		if cleanupSpace {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = w.deleteWispSMHSpace(cleanupCtx, space.SpaceID)
		}
	}()
	runtime, err = w.resolveWispRuntimeForSpace(ctx, runtime, req, space, true)
	if err != nil {
		_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
		return ACPSessionRuntime{}, err
	}
	releaseLease := true
	defer func() {
		if releaseLease {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = w.releaseWispWorkspaceLease(releaseCtx, runtime)
		}
	}()
	workspaceCreate := workspaceSandboxCreateFromTarget(innerSandbox)
	workspacePrepare := w.startWorkspaceRuntimePrepare(ctx, claimedBackend, runtime, req, workspaceIDForRuntime(runtime, req), workspaceCreate, timeline)

	timeline("acp_runtime_pool_wisp_prepare_start", "item_id="+quoteTimelineField(claim.ItemID), "outer_sandbox_id="+quoteTimelineField(runtime.OuterSandboxID))
	prepared, err := w.prepareWispRuntimeWithSpace(ctx, claimedBackend.host, outerSandbox, runtime, req, space, "outer", false)
	if err != nil {
		timeline("acp_runtime_pool_wisp_prepare_failed", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
		workspacePrepare.cancelAndCleanup(claimedBackend.host)
		_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
		w.cleanupFailedSessionRuntime(claimedBackend.host, outerSandbox, runtime)
		return ACPSessionRuntime{}, err
	}
	runtime = prepared
	releaseLease = false
	cleanupSpace = false
	timeline("acp_runtime_pool_wisp_prepare_done", "item_id="+quoteTimelineField(claim.ItemID), "wisp_name="+quoteTimelineField(runtime.WispName), "smh_space_id="+quoteTimelineField(runtime.WispSMHSpaceID))

	if err := w.bootSessionDaemon(ctx, outerSandbox, runtime, req); err != nil {
		timeline("acp_runtime_pool_daemon_failed", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
		workspacePrepare.cancelAndCleanup(claimedBackend.host)
		_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
		w.cleanupFailedSessionRuntime(claimedBackend.host, outerSandbox, runtime)
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_pool_daemon_done", "item_id="+quoteTimelineField(claim.ItemID), "sandbox_id="+runtime.OuterSandboxID, "addr="+quoteTimelineField(runtime.DaemonAddr))
	if err := w.writeWispHermesBootstrapManifest(ctx, claimedBackend.host, outerSandbox, runtime, req); err != nil {
		timeline("acp_runtime_pool_bootstrap_manifest_failed", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
		workspacePrepare.cancelAndCleanup(claimedBackend.host)
		_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
		w.cleanupFailedSessionRuntime(claimedBackend.host, outerSandbox, runtime)
		return ACPSessionRuntime{}, err
	}
	attached, err := w.attachSessionWorkspaceRuntime(ctx, claimedBackend, runtime, req, workspacePrepare)
	if err != nil {
		timeline("acp_runtime_pool_workspace_bind_failed", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
		_ = w.runtimePool.DiscardWarmRuntime(context.Background(), claim, err.Error())
		w.cleanupFailedSessionRuntime(claimedBackend.host, outerSandbox, runtime)
		return ACPSessionRuntime{}, err
	}
	runtime = attached
	w.markRuntimeResourceState(ctx, req, "bound", "")
	timeline("acp_runtime_pool_workspace_bind_done", "item_id="+quoteTimelineField(claim.ItemID), "workspace_id="+quoteTimelineField(runtime.WorkspaceID), "workspace_runtime_id="+quoteTimelineField(runtime.WorkspaceRuntimeID), "inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID))
	_ = w.runtimePool.ConsumeWarmRuntime(context.Background(), claim)
	return runtime, nil
}

func workspaceSandboxCreateFromTarget(sb RuntimeHostTarget) *workspaceSandboxCreate {
	ch := make(chan workspaceSandboxCreateResult, 1)
	ch <- workspaceSandboxCreateResult{sandbox: sb}
	return &workspaceSandboxCreate{cancel: func() {}, result: ch}
}
