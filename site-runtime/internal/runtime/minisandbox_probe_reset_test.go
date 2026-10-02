package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMinisandboxDurableProbeResetsRetainedStaleClass(t *testing.T) {
	probes := 0
	target, old := strings.Repeat("a", 64), strings.Repeat("b", 64)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || !strings.Contains(r.URL.Path, "/objects/") || !strings.HasSuffix(r.URL.Path, "/fetch") || r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/__platform_prepare" {
			t.Errorf("application/non-control request issued: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		probes++
		switch probes {
		case 1:
			if r.Header.Get("X-Lightvela-Expected-Package-ID") != "" {
				t.Error("reset armed without observed legitimate stale package")
			}
			json.NewEncoder(w).Encode(map[string]string{"package_id": old})
		case 2:
			if r.Header.Get("X-Lightvela-Expected-Package-ID") != target {
				t.Error("no immutable target on private stale-class reset")
			}
			w.WriteHeader(500)
		default:
			json.NewEncoder(w).Encode(map[string]string{"package_id": target})
		}
	}))
	defer upstream.Close()
	c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	if err := c.verifyDurablePackage(context.Background(), "ws-owner", target); err != nil {
		t.Fatalf("bounded reset did not converge: %v", err)
	}
	if probes != 3 {
		t.Fatalf("expected read/reset/exact-read, got %d probes", probes)
	}
}
func TestMinisandboxControlProbeDoesNotTreatUnarmedFailureAsReset(t *testing.T) {
	for _, durable := range []bool{false, true} {
		t.Run(map[bool]string{false: "stateless", true: "durable"}[durable], func(t *testing.T) {
			probes := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				probes++
				if r.Header.Get("X-Lightvela-Expected-Package-ID") != "" {
					t.Error("unexpected reset capability")
				}
				w.WriteHeader(500)
			}))
			defer upstream.Close()
			c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
			var err error
			if durable {
				err = c.verifyDurablePackage(context.Background(), "ws-owner", strings.Repeat("a", 64))
			} else {
				err = c.verifyPrivatePackage(context.Background(), "/v1/workers/fixture/dispatch", strings.Repeat("a", 64))
			}
			if err == nil || probes != 1 {
				t.Fatalf("unarmed failure replayed/accepted: probes=%d err=%v", probes, err)
			}
		})
	}
}
func TestNativeLegacyVerifyFencesCompetitionAfterProbe(t *testing.T) {
	version, pkg := "v_"+strings.Repeat("c", 64), strings.Repeat("e", 64)
	changed := false
	stateless, durable := 0, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/deployment"):
			id := "d_" + strings.Repeat("a", 32)
			if changed {
				id = "d_" + strings.Repeat("b", 32)
			}
			json.NewEncoder(w).Encode(map[string]any{"id": id, "versions": []minisandboxTarget{{VersionID: version, Percentage: 100}}})
		case strings.HasSuffix(r.URL.Path, "/dispatch"):
			stateless++
			json.NewEncoder(w).Encode(map[string]string{"package_id": pkg})
		case strings.Contains(r.URL.Path, "/objects/") && strings.HasSuffix(r.URL.Path, "/fetch"):
			durable++
			changed = true
			json.NewEncoder(w).Encode(map[string]string{"package_id": pkg})
		default:
			t.Errorf("unexpected app/SQL request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	if err := c.Verify(context.Background(), "ws-owner", version, pkg); err == nil {
		t.Error("legacy verifier accepted changed deployment pointer")
	}
	if stateless != 1 || durable != 1 {
		t.Errorf("legacy verifier omitted control fence: stateless=%d durable=%d", stateless, durable)
	}
}
