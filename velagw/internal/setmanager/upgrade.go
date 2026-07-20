package setmanager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	upgradePending                = "pending"
	upgradeUpgradingMaster        = "upgrading_master"
	upgradeVerifyingCompatibility = "verifying_compatibility"
	upgradePreparing              = "preparing"
	upgradeProbing                = "probing"
	upgradeSwitching              = "switching"
	upgradeDraining               = "draining"
	upgradeRollbackSwitching      = "rollback_switching"
	upgradeRollbackDraining       = "rollback_draining"
	upgradeFailed                 = "failed"
)

func reconcileFleetUpgrade(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet) (LLMFleet, bool, error) {
	runs, err := control.SetUpgradeRuns(ctx, cfg.RequestLimit)
	if err != nil {
		return fleet, false, fmt.Errorf("list set upgrade runs: %w", err)
	}
	for _, candidate := range runs {
		if candidate.Source != cfg.Source || candidate.Namespace != cfg.Namespace || candidate.Fleet != cfg.Fleet {
			continue
		}
		owner := setUpgradeOwner(cfg, candidate.ID)
		leaseTTL := cfg.UpgradeLeaseTTL
		if leaseTTL <= 0 {
			leaseTTL = 90 * time.Second
		}
		run, claimed, err := control.ClaimSetUpgradeRun(ctx, candidate.ID, owner, int(leaseTTL.Seconds()))
		if err != nil {
			return fleet, false, fmt.Errorf("claim set upgrade %s: %w", candidate.ID, err)
		}
		if !claimed {
			continue
		}
		updated, err := executeSetUpgradeRunWithLeaseHeartbeat(ctx, cfg, control, kube, fleet, run, owner, leaseTTL)
		return updated, true, err
	}
	return fleet, false, nil
}

func executeSetUpgradeRunWithLeaseHeartbeat(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet, run SetUpgradeRun, owner string, leaseTTL time.Duration) (LLMFleet, error) {
	if leaseTTL <= 0 {
		leaseTTL = 90 * time.Second
	}
	interval := leaseTTL / 3
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	executeCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	heartbeatErr := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-executeCtx.Done():
				return
			case <-ticker.C:
				_, claimed, err := control.ClaimSetUpgradeRun(executeCtx, run.ID, owner, int(leaseTTL.Seconds()))
				if err == nil && claimed {
					continue
				}
				if err == nil {
					err = fmt.Errorf("upgrade run lease was lost")
				}
				select {
				case heartbeatErr <- err:
				default:
				}
				cancel()
				return
			}
		}
	}()
	updated, executeErr := executeSetUpgradeRun(executeCtx, cfg, control, kube, fleet, run, owner)
	cancel()
	<-done
	if executeErr != nil {
		select {
		case err := <-heartbeatErr:
			return updated, fmt.Errorf("upgrade lease heartbeat: %w", err)
		default:
		}
	}
	return updated, executeErr
}

