package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

type fakeRunner struct{ calls atomic.Int64 }

func (f *fakeRunner) Run(_ context.Context, _ string, in Invocation) (Result, error) {
	f.calls.Add(1)
	if in.Path == "/__platform_health" {
		return Result{Status: 204}, nil
	}
	return Result{Status: 200, Headers: map[string]string{"Content-Type": "application/json"}, Body: []byte(`{"ok":true}`)}, nil
}
func fixture() Bundle {
	code := "export default {fetch(){ return new Response('ok') }}"
	sum := sha256.Sum256([]byte(code))
	return Bundle{Code: code, SHA256: hex.EncodeToString(sum[:])}
}
func newTestService(t *testing.T) (*Service, *fakeRunner) {
	t.Helper()
	runner := &fakeRunner{}
	service, err := New(Options{DataDir: t.TempDir(), DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: runner, Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	return service, runner
}
func call(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
func TestImmutableBundleLifecycleAndCredentialSeparation(t *testing.T) {
	s, r := newTestService(t)
	path := "/v1/sites/ws-abc/releases/wr-abc"
	for _, token := range []string{"", "wrong", s.invokeToken} {
		if got := call(t, s, "PUT", path, token, fixture()).Code; got != 401 {
			t.Fatalf("unauthorized deploy=%d", got)
		}
	}
	if r.calls.Load() != 0 {
		t.Fatal("unauthorized request executed code")
	}
	if got := call(t, s, "PUT", path, s.deployToken, fixture()).Code; got != 201 {
		t.Fatalf("deploy=%d", got)
	}
	if got := call(t, s, "PUT", path, s.deployToken, fixture()).Code; got != 200 {
		t.Fatalf("idempotent deploy=%d", got)
	}
	if r.calls.Load() != 1 {
		t.Fatal("repeated deployment executed twice")
	}
	different := fixture()
	different.Code += ";"
	sum := sha256.Sum256([]byte(different.Code))
	different.SHA256 = hex.EncodeToString(sum[:])
	if got := call(t, s, "PUT", path, s.deployToken, different).Code; got != 409 {
		t.Fatalf("immutable conflict=%d", got)
	}
	in := Invocation{SHA256: fixture().SHA256, Method: "POST", Path: "/api/items", Body: []byte("hello")}
	if got := call(t, s, "POST", path+"/invoke", s.deployToken, in).Code; got != 401 {
		t.Fatalf("deploy token invoked=%d", got)
	}
	if got := call(t, s, "POST", path+"/invoke", s.invokeToken, in).Code; got != 200 {
		t.Fatalf("invoke=%d", got)
	}
	if got := call(t, s, "POST", "/v1/sites/ws-other/releases/wr-abc/invoke", s.invokeToken, in).Code; got != 404 {
		t.Fatalf("cross site=%d", got)
	}
	in.SHA256 = "0000000000000000000000000000000000000000000000000000000000000000"
	if got := call(t, s, "POST", path+"/invoke", s.invokeToken, in).Code; got != 409 {
		t.Fatalf("digest mismatch=%d", got)
	}
	if got := call(t, s, "DELETE", path, s.deployToken, nil).Code; got != 204 {
		t.Fatalf("delete=%d", got)
	}
	in.SHA256 = fixture().SHA256
	if got := call(t, s, "POST", path+"/invoke", s.invokeToken, in).Code; got != 404 {
		t.Fatalf("deleted invoke=%d", got)
	}
}
func TestRejectsInvalidBundleBeforeExecution(t *testing.T) {
	s, r := newTestService(t)
	bad := fixture()
	bad.SHA256 = "wrong"
	if got := call(t, s, "PUT", "/v1/sites/ws-abc/releases/wr-abc", s.deployToken, bad).Code; got != 400 {
		t.Fatalf("status=%d", got)
	}
	if r.calls.Load() != 0 {
		t.Fatal("invalid code executed")
	}
	for _, path := range []string{"/v1/sites/../releases/wr-abc", "/v1/sites/ws%2Fabc/releases/wr-abc", "/v1/sites/ws-abc/releases/.."} {
		if got := call(t, s, "PUT", path, s.deployToken, fixture()).Code; got < 400 {
			t.Fatalf("unsafe path accepted: %s", path)
		}
	}
}
func TestStoreSurvivesServiceRestart(t *testing.T) {
	s, _ := newTestService(t)
	path := "/v1/sites/ws-abc/releases/wr-abc"
	if got := call(t, s, "PUT", path, s.deployToken, fixture()).Code; got != 201 {
		t.Fatal(got)
	}
	second, err := New(Options{DataDir: s.dataDir, DeployToken: s.deployToken, InvokeToken: s.invokeToken, Runner: &fakeRunner{}, Concurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	if got := call(t, second, "POST", path+"/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/items"}).Code; got != 200 {
		t.Fatal(got)
	}
}

func TestRevisionDeletionRetryPreservesOtherRevisions(t *testing.T) {
	s, _ := newTestService(t)
	old := "/v1/sites/ws-abc/releases/wr-old"
	active := "/v1/sites/ws-abc/releases/wr-active"
	for _, path := range []string{old, active} {
		if got := call(t, s, "PUT", path, s.deployToken, fixture()).Code; got != 201 {
			t.Fatalf("deploy=%d", got)
		}
	}
	for i := 0; i < 2; i++ {
		if got := call(t, s, "DELETE", old, s.deployToken, nil).Code; got != 204 {
			t.Fatalf("delete retry=%d", got)
		}
	}
	if got := call(t, s, "GET", active, s.deployToken, nil).Code; got != 200 {
		t.Fatalf("other revision damaged=%d", got)
	}
	if got := call(t, s, "GET", old, s.deployToken, nil).Code; got != 404 {
		t.Fatalf("deleted revision retained=%d", got)
	}
}
