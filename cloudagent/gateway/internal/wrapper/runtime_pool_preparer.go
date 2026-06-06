package wrapper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"time"
)

type WarmRuntimeCreateRequest struct {
	ItemID           string
	PoolKey          string
	OwnerID          string
	SandboxBackend   string
	OuterRuntime     string
	AgentVersion     string
	WorkspaceVersion string
	SidecarURL       string
	SidecarSHA256    string
	SidecarSigURL    string
	SigningKeyID     string
}

func (w *AgentSidecarWorker) WarmRuntimePoolKey(req WarmRuntimeCreateRequest) (string, error) {
	backendName := firstNonEmpty(req.SandboxBackend, firstEnv("GATEWAY_ACP_SANDBOX_BACKEND", "GATEWAY_SANDBOX_BACKEND"))
	backend, ok := w.backendForName(backendName)
	if !ok {
		return "", fmt.Errorf("sandbox backend %q is not configured", backendName)
	}
	agentVersion := normalizeRuntimeVersion(req.AgentVersion, defaultAgentVersion)
	agentPlugin, err := agentBehaviorPluginFor(agentVersion)
	if err != nil {
		return "", err
	}
	workspaceVersion := normalizeRuntimeVersion(req.WorkspaceVersion, defaultWorkspaceVersion)
	workspaceSpec, err := workspaceRuntimeSpecFor(workspaceVersion)
	if err != nil {
		return "", err
	}
	if templateID := strings.TrimSpace(agentPlugin.templateID); templateID != "" {
		backend.outerTemplateID = templateID
	}
	if templateID := strings.TrimSpace(workspaceSpec.templateID); templateID != "" {
		backend.innerTemplateID = templateID
	}
	artifact, err := validatedSidecarArtifact("warm runtime sidecar_artifact", agentSidecarArtifact{
		URL:          req.SidecarURL,
		SHA256:       req.SidecarSHA256,
		SigURL:       req.SidecarSigURL,
		SigningKeyID: req.SigningKeyID,
	})
	if err != nil {
		return "", err
	}
	artifact = resolvedSidecarArtifact(artifact, agentPlugin, w.defaultSidecarArtifact())
	runtime := ACPSessionRuntime{
		SandboxBackend:      backend.name,
		OuterRuntime:        normalizeOuterRuntime(firstNonEmpty(req.OuterRuntime, w.outerRuntime)),
		AgentVersion:        agentVersion,
		AgentTemplateID:     backend.outerTemplateID,
		SidecarURL:          artifact.URL,
		SidecarSHA256:       artifact.SHA256,
		SidecarSigURL:       artifact.SigURL,
		SigningKeyID:        artifact.SigningKeyID,
		WorkspaceVersion:    workspaceVersion,
		WorkspaceTemplateID: backend.innerTemplateID,
		WispPackageURL:      w.wispPackageURL,
		WispRootUpperSize:   w.wispRootUpperSize,
		WispJFSPrefix:       w.wispJFSPrefix,
	}
	return warmRuntimePoolKeyForRuntime(runtime, backend), nil
}