func executeSetUpgradeRun(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet, run SetUpgradeRun, owner string) (LLMFleet, error) {
	probeInterval := cfg.ProbeInterval
	if probeInterval <= 0 {
		probeInterval = 10 * time.Second
	}
	probeTimeout := cfg.ProbeTimeout
	if probeTimeout <= 0 {
		probeTimeout = 3 * time.Minute
	}
	baseURL := setUpgradeRuntimeBaseURL(fleet.Metadata.Name, run.SetID, run.ToGeneration)
	if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
		return fleet, err
	}
	if run.Status == upgradeUpgradingMaster {
		changed, err := ApplySetUpgradeMasterToFleet(&fleet, run)
		if err != nil {
			return fleet, err
		}
		if changed {
			if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
				_, _ = control.SetUpgradeAction(context.WithoutCancel(ctx), run.ID, "master-complete", owner, false, err.Error(), "")
				return fleet, err
			}
			fleet, err = kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
			if err != nil {
				_, _ = control.SetUpgradeAction(context.WithoutCancel(ctx), run.ID, "master-complete", owner, false, err.Error(), "")
				return fleet, err
			}
		}
		run, err = control.SetUpgradeAction(ctx, run.ID, "master-complete", owner, true, "", "")
		if err != nil {
			return fleet, err
		}
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
	}
	if run.Status == upgradeVerifyingCompatibility {
		credential, err := control.SetUpgradeProbeCredential(ctx, run.ID, owner)
		if err != nil {
			return fleet, fmt.Errorf("get compatibility probe credential: %w", err)
		}
		currentBaseURL := setUpgradeCurrentTrafficBaseURL(fleet.Metadata.Name, run.SetID, run.FromGeneration)
		var probeErr error
		for attempt := 0; attempt < 3; attempt++ {
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			probeErr = ProbeSetUpgradeRuntime(probeCtx, nil, currentBaseURL, credential.UpstreamKey, cfg.ProbeModel)
			cancel()
			if probeErr != nil {
				break
			}
		}
		if probeErr != nil {
			_, _ = control.CompleteSetUpgradeCompatibility(context.WithoutCancel(ctx), run.ID, owner, false, probeErr.Error())
			return fleet, fmt.Errorf("old traffic is incompatible with migrated schema: %w", probeErr)
		}
		run, err = control.CompleteSetUpgradeCompatibility(ctx, run.ID, owner, true, "")
		if err != nil {
			return fleet, err
		}
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
	}
	var credential SetUpgradeProbeCredential
	if run.Status == upgradePreparing {
		var changed bool
		var err error
		baseURL, changed, err = ApplySetUpgradeCandidateToFleet(&fleet, run)
		if err != nil {
			return fleet, err
		}
		if changed {
			if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
				return fleet, fmt.Errorf("create green runtime: %w", err)
			}
			fleet, err = kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
			if err != nil {
				return fleet, fmt.Errorf("wait green runtime ready: %w", err)
			}
		}
		if err := WaitSetUpgradeRuntimeReady(ctx, nil, baseURL, probeTimeout, probeInterval); err != nil {
			return fleet, fmt.Errorf("wait green runtime endpoint: %w", err)
		}
		credential, err = control.SetUpgradeProbeCredential(ctx, run.ID, owner)
		if err != nil {
			return fleet, fmt.Errorf("get upgrade probe credential: %w", err)
		}
		if err := WaitSetUpgradeRuntimeFunctionalReady(ctx, nil, baseURL, credential.UpstreamKey, cfg.ProbeModel, probeTimeout, probeInterval); err != nil {
			return fleet, fmt.Errorf("wait green runtime functional readiness: %w", err)
		}
		run, err = control.PrepareSetUpgradeCandidate(ctx, run.ID, owner, baseURL)
		if err != nil {
			return fleet, err
		}
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
	}

	if (run.Status == upgradeProbing || run.Status == upgradeDraining) && credential.UpstreamKey == "" {
		var err error
		credential, err = control.SetUpgradeProbeCredential(ctx, run.ID, owner)
		if err != nil {
			return fleet, fmt.Errorf("get upgrade probe credential: %w", err)
		}
	}
	for run.Status == upgradeProbing {
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		probeErr := ProbeSetUpgradeRuntime(probeCtx, nil, baseURL, credential.UpstreamKey, cfg.ProbeModel)
		cancel()
		lastError := ""
		if probeErr != nil {
			lastError = probeErr.Error()
		}
		var err error
		run, err = control.RecordSetUpgradeProbe(ctx, run.ID, owner, probeErr == nil, lastError)
		if err != nil {
			return fleet, err
		}
		if run.Status == upgradeFailed {
			_, _ = RetireSetUpgradeRuntimeFromFleet(&fleet, run, true)
			_ = kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes)
			return fleet, fmt.Errorf("green runtime failed probes: %s", run.LastError)
		}
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
		if run.Status == upgradeProbing {
			if err := sleepContext(ctx, probeInterval); err != nil {
				return fleet, err
			}
		}
	}
	if run.Status == upgradeSwitching && run.SwitchedAt.IsZero() {
		var err error
		run, err = control.SetUpgradeAction(ctx, run.ID, "switch", owner, true, "", "")
		if err != nil {
			return fleet, fmt.Errorf("publish green route: %w", err)
		}
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
	}
	if run.Status == upgradeSwitching || run.Status == upgradeRollbackSwitching {
		// MySQL already switched, but the Redis outbox has not been confirmed yet.
		return fleet, nil
	}
	if run.Status == upgradeDraining {
		if err := holdUpgradeAtRegressionPoint(ctx, cfg, run.Status); err != nil {
			return fleet, err
		}
		if credential.UpstreamKey == "" {
			var err error
			credential, err = control.SetUpgradeProbeCredential(ctx, run.ID, owner)
			if err != nil {
				return fleet, err
			}
		}
		for !run.RollbackDeadline.IsZero() && time.Now().Before(run.RollbackDeadline) {
			if run.RollbackRequested {
				var err error
				run, err = control.SetUpgradeAction(ctx, run.ID, "rollback", owner, false, "", run.RollbackReason)
				if err != nil {
					return fleet, err
				}
				break
			}
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			probeErr := ProbeSetUpgradeRuntime(probeCtx, nil, baseURL, credential.UpstreamKey, cfg.ProbeModel)
			cancel()
			lastError := ""
			if probeErr != nil {
				lastError = probeErr.Error()
			}
			var err error
			run, err = control.RecordSetUpgradeProbe(ctx, run.ID, owner, probeErr == nil, lastError)
			if err != nil {
				return fleet, err
			}
			if run.Status != upgradeDraining {
				break
			}
			if err := sleepUntilOrInterval(ctx, run.RollbackDeadline, probeInterval); err != nil {
				return fleet, err
			}
		}
	}
	if run.Status == upgradeRollbackSwitching {
		return fleet, nil
	}
	if run.Status == upgradeDraining || run.Status == upgradeRollbackDraining {
		if err := sleepUntil(ctx, run.DrainDeadline); err != nil {
			return fleet, err
		}
		rollback := run.Status == upgradeRollbackDraining
		changed, err := RetireSetUpgradeRuntimeFromFleet(&fleet, run, rollback)
		if err != nil {
			return fleet, err
		}
		if changed {
			if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
				return fleet, fmt.Errorf("retire drained runtime: %w", err)
			}
			fleet, err = kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
			if err != nil {
				return fleet, err
			}
		}
		run, err = control.SetUpgradeAction(ctx, run.ID, "drain-complete", owner, true, "", "")
		if err != nil {
			return fleet, err
		}
	}
	return fleet, nil
}

