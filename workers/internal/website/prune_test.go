package website

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPruneDeletesOnlyReservedRevisionAndIsRetryable(t *testing.T) {
	for _, kind := range []string{"", "static", "fullstack"} {
		t.Run(kind, func(t *testing.T) {
			prefix := siteReleasePrefix("ws-1", "wr-old")
			active := siteReleasePrefix("ws-1", "wr-active")
			state := &fakeCOSState{objects: map[string]int64{prefix + "index.html": 10, active + "index.html": 20, siteArtifactKey("ws-1", "wr-old"): 30}}
			d, _ := newPublishTestDeployer(t, state)
			expiry := time.Now().Add(time.Hour)
			op := Operation{OperationID: "wo-prune", SiteID: "ws-1", ReleaseID: "wr-old", UserID: "owner", Kind: kind, OperationType: "prune_release", Status: "running", LeaseToken: "lease", LeaseExpiresAt: &expiry, SiteGeneration: 3, CurrentSiteGeneration: 3, ReleaseStatus: "pruning", ActiveReleaseID: "wr-active", ActiveCloudPath: active}
			completed := 0
			ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					json.NewEncoder(w).Encode(map[string]any{"data": op})
					return
				}
				if r.URL.Path == "/internal/ctl/websites/operations/wo-prune/complete" {
					completed++
					w.Write([]byte(`{"code":"OK"}`))
					return
				}
				t.Errorf("unexpected CTL request %s", r.URL.Path)
			}))
			defer ctl.Close()
			d.ctlBaseURL = ctl.URL
			deletes := 0
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "DELETE" || r.URL.Path != "/v1/sites/ws-1/releases/wr-old" {
					t.Errorf("unsafe runtime request %s %s", r.Method, r.URL.Path)
				}
				deletes++
				w.WriteHeader(204)
			}))
			defer runtime.Close()
			d.runtimeURL = runtime.URL
			d.runtimeToken = "test"
			for i := 0; i < 2; i++ {
				if err := d.Execute(op); err != nil {
					t.Fatal(err)
				}
			}
			if completed != 2 {
				t.Fatalf("completion count %d", completed)
			}
			if _, ok := state.objects[prefix+"index.html"]; ok {
				t.Fatal("reserved artifact retained")
			}
			if _, ok := state.objects[siteArtifactKey("ws-1", "wr-old")]; ok {
				t.Fatal("temporary artifact retained after cleanup")
			}
			if _, ok := state.objects[active+"index.html"]; !ok {
				t.Fatal("active artifact deleted")
			}
			if kind == "fullstack" && deletes != 2 {
				t.Fatal("backend not cleaned on retry")
			}
			if kind != "fullstack" && deletes != 0 {
				t.Fatal("static touched runtime")
			}
		})
	}
}

func TestPruneRejectsUnsafeSnapshots(t *testing.T) {
	expiry := time.Now().Add(time.Hour)
	base := Operation{OperationID: "wo-prune", SiteID: "ws-1", ReleaseID: "wr-old", UserID: "owner", Kind: "fullstack", OperationType: "prune_release", Status: "running", LeaseToken: "lease", LeaseExpiresAt: &expiry, SiteGeneration: 3, CurrentSiteGeneration: 3, ReleaseStatus: "pruning", ActiveReleaseID: "wr-active", ActiveCloudPath: siteReleasePrefix("ws-1", "wr-active")}
	cases := map[string]func(*Operation){
		"stolen lease":   func(o *Operation) { o.LeaseToken = "new" },
		"expired":        func(o *Operation) { v := time.Now().Add(-time.Second); o.LeaseExpiresAt = &v },
		"missing expiry": func(o *Operation) { o.LeaseExpiresAt = nil },
		"generation":     func(o *Operation) { o.CurrentSiteGeneration++ },
		"active target": func(o *Operation) {
			o.ActiveReleaseID = o.ReleaseID
			o.ActiveCloudPath = siteReleasePrefix(o.SiteID, o.ReleaseID)
		},
		"not reserved":  func(o *Operation) { o.ReleaseStatus = "superseded" },
		"completed":     func(o *Operation) { o.Status = "success" },
		"owner":         func(o *Operation) { o.UserID = "other" },
		"path mismatch": func(o *Operation) { o.ActiveCloudPath = "sites/ws-other/releases/wr-active/" },
		"unknown kind":  func(o *Operation) { o.Kind = "future" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			current := base
			mutate(&current)
			if err := validatePruneSnapshot(base, current); err == nil {
				t.Fatal("unsafe snapshot accepted")
			}
		})
	}
	for _, id := range []string{"../other", "", "a/b"} {
		current := base
		current.ReleaseID = id
		request := current
		if err := validatePruneSnapshot(request, current); err == nil {
			t.Fatal("unsafe path accepted")
		}
	}
}

// A worker may lose its authorization while a remote deletion is in flight.
// The target remains non-rollbackable, but subsequent stages must stop.
func TestPruneStopsAfterBackendWhenAuthorizationChanges(t *testing.T) {
	for _, change := range []string{"lease", "generation", "expiry"} {
		t.Run(change, func(t *testing.T) {
			prefix := siteReleasePrefix("ws-1", "wr-old")
			state := &fakeCOSState{objects: map[string]int64{prefix + "index.html": 10}}
			d, _ := newPublishTestDeployer(t, state)
			expiry := time.Now().Add(time.Hour)
			op := Operation{OperationID: "wo-prune", SiteID: "ws-1", ReleaseID: "wr-old", UserID: "owner", Kind: "fullstack", OperationType: "prune_release", Status: "running", LeaseToken: "lease", LeaseExpiresAt: &expiry, SiteGeneration: 3, CurrentSiteGeneration: 3, ReleaseStatus: "pruning", ActiveReleaseID: "wr-active", ActiveCloudPath: siteReleasePrefix("ws-1", "wr-active")}
			// Runtime completion synchronizes the mutation with the next CTL read.
			changed := make(chan struct{})
			ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Errorf("unauthorized callback %s", r.URL.Path)
					w.WriteHeader(409)
					return
				}
				current := op
				select {
				case <-changed:
					switch change {
					case "lease":
						current.LeaseToken = "replacement"
					case "generation":
						current.CurrentSiteGeneration++
					case "expiry":
						v := time.Now().Add(-time.Second)
						current.LeaseExpiresAt = &v
					}
				default:
				}
				json.NewEncoder(w).Encode(map[string]any{"data": current})
			}))
			defer ctl.Close()
			d.ctlBaseURL = ctl.URL
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(changed); w.WriteHeader(204) }))
			defer runtime.Close()
			d.runtimeURL = runtime.URL
			d.runtimeToken = "test"
			if err := d.Execute(op); err == nil {
				t.Fatal("continued with stale authorization")
			}
			if _, ok := state.objects[prefix+"index.html"]; !ok {
				t.Fatal("static deletion continued after authorization changed")
			}
		})
	}
}
