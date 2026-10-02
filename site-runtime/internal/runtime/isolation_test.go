package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in real isolation acceptance. Runs only inside the dedicated Linux lab;
// it never falls back to host execution if runsc/image/cgroups are unavailable.
func TestRealRunscLifecycleAndIsolation(t *testing.T) {
	image := os.Getenv("WEBSITE_RUNTIME_TEST_IMAGE")
	if image == "" {
		t.Skip("requires explicit digest-pinned Linux/runsc test image")
	}
	t.Setenv("WEBSITE_RUNTIME_TEST_SENTINEL", "must-not-reach-worker")
	dir := t.TempDir()
	runner, err := NewDockerRunner(image, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Preflight(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	s, err := New(Options{DataDir: dir, DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: runner, Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	code := `export default {async fetch(r) {
 const p=new URL(r.url).pathname;
 if(p==='/api/loop') {while(true){}}
 if(p==='/api/network') {try {await fetch('http://169.254.169.254/');return Response.json({blocked:false})}catch{return Response.json({blocked:true})}}
 if(p==='/api/identity') return Response.json({hostEnvVisible:typeof process !== 'undefined' && process.env.WEBSITE_RUNTIME_TEST_SENTINEL !== undefined});
 const body=await r.json();return Response.json({sum:body.a+body.b});
 }};`
	sum := sha256.Sum256([]byte(code))
	bundle := Bundle{Code: code, SHA256: hex.EncodeToString(sum[:])}
	path := "/v1/sites/ws-lab/releases/wr-lab"
	rec := call(t, s, http.MethodPut, path, s.deployToken, bundle)
	if rec.Code != 201 {
		t.Fatalf("real deploy failed: %d %s", rec.Code, rec.Body.String())
	}
	invoke := func(method, path string, body []byte) *Result {
		t.Helper()
		rec := call(t, s, "POST", "/v1/sites/ws-lab/releases/wr-lab/invoke", s.invokeToken, Invocation{SHA256: bundle.SHA256, Method: method, Path: path, Body: body})
		if rec.Code != 200 {
			t.Fatalf("invoke %s: %d %s", path, rec.Code, rec.Body.String())
		}
		var result Result
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return &result
	}
	if got := invoke("POST", "/api/sum", []byte(`{"a":4,"b":8}`)); got.Status != 200 || string(got.Body) != `{"sum":12}` {
		t.Fatalf("actual JS POST failed: %+v", got)
	}
	if got := invoke("GET", "/api/network", nil); string(got.Body) != `{"blocked":true}` {
		t.Fatalf("metadata network access was not blocked: %s", got.Body)
	}
	if got := invoke("GET", "/api/identity", nil); string(got.Body) != `{"hostEnvVisible":false}` {
		t.Fatalf("host environment exposed: %s", got.Body)
	}
	start := time.Now()
	rec = call(t, s, "POST", path+"/invoke", s.invokeToken, Invocation{SHA256: bundle.SHA256, Method: "GET", Path: "/api/loop"})
	if rec.Code != 502 || time.Since(start) > 17*time.Second {
		t.Fatalf("infinite loop not bounded: status=%d elapsed=%s", rec.Code, time.Since(start))
	}
	// After forced termination the same revision must still serve a new request.
	if got := invoke("POST", "/api/sum", []byte(`{"a":1,"b":2}`)); string(got.Body) != `{"sum":3}` {
		t.Fatal("runtime did not recover after timeout")
	}
	rec = call(t, s, "DELETE", path, s.deployToken, nil)
	if rec.Code != 204 {
		t.Fatal("delete failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := dockerCommand(ctx, "ps", "-aq", "--filter", "label=lightvela.website-runtime="+runner.owner)
	if err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("orphan runtime containers remain: %v", err)
	}
}
