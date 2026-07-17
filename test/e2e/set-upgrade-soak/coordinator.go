package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type generationResult struct {
	Index          int         `json:"index"`
	BatchID        string      `json:"batch_id"`
	FromGeneration int64       `json:"from_generation"`
	ToGeneration   int64       `json:"to_generation"`
	RouteRevision  int64       `json:"route_revision"`
	Duration       string      `json:"duration"`
	Load           windowStats `json:"load"`
}

type soakReport struct {
	Success          bool               `json:"success"`
	RunID            string             `json:"run_id"`
	TargetSetID      string             `json:"target_set_id"`
	TargetImage      string             `json:"target_image"`
	RequestedUsers   int                `json:"requested_users"`
	SSEUsers         int                `json:"sse_users"`
	RequestedChanges int                `json:"requested_generations"`
	CompletedChanges int                `json:"completed_generations"`
	StartedAt        time.Time          `json:"started_at"`
	FinishedAt       time.Time          `json:"finished_at"`
	Generations      []generationResult `json:"generations"`
	Error            string             `json:"error,omitempty"`
}

type coordinator struct {
	cfg      config
	admin    apiClient
	internal apiClient
	kube     kubeClient
	report   soakReport
}

func newCoordinator(cfg config, kube kubeClient) *coordinator {
	return &coordinator{
		cfg: cfg, admin: newAPIClient(cfg.ControlURL, cfg.AdminToken),
		internal: newAPIClient(cfg.ControlURL, cfg.InternalToken), kube: kube,
		report: soakReport{
			RunID: cfg.RunID, TargetSetID: cfg.TargetSetID, TargetImage: cfg.TargetImage,
			RequestedUsers: cfg.Users, SSEUsers: cfg.SSEUsers,
			RequestedChanges: cfg.Generations, StartedAt: time.Now().UTC(),
		},
	}
}

func (c *coordinator) run(ctx context.Context) (soakReport, error) {
	cron, err := c.kube.cronJob(ctx, c.cfg.Namespace, c.cfg.ManagerCronJob)
	if err != nil {
		return c.fail(err)
	}
	wasSuspended := cron.Spec.Suspend != nil && *cron.Spec.Suspend
	if !wasSuspended {
		if err := c.kube.setCronJobSuspended(ctx, c.cfg.Namespace, c.cfg.ManagerCronJob, true); err != nil {
			return c.fail(fmt.Errorf("suspend set-manager cronjob: %w", err))
		}
		defer func() {
			restoreCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := c.kube.setCronJobSuspended(restoreCtx, c.cfg.Namespace, c.cfg.ManagerCronJob, false); err != nil {
				log.Printf("restore set-manager cronjob: %v", err)
			}
		}()
	}

	sets, err := c.readySets(ctx)
	if err != nil {
		return c.fail(err)
	}
	if err := c.prepareChannel(ctx, sets); err != nil {
		return c.fail(err)
	}
	users, err := c.prepareUsers(ctx, sets)
	if err != nil {
		return c.fail(err)
	}

	loadCtx, cancelLoad := context.WithCancel(ctx)
	load := newLoadController(c.cfg, users)
	load.start(loadCtx)
	defer func() {
		cancelLoad()
		load.stopAndWait()
	}()
	log.Printf("soak load started: users=%d sse=%d warmup=%s", len(users), c.cfg.SSEUsers, c.cfg.Warmup)
	if !waitContext(ctx, c.cfg.Warmup) {
		return c.fail(ctx.Err())
	}

	for index := 1; index <= c.cfg.Generations; index++ {
		load.setPhase(index)
		result, err := c.runGeneration(ctx, index, load)
		if err != nil {
			return c.fail(err)
		}
		c.report.Generations = append(c.report.Generations, result)
		c.report.CompletedChanges++
		log.Printf("generation %d/%d completed: runtime=%d route_revision=%d load=%d+%d",
			index, c.cfg.Generations, result.ToGeneration, result.RouteRevision,
			result.Load.NormalTotal, result.Load.SSETotal)
	}
	c.report.Success = true
	c.report.FinishedAt = time.Now().UTC()
	return c.report, nil
}

