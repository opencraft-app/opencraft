package runtime

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

type blockingRunner struct {
	entered chan struct{}
	release chan struct{}
}

func (r *blockingRunner) Run(ctx context.Context, _ string, in Invocation) (Result, error) {
	if in.Path == "/__platform_health" {
		return Result{Status: 204}, nil
	}
	if in.Path == "/api/block" {
		r.entered <- struct{}{}
		select {
		case <-r.release:
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	return Result{Status: 200}, nil
}
func TestPerSiteAdmissionLeavesCapacityForOtherSites(t *testing.T) {
	r := &blockingRunner{entered: make(chan struct{}, 4), release: make(chan struct{})}
	s, err := New(Options{DataDir: t.TempDir(), DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: r, Concurrency: 4, SiteConcurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	for _, site := range []string{"ws-one", "ws-two"} {
		if got := call(t, s, http.MethodPut, "/v1/sites/"+site+"/releases/wr-one", s.deployToken, fixture()).Code; got != 201 {
			t.Fatal(got)
		}
	}
	var wg sync.WaitGroup
	defer func() { close(r.release); wg.Wait() }()
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			call(t, s, http.MethodPost, "/v1/sites/ws-one/releases/wr-one/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/block"})
		}()
		select {
		case <-r.entered:
		case <-time.After(time.Second):
			t.Fatal("request did not enter runtime")
		}
	}
	in := Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/ok"}
	rejected := call(t, s, http.MethodPost, "/v1/sites/ws-one/releases/wr-one/invoke", s.invokeToken, in)
	if rejected.Code != 429 || rejected.Header().Get("Retry-After") == "" {
		t.Fatalf("site limit did not apply: %d", rejected.Code)
	}
	if got := call(t, s, http.MethodPost, "/v1/sites/ws-two/releases/wr-one/invoke", s.invokeToken, in).Code; got != 200 {
		t.Fatalf("other site starved: %d", got)
	}
}
func TestAdmissionReleasesStateAndRejectsInvalidLimits(t *testing.T) {
	for _, limit := range []int{-1, 5} {
		if _, err := New(Options{DataDir: t.TempDir(), DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: &fakeRunner{}, Concurrency: 4, SiteConcurrency: limit}); err == nil {
			t.Fatal("invalid site limit accepted")
		}
	}
	s, _ := newTestService(t)
	for i := 0; i < 100; i++ {
		call(t, s, http.MethodGet, "/v1/sites/ws-missing/releases/wr-one", s.deployToken, nil)
	}
	if len(s.activeSites) != 0 {
		t.Fatal("admission map retained inactive sites")
	}
}

func TestSiteManagementDoesNotWaitForOtherTenantInvocation(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			r := &blockingRunner{entered: make(chan struct{}, 1), release: make(chan struct{})}
			s, err := New(Options{DataDir: t.TempDir(), DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: r, Concurrency: 4})
			if err != nil {
				t.Fatal(err)
			}
			for _, site := range []string{"ws-busy", "ws-independent"} {
				if got := call(t, s, http.MethodPut, "/v1/sites/"+site+"/releases/wr-one", s.deployToken, fixture()).Code; got != 201 {
					t.Fatal(got)
				}
			}
			var wg sync.WaitGroup
			defer func() { close(r.release); wg.Wait() }()
			wg.Add(1)
			go func() {
				defer wg.Done()
				call(t, s, http.MethodPost, "/v1/sites/ws-busy/releases/wr-one/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/block"})
			}()
			select {
			case <-r.entered:
			case <-time.After(time.Second):
				t.Fatal("busy request did not enter")
			}
			done := make(chan int, 1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				done <- call(t, s, method, "/v1/sites/ws-independent", s.deployToken, nil).Code
			}()
			select {
			case status := <-done:
				want := 200
				if method == http.MethodDelete {
					want = 204
				}
				if status != want {
					t.Fatalf("status=%d", status)
				}
			case <-time.After(300 * time.Millisecond):
				t.Fatal("unrelated tenant management blocked by invocation")
			}
		})
	}
}

func TestSiteDeleteWaitsForOwnInvocationAndReclaimsLock(t *testing.T) {
	r := &blockingRunner{entered: make(chan struct{}, 1), release: make(chan struct{})}
	s, err := New(Options{DataDir: t.TempDir(), DeployToken: "deploy-test-credential-long-enough", InvokeToken: "invoke-test-credential-long-enough", Runner: r, Concurrency: 4})
	if err != nil {
		t.Fatal(err)
	}
	if got := call(t, s, http.MethodPut, "/v1/sites/ws-own/releases/wr-one", s.deployToken, fixture()).Code; got != 201 {
		t.Fatal(got)
	}
	var wg sync.WaitGroup
	var once sync.Once
	unblock := func() { once.Do(func() { close(r.release) }) }
	defer func() { unblock(); wg.Wait() }()
	wg.Add(1)
	go func() {
		defer wg.Done()
		call(t, s, http.MethodPost, "/v1/sites/ws-own/releases/wr-one/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/block"})
	}()
	select {
	case <-r.entered:
	case <-time.After(time.Second):
		t.Fatal("invocation missing")
	}
	done := make(chan int, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		done <- call(t, s, http.MethodDelete, "/v1/sites/ws-own", s.deployToken, nil).Code
	}()
	select {
	case <-done:
		t.Fatal("deleted while own invocation active")
	case <-time.After(50 * time.Millisecond):
	}
	unblock()
	select {
	case code := <-done:
		if code != 204 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("delete did not finish")
	}
	wg.Wait()
	if len(s.siteLocks) != 0 || len(s.activeSites) != 0 {
		t.Fatal("idle admission/lock entries leaked")
	}
	if got := call(t, s, http.MethodGet, "/v1/sites/ws-own/releases/wr-one", s.deployToken, nil).Code; got != 404 {
		t.Fatal(got)
	}
}
