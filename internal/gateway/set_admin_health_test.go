package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSetAdminHealthRequiresTwoFailuresBeforeRemovingAdmission(t *testing.T) {
	healthy := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/user/search" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if !healthy {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{
			"id": 1, "username": "root", "role": 10, "status": 1, "group": "default",
		}}}})
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	set := Set{
		ID: "set-a", Name: "Set A", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminUsername: "root", AdminAccessToken: "admin-token", AdmissionStatus: SetAdmissionStatusPassed,
	}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	job := WorkerJob{Name: WorkerJobCheckSetAdminHealth}
	if _, _, err := svc.checkSetAdminHealthJob(t.Context(), &job); err == nil {
		t.Fatal("expected first failed probe to be reported")
	}
	set, _, _ = store.GetSet(t.Context(), "set-a")
	if set.AdminHealthStatus != SetAdminHealthDegraded || set.AdminHealthConsecutiveFailures != 1 {
		t.Fatalf("first failure state = %+v", set)
	}
	if !setReadyForServing(set) {
		t.Fatal("first transient health failure should not remove Set from admission")
	}

	if _, _, err := svc.checkSetAdminHealthJob(t.Context(), &job); err == nil {
		t.Fatal("expected second failed probe to be reported")
	}
	set, _, _ = store.GetSet(t.Context(), "set-a")
	if set.AdminHealthStatus != SetAdminHealthUnhealthy || set.AdminHealthConsecutiveFailures != 2 {
		t.Fatalf("second failure state = %+v", set)
	}
	if setReadyForServing(set) {
		t.Fatal("unhealthy Set remained eligible for new admission")
	}
	overview, err := svc.GetOperationalOverview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !overviewHasAlert(overview, "set_admin_unhealthy") {
		t.Fatalf("overview missing admin health alert: %+v", overview.Alerts)
	}

	healthy = true
	if _, _, err := svc.checkSetAdminHealthJob(t.Context(), &job); err != nil {
		t.Fatal(err)
	}
	set, _, _ = store.GetSet(t.Context(), "set-a")
	if set.AdminHealthStatus != SetAdminHealthHealthy || set.AdminHealthConsecutiveFailures != 0 || !setReadyForServing(set) {
		t.Fatalf("recovered state = %+v", set)
	}
}