func (c *coordinator) readySets(ctx context.Context) ([]managedSet, error) {
	sets, err := c.admin.listSets(ctx)
	if err != nil {
		return nil, err
	}
	ready := make([]managedSet, 0, len(sets))
	targetFound := false
	for _, set := range sets {
		if set.Status != "active" || !set.Setup || set.AdminUserID <= 0 {
			continue
		}
		ready = append(ready, set)
		if set.ID == c.cfg.TargetSetID {
			targetFound = true
		}
	}
	if !targetFound {
		return nil, fmt.Errorf("target set %q is not active and ready", c.cfg.TargetSetID)
	}
	sort.Slice(ready, func(i, j int) bool {
		if ready[i].ID == c.cfg.TargetSetID {
			return true
		}
		if ready[j].ID == c.cfg.TargetSetID {
			return false
		}
		return ready[i].ID < ready[j].ID
	})
	if len(ready) > c.cfg.MaxLoadSets {
		ready = ready[:c.cfg.MaxLoadSets]
	}
	return ready, nil
}

func (c *coordinator) prepareChannel(ctx context.Context, sets []managedSet) error {
	if err := waitHTTPReady(ctx, c.cfg.PacerPublicURL+"/healthz", 2*time.Minute); err != nil {
		return fmt.Errorf("pacer service is not ready: %w", err)
	}
	if err := c.admin.upsertBundle(ctx, c.cfg); err != nil {
		return fmt.Errorf("save mock channel bundle: %w", err)
	}
	for _, set := range sets {
		if err := c.admin.applyBundle(ctx, c.cfg.BundleID, set.ID); err != nil {
			return fmt.Errorf("apply mock channel to %s: %w", set.ID, err)
		}
	}
	return nil
}

func (c *coordinator) prepareUsers(ctx context.Context, sets []managedSet) ([]loadUser, error) {
	users := make([]loadUser, c.cfg.Users)
	sem := make(chan struct{}, c.cfg.UserConcurrency)
	errCh := make(chan error, c.cfg.Users)
	var wg sync.WaitGroup
	for index := 0; index < c.cfg.Users; index++ {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			defer func() { <-sem }()
			setID := sets[index%len(sets)].ID
			isSSE := index < c.cfg.SSEUsers
			if isSSE {
				setID = c.cfg.TargetSetID
			}
			userID := fmt.Sprintf("upgrade-soak-%s-%04d", sanitizeID(c.cfg.RunID), index+1)
			if err := c.internal.assignUser(ctx, userID, setID); err != nil {
				errCh <- fmt.Errorf("assign user %s: %w", userID, err)
				return
			}
			key, err := c.admin.createKey(ctx, userID)
			if err != nil {
				errCh <- fmt.Errorf("create key for %s: %w", userID, err)
				return
			}
			if key.ExternalKey == "" || key.SetID != setID || key.UpstreamUserID == 0 {
				errCh <- fmt.Errorf("user %s returned incomplete or wrong Set key", userID)
				return
			}
			if err := c.admin.grantQuota(ctx, key, c.cfg.Quota); err != nil {
				errCh <- fmt.Errorf("grant quota for %s: %w", userID, err)
				return
			}
			users[index] = loadUser{ID: userID, SetID: setID, APIKey: key.ExternalKey, SSE: isSSE}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			return nil, err
		}
	}
	return users, nil
}