func holdUpgradeAtRegressionPoint(ctx context.Context, cfg Config, status string) error {
	if cfg.RegressionHoldUpgradeStatus == "" || cfg.RegressionHoldUpgradeStatus != status {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func WaitSetUpgradeRuntimeFunctionalReady(ctx context.Context, client *http.Client, baseURL, upstreamKey, model string, timeout, interval time.Duration) error {
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	if interval <= 0 {
		interval = 3 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		probeCtx, cancel := context.WithTimeout(ctx, timeout)
		lastErr = ProbeSetUpgradeRuntime(probeCtx, client, baseURL, upstreamKey, model)
		cancel()
		if lastErr == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return lastErr
		}
		if err := sleepContext(ctx, interval); err != nil {
			return err
		}
	}
}

func WaitSetUpgradeRuntimeReady(ctx context.Context, client *http.Client, baseURL string, timeout, interval time.Duration) error {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return fmt.Errorf("runtime url is required")
	}
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	if interval <= 0 {
		interval = 3 * time.Second
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/status", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			return lastErr
		}
		if err := sleepContext(ctx, interval); err != nil {
			return err
		}
	}
}

func setUpgradeRuntimeBaseURL(fleet, setID string, generation int64) string {
	return fmt.Sprintf("http://%s-%s-g%d-newapi-traffic:3000", fleet, setID, generation)
}

func setUpgradeCurrentTrafficBaseURL(fleet, setID string, generation int64) string {
	if generation <= 0 {
		return fmt.Sprintf("http://%s-%s-newapi-traffic:3000", fleet, setID)
	}
	return setUpgradeRuntimeBaseURL(fleet, setID, generation)
}

