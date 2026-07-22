package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAdmissionRecheckKeepsPreviouslyPassedSetAvailable(t *testing.T) {
	probeStarted := make(chan struct{})
	releaseProbe := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/setup" {
			http.NotFound(w, r)
			return
		}
		close(probeStarted)
		<-releaseProbe
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"status":true,"root_init":true}}`))
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive,
		Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token",
		AdmissionStatus: SetAdmissionStatusPassed, MaxUsers: 100,
	})
	svc := NewService(store, upstream.Client().Transport, Options{})
	checkDone := make(chan error, 1)
	go func() {
		_, err := svc.CheckSetAdmission(context.Background(), "set-a")
		checkDone <- err
	}()

	<-probeStarted
	reserved, err := store.TryReserveSetUserSlot(context.Background(), "set-a")
	close(releaseProbe)
	if err != nil {
		t.Fatal(err)
	}
	if !reserved {
		t.Fatal("previously passed Set stopped accepting users while its admission probe was running")
	}
	if err := <-checkDone; err != nil {
		t.Fatal(err)
	}
}