func (c *coordinator) runGeneration(ctx context.Context, index int, load *loadController) (generationResult, error) {
	started := time.Now()
	before, err := c.admin.set(ctx, c.cfg.TargetSetID)
	if err != nil {
		return generationResult{}, err
	}
	batch, err := c.admin.createUpgrade(ctx, c.cfg)
	if err != nil {
		return generationResult{}, fmt.Errorf("create generation %d upgrade: %w", index, err)
	}
	if len(batch.Runs) != 1 || batch.Runs[0].FromGeneration != before.ActiveRuntimeGeneration || batch.Runs[0].ToGeneration != before.ActiveRuntimeGeneration+1 {
		return generationResult{}, fmt.Errorf("generation %d returned unexpected upgrade run: %+v", index, batch.Runs)
	}
	jobName := fmt.Sprintf("llmgw-soak-g%d-%d", batch.Runs[0].ToGeneration, time.Now().Unix())
	_ = c.kube.deleteJob(ctx, c.cfg.Namespace, jobName)
	if err := c.kube.createManagerJob(ctx, c.cfg.Namespace, c.cfg.ManagerCronJob, jobName, c.cfg.ManagerProbeModel); err != nil {
		return generationResult{}, fmt.Errorf("create set-manager job: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.kube.deleteJob(cleanupCtx, c.cfg.Namespace, jobName)
	}()
	if err := c.kube.waitJob(ctx, c.cfg.Namespace, jobName, c.cfg.ManagerJobTimeout); err != nil {
		return generationResult{}, err
	}
	batch, err = c.admin.upgrade(ctx, batch.ID)
	if err != nil {
		return generationResult{}, err
	}
	if batch.Status != "completed" || len(batch.Runs) != 1 || batch.Runs[0].Status != "completed" {
		return generationResult{}, fmt.Errorf("upgrade %s ended batch=%s run=%+v", batch.ID, batch.Status, batch.Runs)
	}
	after, err := c.admin.set(ctx, c.cfg.TargetSetID)
	if err != nil {
		return generationResult{}, err
	}
	if err := validateGenerationTransition(before, after, batch.Runs[0].ToGeneration); err != nil {
		return generationResult{}, err
	}
	newDeployment := fmt.Sprintf("%s-%s-g%d-newapi-traffic", c.cfg.Fleet, c.cfg.TargetSetID, after.ActiveRuntimeGeneration)
	if err := c.kube.waitDeploymentReady(ctx, c.cfg.Namespace, newDeployment, c.cfg.TargetImage, 3*time.Minute); err != nil {
		return generationResult{}, err
	}
	oldDeployment := fmt.Sprintf("%s-%s-g%d-newapi-traffic", c.cfg.Fleet, c.cfg.TargetSetID, before.ActiveRuntimeGeneration)
	if before.ActiveRuntimeGeneration == 0 {
		oldDeployment = fmt.Sprintf("%s-%s-newapi-traffic", c.cfg.Fleet, c.cfg.TargetSetID)
	}
	if _, exists, err := c.kube.deployment(ctx, c.cfg.Namespace, oldDeployment); err != nil {
		return generationResult{}, err
	} else if exists {
		return generationResult{}, fmt.Errorf("old deployment %s still exists after drain", oldDeployment)
	}
	window := load.stats.window(index)
	if err := window.validate(c.cfg.NormalSuccessRate, c.cfg.SSESuccessRate, c.cfg.MinimumSSEDuration); err != nil {
		return generationResult{}, err
	}
	return generationResult{
		Index: index, BatchID: batch.ID,
		FromGeneration: before.ActiveRuntimeGeneration, ToGeneration: after.ActiveRuntimeGeneration,
		RouteRevision: after.RouteRevision, Duration: time.Since(started).Round(time.Second).String(), Load: window,
	}, nil
}

func (c *coordinator) fail(err error) (soakReport, error) {
	c.report.Success = false
	c.report.FinishedAt = time.Now().UTC()
	if err != nil {
		c.report.Error = err.Error()
	}
	return c.report, err
}

func waitHTTPReady(ctx context.Context, endpoint string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 5 * time.Second}
	var lastErr error
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := client.Do(req)
		if err == nil {
			_, _ = ioCopyDiscard(resp)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		if !waitContext(ctx, 2*time.Second) {
			return ctx.Err()
		}
	}
	return lastErr
}

func ioCopyDiscard(resp *http.Response) (int64, error) {
	return io.Copy(io.Discard, resp.Body)
}

func sanitizeID(value string) string {
	value = strings.ToLower(value)
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' {
			builder.WriteRune(char)
		}
	}
	result := strings.Trim(builder.String(), "-")
	if len(result) > 24 {
		result = result[:24]
	}
	if result == "" {
		return "run"
	}
	return result
}

func marshalReport(report soakReport) []byte {
	raw, _ := json.MarshalIndent(report, "", "  ")
	return raw
}
