package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

type renewRecordingStore struct {
	Store
	once    sync.Once
	renewed chan struct{}
}

func (s *renewRecordingStore) RenewBYOKSyncTaskLease(ctx context.Context, task BYOKSyncTask, ttl time.Duration, now time.Time) (bool, error) {
	renewed, err := s.Store.RenewBYOKSyncTaskLease(ctx, task, ttl, now)
	if renewed {
		s.once.Do(func() { close(s.renewed) })
	}
	return renewed, err
}

func TestRunAcquiredBYOKSyncTaskRenewsLease(t *testing.T) {
	base := NewMemoryStore()
	store := &renewRecordingStore{Store: base, renewed: make(chan struct{})}
	emitter, telemetryEvents := captureTelemetryEvents()
	svc := NewService(store, nil, Options{TelemetryEmitter: emitter})
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(t.Context(), BYOKSyncTask{ExternalUserID: "user-1", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireBYOKSyncTask(t.Context(), "user-1", "worker-a", 90*time.Millisecond, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v; want true", acquired, err)
	}

	err = svc.runAcquiredBYOKSyncTask(t.Context(), task, 90*time.Millisecond, func(ctx context.Context, userID string) error {
		select {
		case <-store.renewed:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
			return context.DeadlineExceeded
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	completed, ok, err := store.GetBYOKSyncTask(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("get task = %v, %v", ok, err)
	}
	if completed.Status != BYOKSyncTaskStatusSucceeded || completed.AppliedVersion != 1 {
		t.Fatalf("task was not completed after renewal: %+v", completed)
	}
	if len(*telemetryEvents) != 1 || (*telemetryEvents)[0].event.Name != "llmgateway.config.state_changed" {
		t.Fatalf("missing BYOK committed telemetry: %+v", *telemetryEvents)
	}
	requireTelemetryString(t, (*telemetryEvents)[0].event, "llmgateway.user.id", "user-1")
	requireTelemetryString(t, (*telemetryEvents)[0].event, "llmgateway.state.to", BYOKSyncTaskStatusSucceeded)
}

func TestSyncUserLLMProviderUsesPersistedRemoteChannelID(t *testing.T) {
	updated := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/channel/" {
			t.Fatalf("unexpected request %s %s; persisted ID must avoid search", r.Method, r.URL.Path)
		}
		var channel newapi.Channel
		decodeGatewayChannelJSON(t, r, &channel)
		if channel.ID != 42 {
			t.Fatalf("channel ID = %d, want 42", channel.ID)
		}
		updated = true
		writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": channel})
	}))
	defer upstream.Close()

	svc := NewService(NewMemoryStore(), upstream.Client().Transport, Options{})
	provider := UserLLMProvider{
		ID:              "private",
		Protocol:        LLMProviderProtocolOpenAICompatible,
		APIKey:          "sk-private",
		BaseURL:         "https://example.invalid/v1",
		Enabled:         true,
		RemoteChannelID: 42,
		ModelMappings:   map[string]string{"auto": "upstream-model"},
	}
	client := svc.newAPIClient(upstream.URL)
	if err := svc.syncUserLLMProvider(t.Context(), client, newapi.AdminAuth{UserID: 1, AccessToken: "admin"}, "user-1", "byok_user_1", 0, 1, &provider); err != nil {
		t.Fatal(err)
	}
	if !updated {
		t.Fatal("persisted remote channel was not updated")
	}
}

func TestBYOKWorkerReleasesClaimedTasksWhenShutdownInterruptsSetPreparation(t *testing.T) {
	requestStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("read request body: %v", err)
			return
		}
		select {
		case <-requestStarted:
		default:
			close(requestStarted)
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveBYOKSyncIntent(t.Context(), testBYOKSyncIntent("user-1", "set-a", true)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- svc.RunBYOKWorker(ctx, "worker-a", BYOKWorkerOptions{
			PollInterval: time.Millisecond, LeaseTTL: time.Minute, MaxConcurrency: 1, SetConcurrency: 1, CandidateBatch: 1,
		}, nil)
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("GroupRatio preparation did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("BYOK worker did not stop")
	}
	task, _, _ := store.GetBYOKSyncTask(t.Context(), "user-1")
	if task.Status != BYOKSyncTaskStatusPending || task.LeaseOwner != "" {
		t.Fatalf("shutdown left preflight task leased: %+v", task)
	}
}

func TestRunAcquiredBYOKSyncTaskReleasesLeaseOnShutdown(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Now().UTC()
	if _, err := store.EnqueueBYOKSyncTask(t.Context(), BYOKSyncTask{ExternalUserID: "user-1", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireBYOKSyncTask(t.Context(), "user-1", "worker-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v", acquired, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := svc.runAcquiredBYOKSyncTask(ctx, task, time.Minute, func(ctx context.Context, _ string) error { return ctx.Err() }); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown error = %v, want canceled", err)
	}
	released, _, _ := store.GetBYOKSyncTask(t.Context(), "user-1")
	if released.Status != BYOKSyncTaskStatusPending || released.LeaseOwner != "" || released.NextRunAt.After(time.Now().UTC()) {
		t.Fatalf("shutdown did not release task: %+v", released)
	}
}

func TestBYOKWorkerSkipsSaturatedSetCandidatePage(t *testing.T) {
	var remoteMu sync.Mutex
	remoteGroupRatio := `{"default":1}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		remoteMu.Lock()
		defer remoteMu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "GET /api/option/":
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": []map[string]any{{"key": "GroupRatio", "value": remoteGroupRatio}}})
		case "PUT /api/option/":
			var req struct {
				Value string `json:"value"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			remoteGroupRatio = req.Value
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	saveReadySet(t, store, "set-a", upstream.URL)
	saveReadySet(t, store, "set-b", upstream.URL)
	for _, setID := range []string{"set-a", "set-b"} {
		if _, err := store.ReplacePlatformGroupRatios(t.Context(), setID, "stable", map[string]float64{"default": 1}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC().Add(-time.Minute)
	for _, task := range []BYOKSyncTask{
		{ExternalUserID: "user-a-1", SetID: "set-a", NextRunAt: now},
		{ExternalUserID: "user-a-2", SetID: "set-a", NextRunAt: now.Add(time.Nanosecond)},
		{ExternalUserID: "user-b-1", SetID: "set-b", NextRunAt: now.Add(2 * time.Nanosecond)},
	} {
		intent := testBYOKSyncIntent(task.ExternalUserID, task.SetID, true)
		intent.Task.NextRunAt = task.NextRunAt
		if _, err := store.SaveBYOKSyncIntent(t.Context(), intent); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(t.Context())
	release := make(chan struct{})
	started := make(chan string, 2)
	done := make(chan error, 1)
	go func() {
		done <- svc.runBYOKWorker(ctx, "worker-a", BYOKWorkerOptions{
			PollInterval: time.Millisecond, LeaseTTL: time.Minute, MaxConcurrency: 2, SetConcurrency: 1, CandidateBatch: 1,
		}, func(ctx context.Context, userID string) error {
			started <- userID
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}, nil)
	}()
	t.Cleanup(func() {
		close(release)
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker stop: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("BYOK worker did not stop")
		}
	})

	seen := map[string]bool{}
	deadline := time.After(500 * time.Millisecond)
	for len(seen) < 2 {
		select {
		case userID := <-started:
			seen[userID] = true
		case <-deadline:
			t.Fatalf("started users = %v; saturated set-a candidate page blocked set-b", seen)
		}
	}
	if !seen["user-a-1"] || !seen["user-b-1"] {
		t.Fatalf("started users = %v, want one task from each Set", seen)
	}
}
