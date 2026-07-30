package clients

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestControlClientUsesSeparateAdminAndInternalTokens(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/internal/users/user-1/assignment", "/api/internal/users/ensure":
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":"created"}}`))
		case "/api/internal/subscriptions/apply":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"sub-1","user_id":"user-1","plan_id":"regression-monthly","status":"active","set_id":"set-a"}}`))
		case "/api/admin/tenants/user-1":
			_, _ = w.Write([]byte(`{"success":true,"data":{"tenant":{"external_user_id":"user-1"},"binding":{"set_id":"set-a","upstream_user_id":42},"assignment":{"set_id":"set-a","backend":"new"}}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	sanitizer := framework.NewSanitizer()
	client := NewControlClient(server.URL, sanitizer.Secret("admin-token"), sanitizer.Secret("internal-token"), server.Client(), sanitizer)
	if err := client.AssignTenant(t.Context(), "user-1", "set-a"); err != nil {
		t.Fatal(err)
	}
	if err := client.EnsureTenant(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ApplySubscription(t.Context(), "user-1", "regression-monthly", "run-1"); err != nil {
		t.Fatal(err)
	}
	detail, err := client.TenantDetail(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Binding.SetID != "set-a" || detail.Binding.UpstreamUserID != 42 {
		t.Fatalf("detail = %+v", detail)
	}
	want := []string{
		"POST /api/internal/users/user-1/assignment Bearer internal-token",
		"POST /api/internal/users/ensure Bearer internal-token",
		"POST /api/internal/subscriptions/apply Bearer internal-token",
		"GET /api/admin/tenants/user-1 Bearer admin-token",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestControlClientQueuesAndListsWorkerJobRuns(t *testing.T) {
	watermark := time.Date(2026, 7, 18, 8, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/admin/jobs/refresh_set_capacity/run":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"queued","job_name":"refresh_set_capacity","status":"queued","started_at":"2026-07-18T08:00:00Z"}}`))
		case "GET /api/admin/jobs":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"name":"refresh_set_capacity","status":"success","last_success_at":"2026-07-18T08:00:01Z","next_run_at":"2026-07-18T09:00:00Z"}]}`))
		case "GET /api/admin/jobs/refresh_set_capacity/runs":
			if r.URL.Query().Get("after") != watermark.Format(time.RFC3339Nano) || r.URL.Query().Get("limit") != "10" {
				t.Fatalf("query = %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"run-1","job_name":"refresh_set_capacity","owner":"worker/run-1","status":"success","started_at":"2026-07-18T08:00:01Z"}]}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()
	client := NewControlClient(server.URL, framework.Secret{}, framework.Secret{}, server.Client(), nil)

	queued, err := client.QueueWorkerJob(t.Context(), "refresh_set_capacity")
	if err != nil || queued.Status != "queued" {
		t.Fatalf("queued=%+v err=%v", queued, err)
	}
	job, err := client.WorkerJob(t.Context(), "refresh_set_capacity")
	if err != nil || job.Name != "refresh_set_capacity" {
		t.Fatalf("job=%+v err=%v", job, err)
	}
	runs, err := client.WorkerJobRuns(t.Context(), "refresh_set_capacity", watermark, 10)
	if err != nil || len(runs) != 1 || runs[0].Owner == "" {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
}

func TestControlClientDeletesTenantThroughPreviewStartAndTerminalPoll(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/admin/tenant-deletions/preview":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"delete-1","status":"previewed","target_count":1,"target_digest":"digest-1"}}`))
		case "POST /api/admin/tenant-deletions/delete-1/start":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"delete-1","status":"running","target_count":1,"target_digest":"digest-1"}}`))
		case "GET /api/admin/tenant-deletions/delete-1":
			if polls.Add(1) < 2 {
				_, _ = w.Write([]byte(`{"success":true,"data":{"id":"delete-1","status":"running","target_count":1}}`))
			} else {
				_, _ = w.Write([]byte(`{"success":true,"data":{"id":"delete-1","status":"succeeded","target_count":1,"success_count":1}}`))
			}
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	sanitizer := framework.NewSanitizer()
	client := NewControlClient(server.URL, sanitizer.Secret("admin"), sanitizer.Secret("internal"), server.Client(), sanitizer)
	client.pollInterval = time.Millisecond
	if err := client.DeleteTenant(t.Context(), "reg-user", "cleanup-1", time.Second); err != nil {
		t.Fatal(err)
	}
	if polls.Load() != 2 {
		t.Fatalf("polls = %d", polls.Load())
	}
}

func TestControlClientLoadsDedicatedBundleAndDeliveryState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/channel-bundles":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"regression-mock-channel","fingerprint":"fp-1","spec":{"version":1,"kind":"newapi-channel-bundle","channels":[{"id":"regression","name":"Regression","type":1,"base_url":"http://llmgateway-regression-pacer:18082","models":"llmgw-regression-chat,llmgw-regression-long","group":"default","model_mapping":"{\"llmgw-regression-chat\":\"llmgw-mock-chat\",\"llmgw-regression-long\":\"llmgw-mock-chat\"}","status":"enabled","key_hash":"hash"}]}}]}`))
		case "/api/channel-bundles/regression-mock-channel/apply":
			_, _ = w.Write([]byte(`{"success":true,"data":{"bundle_id":"regression-mock-channel","set_id":"set-a","status":"synced","applied_fingerprint":"fp-1"}}`))
		case "/api/channel-bundles/regression-mock-channel/delivery-status":
			_, _ = w.Write([]byte(`{"success":true,"data":{"bundle_id":"regression-mock-channel","status":"synced","eligible_sets":1,"checked_sets":1,"sets":[{"set_id":"set-a","status":"synced"}]}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	sanitizer := framework.NewSanitizer()
	client := NewControlClient(server.URL, sanitizer.Secret("admin"), sanitizer.Secret("internal"), server.Client(), sanitizer)
	bundle, err := client.ChannelBundle(t.Context(), "regression-mock-channel")
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Spec.Options) != 0 || len(bundle.Spec.Channels) != 1 || bundle.Spec.Channels[0].BaseURL != "http://llmgateway-regression-pacer:18082" {
		t.Fatalf("bundle = %+v", bundle)
	}
	if _, err := client.ApplyChannelBundle(t.Context(), bundle.ID, "set-a"); err != nil {
		t.Fatal(err)
	}
	status, err := client.ChannelDeliveryStatus(t.Context(), bundle.ID)
	if err != nil || status.Status != "synced" || len(status.Sets) != 1 {
		t.Fatalf("status=%+v err=%v", status, err)
	}
}

func TestControlClientCreatesPollsAndRetriesSetUpgrade(t *testing.T) {
	var created bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/admin/set-upgrades":
			created = true
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"batch-1","status":"pending","runs":[{"id":"run-1","set_id":"set-a","status":"pending","from_generation":3,"to_generation":4}]}}`))
		case "GET /api/admin/set-upgrades/batch-1":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"batch-1","status":"failed","runs":[{"id":"run-1","set_id":"set-a","status":"failed","from_generation":3,"to_generation":4}]}}`))
		case "POST /api/admin/set-upgrade-runs/run-1/retry":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"run-1","set_id":"set-a","status":"pending","from_generation":3,"to_generation":4}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	sanitizer := framework.NewSanitizer()
	client := NewControlClient(server.URL, sanitizer.Secret("admin"), sanitizer.Secret("internal"), server.Client(), sanitizer)
	batch, err := client.CreateSetUpgrade(t.Context(), SetUpgradeInput{SetID: "set-a", TargetImage: "registry/new-api@sha256:abc", Source: "prod", Namespace: "llmgateway", Fleet: "prod"})
	if err != nil || !created || len(batch.Runs) != 1 {
		t.Fatalf("batch=%+v created=%v err=%v", batch, created, err)
	}
	batch, err = client.SetUpgrade(t.Context(), batch.ID)
	if err != nil || batch.Status != "failed" {
		t.Fatalf("batch=%+v err=%v", batch, err)
	}
	run, err := client.RetrySetUpgradeRun(t.Context(), batch.Runs[0].ID)
	if err != nil || run.Status != "pending" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
}
