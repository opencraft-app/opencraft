package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeTransactionStageNeverActivates(t *testing.T) {
	requests := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/versions") {
			t.Error("stage mutated active state")
			w.WriteHeader(500)
			return
		}
		var p minisandboxPackage
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.MainModule != "main.js" {
			t.Error("invalid staged source")
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "v_" + strings.Repeat("a", 64)})
	}))
	defer upstream.Close()
	c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	pkg, err := c.Stage(context.Background(), "ws-owner", map[string]Bundle{"wr-one": fixture()})
	expected, _ := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	if err != nil || pkg.VersionID != "v_"+strings.Repeat("a", 64) || pkg.PackageID != expected.PackageID {
		t.Fatalf("stage failed %v %+v", err, pkg)
	}
	if len(requests) != 1 {
		t.Fatalf("stage requests: %v", requests)
	}
}

func TestNativeTransactionActivationOwnership(t *testing.T) {
	for _, status := range []int{http.StatusCreated, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			version := "v_" + strings.Repeat("b", 64)
			old := "d_" + strings.Repeat("c", 32)
			next := "d_" + strings.Repeat("d", 32)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/deployments") {
					t.Error("unexpected native activation call")
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["expected_deployment_id"] != old || body["version_id"] != version {
					t.Error("CAS intent changed")
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(minisandboxDeployment{ID: next, Versions: []minisandboxTarget{{VersionID: version, Percentage: 100}}})
			}))
			defer upstream.Close()
			c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
			before := DeploymentState{Exists: true, ID: old, Targets: []minisandboxTarget{{VersionID: "v_" + strings.Repeat("e", 64), Percentage: 100}}}
			result, err := c.ActivateCAS(context.Background(), "ws-owner", before, version)
			expected := ActivationOwned
			if status == 200 {
				expected = ActivationBorrowed
			}
			if err != nil || result.Ownership != expected || result.HTTPStatus != status || result.Deployment.ID != next {
				t.Fatalf("unsafe activation ownership: %+v %v", result, err)
			}
		})
	}
}

func TestNativeTransactionRestoreAbsentDoesNotDeleteStorage(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		t.Error("absent restore mutated native storage")
	}))
	defer upstream.Close()
	c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	_, err := c.RestoreCAS(context.Background(), "ws-owner", "d_"+strings.Repeat("a", 32), DeploymentState{})
	if err == nil || requests != 0 {
		t.Fatalf("first deployment must retain pending commit policy, got err=%v requests=%d", err, requests)
	}
}

func TestNativeTransactionVerifyFencesExactDeploymentIdentity(t *testing.T) {
	expected := DeploymentState{Exists: true, ID: "d_" + strings.Repeat("a", 32), Targets: []minisandboxTarget{{VersionID: "v_" + strings.Repeat("b", 64), Percentage: 100}}}
	p, _ := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	snapshots := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/deployment") {
			snapshots++
			id := expected.ID
			if snapshots > 1 {
				id = "d_" + strings.Repeat("c", 32)
			}
			_ = json.NewEncoder(w).Encode(minisandboxDeployment{ID: id, Versions: expected.Targets})
			return
		}
		if r.Header.Get("X-Workers-Original-URL") != "https://website.invalid/__platform_prepare" {
			t.Error("verification entered app handler")
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"package_id": p.PackageID})
	}))
	defer upstream.Close()
	c, _ := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
	err := c.VerifyPrepared(context.Background(), "ws-owner", expected, p.PackageID)
	if err == nil || snapshots != 2 {
		t.Fatalf("pointer race was not fenced: snapshots=%d err=%v", snapshots, err)
	}
}