func setUpgradeOwner(cfg Config, runID string) string {
	if cfg.RegressionUpgradeOwner != "" {
		return cfg.RegressionUpgradeOwner
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "set-manager"
	}
	return fmt.Sprintf("%s/%s/%d", host, runID, os.Getpid())
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func sleepUntil(ctx context.Context, deadline time.Time) error {
	return sleepContext(ctx, time.Until(deadline))
}

func sleepUntilOrInterval(ctx context.Context, deadline time.Time, interval time.Duration) error {
	remaining := time.Until(deadline)
	if remaining < interval {
		interval = remaining
	}
	return sleepContext(ctx, interval)
}

func ApplySetUpgradeCandidateToFleet(fleet *LLMFleet, run SetUpgradeRun) (string, bool, error) {
	if fleet == nil {
		return "", false, fmt.Errorf("fleet is required")
	}
	set, ok := llmFleetSetByName(fleet, run.SetID)
	if !ok {
		return "", false, fmt.Errorf("set %q is not present in fleet", run.SetID)
	}
	if strings.TrimSpace(run.TargetImage) == "" || run.ToGeneration <= run.FromGeneration {
		return "", false, fmt.Errorf("invalid upgrade runtime for set %q", run.SetID)
	}
	serviceName := fmt.Sprintf("%s-%s-g%d-newapi-traffic", fleet.Metadata.Name, run.SetID, run.ToGeneration)
	baseURL := "http://" + serviceName + ":3000"
	for index := range fleet.Spec.TrafficRuntimes {
		runtime := &fleet.Spec.TrafficRuntimes[index]
		if runtime.SetID != run.SetID || runtime.Generation != run.ToGeneration {
			continue
		}
		if runtime.Image != run.TargetImage {
			return "", false, fmt.Errorf("runtime generation %d for set %q already uses a different image", run.ToGeneration, run.SetID)
		}
		return baseURL, false, nil
	}
	replicas := set.Replicas
	if replicas <= 0 {
		replicas = 1
	}
	fleet.Spec.TrafficRuntimes = append(fleet.Spec.TrafficRuntimes, LLMFleetTrafficRuntime{
		SetID: run.SetID, Generation: run.ToGeneration, Image: run.TargetImage, Replicas: replicas,
	})
	return baseURL, true, nil
}

func RetireSetUpgradeRuntimeFromFleet(fleet *LLMFleet, run SetUpgradeRun, rollback bool) (bool, error) {
	if fleet == nil {
		return false, fmt.Errorf("fleet is required")
	}
	retired := run.FromGeneration
	if rollback {
		retired = run.ToGeneration
	}
	if retired == 0 {
		for index := range fleet.Spec.Sets {
			if fleet.Spec.Sets[index].Name != run.SetID {
				continue
			}
			if fleet.Spec.Sets[index].LegacyTrafficEnabled != nil && !*fleet.Spec.Sets[index].LegacyTrafficEnabled {
				return false, nil
			}
			disabled := false
			fleet.Spec.Sets[index].LegacyTrafficEnabled = &disabled
			return true, nil
		}
		return false, fmt.Errorf("set %q is not present in fleet", run.SetID)
	}
	changed := false
	kept := fleet.Spec.TrafficRuntimes[:0]
	for _, runtime := range fleet.Spec.TrafficRuntimes {
		if runtime.SetID == run.SetID && runtime.Generation == retired {
			changed = true
			continue
		}
		kept = append(kept, runtime)
	}
	fleet.Spec.TrafficRuntimes = kept
	return changed, nil
}

func ApplySetUpgradeMasterToFleet(fleet *LLMFleet, run SetUpgradeRun) (bool, error) {
	if fleet == nil {
		return false, fmt.Errorf("fleet is required")
	}
	for index := range fleet.Spec.Sets {
		if fleet.Spec.Sets[index].Name != run.SetID {
			continue
		}
		if fleet.Spec.Sets[index].AdminImage == run.TargetImage {
			return false, nil
		}
		fleet.Spec.Sets[index].AdminImage = run.TargetImage
		return true, nil
	}
	return false, fmt.Errorf("set %q is not present in fleet", run.SetID)
}

func llmFleetSetByName(fleet *LLMFleet, setID string) (LLMFleetSet, bool) {
	for _, set := range fleet.Spec.Sets {
		if set.Name == setID {
			return set, true
		}
	}
	return LLMFleetSet{}, false
}

func ProbeSetUpgradeRuntime(ctx context.Context, client *http.Client, baseURL, upstreamKey, model string) error {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || strings.TrimSpace(upstreamKey) == "" {
		return fmt.Errorf("runtime url and probe key are required")
	}
	if strings.TrimSpace(model) == "" {
		model = "auto"
	}
	if client == nil {
		client = http.DefaultClient
	}
	if err := probeHTTPStatus(ctx, client, http.MethodGet, baseURL+"/api/status", "", nil); err != nil {
		return fmt.Errorf("status probe: %w", err)
	}
	body, err := json.Marshal(map[string]any{
		"model": model, "stream": false,
		"messages": []map[string]string{{"role": "user", "content": "reply with ok"}},
	})
	if err != nil {
		return err
	}
	return probeHTTPStatus(ctx, client, http.MethodPost, baseURL+"/v1/chat/completions", upstreamKey, body)
}

func probeHTTPStatus(ctx context.Context, client *http.Client, method, target, upstreamKey string, body []byte) error {
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if upstreamKey != "" {
		request.Header.Set("Authorization", "Bearer "+upstreamKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("status=%d body=%s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}