func (w *AgentSidecarWorker) CreateWarmRuntimePoolItem(ctx context.Context, req WarmRuntimeCreateRequest) (WarmRuntimeItem, error) {
	if normalizeOuterRuntime(firstNonEmpty(req.OuterRuntime, w.outerRuntime)) != outerRuntimeWisp {
		return WarmRuntimeItem{}, errors.New("warm runtime pool currently supports wisp outer runtime only")
	}
	if req.ItemID == "" {
		req.ItemID = "warm_" + randomHex(12)
	}
	poolKey := strings.TrimSpace(req.PoolKey)
	if poolKey == "" {
		var err error
		poolKey, err = w.WarmRuntimePoolKey(req)
		if err != nil {
			return WarmRuntimeItem{}, err
		}
	}
	backendName := firstNonEmpty(req.SandboxBackend, firstEnv("GATEWAY_ACP_SANDBOX_BACKEND", "GATEWAY_SANDBOX_BACKEND"))
	backend, ok := w.backendForName(backendName)
	if !ok {
		return WarmRuntimeItem{}, fmt.Errorf("sandbox backend %q is not configured", backendName)
	}
	if store, ok := w.runtimePool.(WarmRuntimePoolStore); ok {
		if err := store.UpsertWarmRuntimeItem(ctx, WarmRuntimeItem{
			ItemID:     req.ItemID,
			PoolKey:    poolKey,
			State:      warmRuntimePoolStateCreating,
			OwnerID:    req.OwnerID,
			WorkflowID: req.OwnerID,
		}); err != nil {
			return WarmRuntimeItem{}, err
		}
	}

	type createResult struct {
		target string
		sb     RuntimeHostTarget
		err    error
	}
	createCh := make(chan createResult, 2)
	create := func(target string, templateID string) {
		sb, err := backend.host.CreateSandbox(ctx, CreateSandboxOptions{
			TemplateID:          templateID,
			TimeoutSeconds:      w.sandboxTimeoutSeconds,
			Secure:              true,
			AllowInternetAccess: true,
			Metadata: map[string]string{
				"mode":    "cloudagent-warm-runtime",
				"item_id": req.ItemID,
				"target":  target,
			},
		})
		createCh <- createResult{target: target, sb: sb, err: err}
	}
	go create("outer", backend.outerTemplateID)
	go create("inner", backend.innerTemplateID)
	var outer, inner RuntimeHostTarget
	var createErr error
	for i := 0; i < 2; i++ {
		res := <-createCh
		if res.err != nil {
			createErr = errors.Join(createErr, fmt.Errorf("create warm runtime %s sandbox: %w", res.target, res.err))
			continue
		}
		if res.target == "outer" {
			outer = res.sb
		} else {
			inner = res.sb
		}
	}
	if createErr != nil {
		_ = w.markWarmRuntimePoolItemFailed(ctx, req.ItemID, createErr)
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if outer.ID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, outer.ID)
		}
		if inner.ID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, inner.ID)
		}
		return WarmRuntimeItem{}, createErr
	}

	outerInstall := path.Join("/tmp/cloudagent-warm-runtime", req.ItemID, "outer", "install")
	innerInstall := path.Join("/tmp/cloudagent-warm-runtime", req.ItemID, "inner", "install")
	prepareCh := make(chan createResult, 2)
	go func() {
		clientPath, err := w.prepareWispHostOnly(ctx, backend.host, outer, outerInstall, w.wispPackageURL, "wisp_warm_outer_prepare")
		if err == nil {
			outerInstall = path.Dir(path.Dir(clientPath))
		}
		prepareCh <- createResult{target: "outer", err: err}
	}()
	go func() {
		clientPath, err := w.prepareWispHostOnly(ctx, backend.host, inner, innerInstall, w.wispPackageURL, "wisp_warm_inner_prepare")
		if err == nil {
			innerInstall = path.Dir(path.Dir(clientPath))
		}
		prepareCh <- createResult{target: "inner", err: err}
	}()
	var prepareErr error
	for i := 0; i < 2; i++ {
		res := <-prepareCh
		if res.err != nil {
			prepareErr = errors.Join(prepareErr, fmt.Errorf("prepare warm runtime %s host: %w", res.target, res.err))
		}
	}
	if prepareErr != nil {
		_ = w.markWarmRuntimePoolItemFailed(ctx, req.ItemID, prepareErr)
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if outer.ID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, outer.ID)
		}
		if inner.ID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, inner.ID)
		}
		return WarmRuntimeItem{}, prepareErr
	}
	host := WarmRuntimeHost{
		SandboxBackend:       backend.name,
		OuterTemplateID:      backend.outerTemplateID,
		InnerTemplateID:      backend.innerTemplateID,
		OuterSandboxID:       outer.ID,
		OuterSandboxDomain:   outer.Domain,
		OuterEnvdAccessToken: outer.EnvdAccessToken,
		OuterTrafficToken:    outer.TrafficAccessToken,
		InnerSandboxID:       inner.ID,
		InnerSandboxDomain:   inner.Domain,
		InnerEnvdAccessToken: inner.EnvdAccessToken,
		WispPackageURL:       w.wispPackageURL,
		OuterWispInstallDir:  outerInstall,
		OuterWispClientPath:  path.Join(outerInstall, "bin", "wispclient"),
		InnerWispInstallDir:  innerInstall,
		InnerWispClientPath:  path.Join(innerInstall, "bin", "wispclient"),
		AgentVersion:         normalizeRuntimeVersion(req.AgentVersion, defaultAgentVersion),
		WorkspaceVersion:     normalizeRuntimeVersion(req.WorkspaceVersion, defaultWorkspaceVersion),
	}
	item := WarmRuntimeItem{
		ItemID:    req.ItemID,
		PoolKey:   poolKey,
		State:     warmRuntimePoolStateReady,
		OwnerID:   req.OwnerID,
		Host:      host,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if store, ok := w.runtimePool.(WarmRuntimePoolStore); ok {
		if err := store.MarkWarmRuntimeItemReady(ctx, req.ItemID, host); err != nil {
			return WarmRuntimeItem{}, err
		}
	}
	fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_pool_item_ready item_id=%s pool_key=%s outer_sandbox_id=%s inner_sandbox_id=%s\n", item.ItemID, quoteTimelineField(item.PoolKey), outer.ID, inner.ID)
	return item, nil
}

func (w *AgentSidecarWorker) markWarmRuntimePoolItemFailed(ctx context.Context, itemID string, err error) error {
	if store, ok := w.runtimePool.(WarmRuntimePoolStore); ok && itemID != "" {
		return store.MarkWarmRuntimeItemState(ctx, itemID, warmRuntimePoolStateFailed, err.Error())
	}
	return nil
}
