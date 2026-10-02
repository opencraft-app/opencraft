package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A legacy managed adapter must not silently bypass the transaction protocol.
type legacyTransactionRunner struct {
	fakeRunner
	prepares int
}

func (f *legacyTransactionRunner) Prepare(context.Context, string, map[string]Bundle) (string, error) {
	f.prepares++
	return "v_" + strings.Repeat("a", 64), nil
}
func (*legacyTransactionRunner) Verify(context.Context, string, string, string) error { return nil }
func (*legacyTransactionRunner) DeleteSite(context.Context, string) error             { return nil }

func TestDeploymentTransactionRequiresAdapter(t *testing.T) {
	runner := &legacyTransactionRunner{}
	s, err := New(Options{DataDir: t.TempDir(), DeployToken: strings.Repeat("d", 24), InvokeToken: strings.Repeat("i", 24), Runner: runner, Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	got := call(t, s, "PUT", "/v1/sites/ws-one/releases/wr-one", s.deployToken, fixture())
	if got.Code != 503 || runner.prepares != 0 {
		t.Fatalf("unsafe legacy deployment: status=%d Prepare calls=%d", got.Code, runner.prepares)
	}
}

func TestDeploymentTransactionPendingJournalFencesInvoke(t *testing.T) {
	runner := &legacyTransactionRunner{}
	s, err := New(Options{DataDir: t.TempDir(), DeployToken: strings.Repeat("d", 24), InvokeToken: strings.Repeat("i", 24), Runner: runner, Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(s.dataDir, "ws-one", "wr-one")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	b := fixture()
	if err := os.WriteFile(filepath.Join(dir, "app.mjs"), []byte(b.Code), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(b)
	if err := os.WriteFile(filepath.Join(dir, "bundle.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dataDir, "ws-one", ".deploy-txn.json"), []byte("corrupt pending journal"), 0600); err != nil {
		t.Fatal(err)
	}
	got := call(t, s, "POST", "/v1/sites/ws-one/releases/wr-one/invoke", s.invokeToken, Invocation{SHA256: b.SHA256, Method: "GET", Path: "/api/items"})
	if got.Code != 503 || runner.calls.Load() != 0 {
		t.Fatalf("pending transaction executed: status=%d calls=%d", got.Code, runner.calls.Load())
	}
}

// All remote state here is an offline CAS model, not native qualification.
type transactionTestRunner struct {
	fakeRunner
	mu                                   sync.Mutex
	active                               map[string]DeploymentState
	packages                             map[string]string
	stages, activates, restores, deletes int
	mode                                 string
	restoreHook                          func()
	stageHook, activationHook            func()
	probeFailure                         bool
	identity                             string
}

func newTransactionRunner() *transactionTestRunner {
	return &transactionTestRunner{active: map[string]DeploymentState{}, packages: map[string]string{}, identity: "offline-endpoint/scope"}
}
func (*transactionTestRunner) Prepare(context.Context, string, map[string]Bundle) (string, error) {
	return "", errors.New("legacy Prepare must not be called")
}
func (f *transactionTestRunner) Verify(ctx context.Context, site, version, pkg string) error {
	state, err := f.Snapshot(ctx, site)
	if err != nil {
		return err
	}
	if !candidateDeployment(state, version) {
		return errors.New("wrong version")
	}
	return f.VerifyPrepared(ctx, site, state, pkg)
}
func (f *transactionTestRunner) DeleteSite(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes++
	return errors.New("DO deletion forbidden in transaction")
}
func (f *transactionTestRunner) DeploymentIdentity(site string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.identity + "/" + site, nil
}
func (f *transactionTestRunner) Snapshot(ctx context.Context, site string) (DeploymentState, error) {
	if err := ctx.Err(); err != nil {
		return DeploymentState{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.active[site]
	s.Targets = append([]minisandboxTarget(nil), s.Targets...)
	return s, nil
}
func (f *transactionTestRunner) Stage(ctx context.Context, site string, b map[string]Bundle) (PreparedPackage, error) {
	if err := ctx.Err(); err != nil {
		return PreparedPackage{}, err
	}
	p, err := buildMinisandboxPackage(b)
	if err != nil {
		return PreparedPackage{}, err
	}
	f.mu.Lock()
	f.stages++
	v := "v_" + p.PackageID
	f.packages[v] = p.PackageID
	hook := f.stageHook
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return PreparedPackage{VersionID: v, PackageID: p.PackageID}, nil
}
func (f *transactionTestRunner) ActivateCAS(ctx context.Context, site string, before DeploymentState, v string) (ActivationResult, error) {
	if err := ctx.Err(); err != nil {
		return ActivationResult{}, err
	}
	f.mu.Lock()
	f.activates++
	current := f.active[site]
	if current.ID != before.ID || current.Exists != before.Exists {
		f.mu.Unlock()
		return ActivationResult{}, errors.New("CAS conflict")
	}
	mode := f.mode
	if mode == "unknown-before" {
		f.mu.Unlock()
		return ActivationResult{}, errors.New("lost response, no observed mutation")
	}
	next := DeploymentState{Exists: true, ID: fmt.Sprintf("d_%032x", f.activates+100), Targets: []minisandboxTarget{{VersionID: v, Percentage: 100}}}
	f.active[site] = next
	hook := f.activationHook
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	if mode == "unknown-applied" {
		return ActivationResult{}, errors.New("lost activation response")
	}
	if mode == "borrowed" {
		return ActivationResult{Deployment: next, Ownership: ActivationBorrowed, HTTPStatus: 200}, nil
	}
	if mode == "lying-owned" {
		return ActivationResult{Deployment: next, Ownership: ActivationOwned, HTTPStatus: 200}, nil
	}
	return ActivationResult{Deployment: next, Ownership: ActivationOwned, HTTPStatus: 201}, nil
}
func (f *transactionTestRunner) VerifyPrepared(ctx context.Context, site string, state DeploymentState, pkg string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	actual := f.active[site]
	if f.probeFailure || actual.ID != state.ID || !sameMinisandboxTargets(actual.Targets, state.Targets) || !actual.Exists || len(actual.Targets) != 1 || f.packages[actual.Targets[0].VersionID] != pkg {
		return errors.New("actual package probe failed")
	}
	return nil
}
func (f *transactionTestRunner) RestoreCAS(ctx context.Context, site, expected string, before DeploymentState) (ActivationResult, error) {
	if err := ctx.Err(); err != nil {
		return ActivationResult{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restores++
	if f.restoreHook != nil {
		f.restoreHook()
	}
	if f.mode == "restore-conflict" {
		f.active[site] = DeploymentState{Exists: true, ID: "d_" + strings.Repeat("f", 32), Targets: []minisandboxTarget{{VersionID: "v_" + strings.Repeat("f", 64), Percentage: 100}}}
		return ActivationResult{}, errors.New("CAS conflict")
	}
	if f.active[site].ID != expected || !before.Exists {
		return ActivationResult{}, errors.New("unsafe restore")
	}
	restored := before
	restored.ID = fmt.Sprintf("d_%032x", f.restores+1000)
	f.active[site] = restored
	if f.mode == "restore-borrowed" {
		return ActivationResult{Deployment: restored, Ownership: ActivationBorrowed, HTTPStatus: 200}, nil
	}
	if f.mode == "restore-unknown" {
		return ActivationResult{}, errors.New("lost rollback response")
	}
	return ActivationResult{Deployment: restored, Ownership: ActivationOwned, HTTPStatus: 201}, nil
}
func (f *transactionTestRunner) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stages, f.activates, f.restores
}
func newTransactionService(t *testing.T, dir string, f *transactionTestRunner) *Service {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	s, err := New(Options{DataDir: dir, DeployToken: strings.Repeat("d", 24), InvokeToken: strings.Repeat("i", 24), Runner: f, Concurrency: 4, SiteConcurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func transactionBundle(label string) Bundle {
	b := fixture()
	b.Code += "; // " + label
	b.SHA256 = sha256Hex([]byte(b.Code))
	return b
}
func transactionPUT(t *testing.T, s *Service, site, release string, b Bundle) int {
	t.Helper()
	return call(t, s, "PUT", "/v1/sites/"+site+"/releases/"+release, s.deployToken, b).Code
}
func baselineTransaction(t *testing.T) (*Service, *transactionTestRunner, Bundle) {
	t.Helper()
	f := newTransactionRunner()
	s := newTransactionService(t, "", f)
	old := transactionBundle("old")
	if got := transactionPUT(t, s, "ws-one", "wr-old", old); got != 201 {
		t.Fatalf("baseline=%d", got)
	}
	return s, f, old
}
func assertTransactionReady(t *testing.T, s *Service, release string, b Bundle) {
	t.Helper()
	if got := call(t, s, "GET", "/v1/sites/ws-one/releases/"+release, s.deployToken, nil).Code; got != 200 {
		t.Fatalf("GET %s=%d", release, got)
	}
	if got := call(t, s, "POST", "/v1/sites/ws-one/releases/"+release+"/invoke", s.invokeToken, Invocation{SHA256: b.SHA256, Method: "GET", Path: "/api/items"}).Code; got != 200 {
		t.Fatalf("invoke %s=%d", release, got)
	}
}
func assertTransactionPending(t *testing.T, s *Service) {
	t.Helper()
	if got := call(t, s, "GET", "/v1/sites/ws-one/releases/wr-old", s.deployToken, nil).Code; got != 503 {
		t.Fatalf("pending GET=%d", got)
	}
	if got := call(t, s, "POST", "/v1/sites/ws-one/releases/wr-old/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/items"}).Code; got != 503 {
		t.Fatalf("pending invoke=%d", got)
	}
	if got := call(t, s, "DELETE", "/v1/sites/ws-one", s.deployToken, nil).Code; got != 503 {
		t.Fatalf("pending delete=%d", got)
	}
}

func TestDeploymentTransactionSuccessAndRetry(t *testing.T) {
	s, f, old := baselineTransaction(t)
	b := transactionBundle("new")
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 201 {
		t.Fatal(got)
	}
	assertTransactionReady(t, s, "wr-old", old)
	assertTransactionReady(t, s, "wr-new", b)
	_, before, _ := f.counts()
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 200 {
		t.Fatal(got)
	}
	_, after, _ := f.counts()
	if before != after {
		t.Fatal("retry mutated upstream")
	}
	if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("different")); got != 409 {
		t.Fatal(got)
	}
}

// Errors can be injected *after* a real rename has changed the filesystem.
type transactionFaultFS struct {
	osDeploymentFiles
	point    string
	hits     int
	dirPhase string
	crash    bool
	armed    bool
	onFault  func()
}

func (f *transactionFaultFS) hit(op, role string) error {
	if f.armed && f.point == op+":"+role {
		f.hits++
		if f.hits == 1 {
			if f.onFault != nil {
				f.onFault()
				if !f.armed {
					return nil // cancellation-only hook, not a filesystem error
				}
			}
			if f.crash {
				panic("simulated process exit")
			}
			return errors.New("injected " + f.point)
		}
	}
	return nil
}
func transactionRole(name string) string {
	base := filepath.Base(name)
	if strings.HasPrefix(base, ".txn-") {
		end := strings.LastIndex(base, "-")
		if end > len(".txn-") {
			return "journal-" + base[len(".txn-"):end]
		}
	}
	if strings.HasPrefix(base, ".receipt-txn-") {
		return "receipt"
	}
	if base == "bundle.json" {
		return "bundle-file"
	}
	if base == "app.mjs" {
		return "app"
	}
	if base == ".deploy-owner" {
		return "owner"
	}
	return base
}
func (f *transactionFaultFS) CreateTemp(dir, pattern string) (deploymentFile, error) {
	role := transactionRole(pattern + "123")
	if err := f.hit("create", role); err != nil {
		return nil, err
	}
	file, err := f.osDeploymentFiles.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	return &transactionFaultFile{deploymentFile: file, fs: f, role: role}, nil
}
func (f *transactionFaultFS) OpenFile(name string, flag int, perm os.FileMode) (deploymentFile, error) {
	role := transactionRole(name)
	if err := f.hit("open", role); err != nil {
		return nil, err
	}
	file, err := f.osDeploymentFiles.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	return &transactionFaultFile{deploymentFile: file, fs: f, role: role}, nil
}
func (f *transactionFaultFS) OpenDir(name string) (deploymentFile, error) {
	role := "dir-" + f.dirPhase
	if f.dirPhase == "" {
		switch base := filepath.Base(name); {
		case base == "bundle":
			role = "dir-stage-bundle"
		case strings.HasPrefix(base, ".deploy-"):
			role = "dir-stage-root"
		case base == "ws-one":
			role = "dir-site-initial"
		default:
			role = "dir-data"
		}
	}
	if err := f.hit("open", role); err != nil {
		return nil, err
	}
	file, err := f.osDeploymentFiles.OpenDir(name)
	if err != nil {
		return nil, err
	}
	return &transactionFaultFile{deploymentFile: file, fs: f, role: role}, nil
}
func (f *transactionFaultFS) Rename(from, to string) error {
	role := transactionRole(from)
	if filepath.Base(from) == "bundle" {
		role = "bundle"
	}
	if filepath.Base(to) == "discarded" {
		role = "discard"
	}
	if err := f.hit("rename", role); err != nil {
		return err
	}
	if err := f.osDeploymentFiles.Rename(from, to); err != nil {
		return err
	}
	f.dirPhase = role
	return f.hit("after-rename", role)
}
func (f *transactionFaultFS) MkdirAll(name string, perm os.FileMode) error {
	role := "stage-root"
	if filepath.Base(name) == "bundle" {
		role = "stage-bundle"
	} else if filepath.Base(name) == "ws-one" {
		role = "site"
	}
	if err := f.hit("mkdir", role); err != nil {
		return err
	}
	return f.osDeploymentFiles.MkdirAll(name, perm)
}
func (f *transactionFaultFS) Remove(name string) error {
	role := filepath.Base(name)
	if err := f.hit("remove", role); err != nil {
		return err
	}
	if err := f.osDeploymentFiles.Remove(name); err != nil {
		return err
	}
	if role == deploymentJournalName {
		f.dirPhase = "journal-removed"
	}
	return f.hit("after-remove", role)
}
func (f *transactionFaultFS) RemoveAll(name string) error {
	role := filepath.Base(name)
	if strings.HasPrefix(role, ".deploy-") {
		role = "stage-root"
	}
	if err := f.hit("remove-all", role); err != nil {
		return err
	}
	if err := f.osDeploymentFiles.RemoveAll(name); err != nil {
		return err
	}
	f.dirPhase = "stage-removed"
	return f.hit("after-remove-all", role)
}

type transactionFaultFile struct {
	deploymentFile
	fs   *transactionFaultFS
	role string
}

func (f *transactionFaultFile) Write(p []byte) (int, error) {
	if err := f.fs.hit("write", f.role); err != nil {
		return 0, err
	}
	if err := f.fs.hit("short-write", f.role); err != nil {
		return 0, nil
	}
	return f.deploymentFile.Write(p)
}
func (f *transactionFaultFile) Sync() error {
	if err := f.fs.hit("sync", f.role); err != nil {
		return err
	}
	return f.deploymentFile.Sync()
}
func (f *transactionFaultFile) Close() error {
	err := f.deploymentFile.Close()
	if fault := f.fs.hit("close", f.role); fault != nil {
		return fault
	}
	return err
}
func installTransactionFault(s *Service, point string) *transactionFaultFS {
	fs := &transactionFaultFS{point: point, armed: true}
	s.deployFiles = fs
	return fs
}

func TestDeploymentTransactionPublicationFailures(t *testing.T) {
	points := []string{}
	for _, role := range []string{"journal-versioned", "journal-activating", "journal-activated", "journal-verified", "journal-publishing", "receipt", "journal-committed"} {
		for _, op := range []string{"create", "write", "short-write", "sync", "close", "rename", "after-rename"} {
			points = append(points, op+":"+role)
		}
		for _, op := range []string{"open", "sync", "close"} {
			points = append(points, op+":dir-"+role)
		}
	}
	for _, role := range []string{"bundle"} {
		for _, op := range []string{"rename", "after-rename"} {
			points = append(points, op+":"+role)
		}
		for _, op := range []string{"open", "sync", "close"} {
			points = append(points, op+":dir-"+role)
		}
	}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			s, f, old := baselineTransaction(t)
			fs := installTransactionFault(s, point)
			candidate := transactionBundle("new")
			got := transactionPUT(t, s, "ws-one", "wr-new", candidate)
			if fs.hits == 0 {
				t.Fatalf("fault point was not exercised: status=%d", got)
			}
			if got < 400 {
				t.Fatalf("file failure reported ready: %d", got)
			}
			fs.armed = false
			if strings.Contains(point, "committed") {
				if _, _, restores := f.counts(); restores != 0 {
					t.Fatal("uncertain commit compensated")
				}
				if got := transactionPUT(t, s, "ws-one", "wr-new", candidate); got != 200 {
					t.Fatalf("commit recovery=%d", got)
				}
				assertTransactionReady(t, s, "wr-new", candidate)
			} else {
				assertTransactionReady(t, s, "wr-old", old)
				if _, err := os.Stat(filepath.Join(s.dataDir, "ws-one", "wr-new")); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("failed candidate retained: %v", err)
				}
			}
		})
	}
}
func TestDeploymentTransactionPreStageFiles(t *testing.T) {
	for _, role := range []string{"bundle-file", "app", "owner", "journal-staged"} {
		ops := []string{"open", "write", "short-write", "sync", "close"}
		if role == "journal-staged" {
			ops = []string{"create", "write", "short-write", "sync", "close", "rename", "after-rename"}
		}
		for _, op := range ops {
			t.Run(op+":"+role, func(t *testing.T) {
				s, f, old := baselineTransaction(t)
				fs := installTransactionFault(s, op+":"+role)
				_, acts, _ := f.counts()
				if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got < 400 {
					t.Fatal(got)
				}
				if fs.hits == 0 {
					t.Fatal("fault not hit")
				}
				_, after, _ := f.counts()
				if after != acts {
					t.Fatal("activated before durable staging")
				}
				fs.armed = false
				_ = s.Reconcile(context.Background())
				assertTransactionReady(t, s, "wr-old", old)
			})
		}
	}
}

func TestDeploymentTransactionBorrowedNeverRollback(t *testing.T) {
	for _, mode := range []string{"borrowed", "lying-owned"} {
		t.Run(mode, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			f.mode = mode
			fs := installTransactionFault(s, "sync:receipt")
			candidate := transactionBundle("new")
			if got := transactionPUT(t, s, "ws-one", "wr-new", candidate); got < 400 {
				t.Fatal(got)
			}
			if _, _, restores := f.counts(); restores != 0 {
				t.Fatal("borrowed activation compensated")
			}
			fs.armed = false
			if got := transactionPUT(t, s, "ws-one", "wr-new", candidate); got != 200 {
				t.Fatalf("borrowed recovery=%d", got)
			}
			assertTransactionReady(t, s, "wr-new", candidate)
			if _, _, restores := f.counts(); restores != 0 {
				t.Fatal("recovery compensated borrowed ID")
			}
		})
	}
}
func TestDeploymentTransactionCASConflictAndOtherSite(t *testing.T) {
	s, f, _ := baselineTransaction(t)
	f.mode = "restore-conflict"
	installTransactionFault(s, "sync:receipt")
	if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got != 503 {
		t.Fatal(got)
	}
	assertTransactionPending(t, s)
	if got := transactionPUT(t, s, "ws-two", "wr-other", fixture()); got != 201 {
		t.Fatalf("unrelated site=%d", got)
	}
	if got := transactionPUT(t, s, "ws-one", "wr-different", fixture()); got != 409 {
		t.Fatalf("different intent=%d", got)
	}
	if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got != 503 {
		t.Fatalf("conflict was not fenced=%d", got)
	}
}
func TestDeploymentTransactionUnknownCoalescedRecovery(t *testing.T) {
	for _, mode := range []string{"unknown-applied", "unknown-before"} {
		t.Run(mode, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			f.mode = mode
			b := transactionBundle("new")
			if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
				t.Fatal(got)
			}
			assertTransactionPending(t, s)
			_, acts, _ := f.counts()
			got := transactionPUT(t, s, "ws-one", "wr-new", b)
			if mode == "unknown-applied" {
				if got != 200 {
					t.Fatal(got)
				}
				assertTransactionReady(t, s, "wr-new", b)
			} else if got != 503 {
				t.Fatal(got)
			}
			_, after, restores := f.counts()
			if after != acts || restores != 0 {
				t.Fatal("unknown recovery guessed ownership or replayed activation")
			}
		})
	}
}
func TestDeploymentTransactionUnknownProbeAndIdentityFence(t *testing.T) {
	s, f, _ := baselineTransaction(t)
	f.mode = "unknown-applied"
	b := transactionBundle("new")
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	f.probeFailure = true
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	f.probeFailure = false
	f.identity = "changed-endpoint/scope"
	second := newTransactionService(t, s.dataDir, f)
	assertTransactionPending(t, second)
	if got := transactionPUT(t, second, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
}
func TestDeploymentTransactionFirstDeploymentFinishesVerifiedPublication(t *testing.T) {
	f := newTransactionRunner()
	s := newTransactionService(t, "", f)
	installTransactionFault(s, "after-rename:receipt")
	b := transactionBundle("first")
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	assertTransactionPending(t, s)
	second := newTransactionService(t, s.dataDir, f)
	assertTransactionReady(t, second, "wr-new", b)
	if _, _, restores := f.counts(); restores != 0 || f.deletes != 0 {
		t.Fatal("first deployment attempted destructive rollback")
	}
}
func TestDeploymentTransactionCancellation(t *testing.T) {
	for _, first := range []bool{false, true} {
		t.Run(fmt.Sprint(first), func(t *testing.T) {
			f := newTransactionRunner()
			s := newTransactionService(t, "", f)
			old := transactionBundle("old")
			if !first && transactionPUT(t, s, "ws-one", "wr-old", old) != 201 {
				t.Fatal("baseline")
			}
			ctx, cancel := context.WithCancel(context.Background())
			f.activationHook = cancel
			b := transactionBundle("new")
			data, _ := json.Marshal(b)
			r := httptest.NewRequest("PUT", "/v1/sites/ws-one/releases/wr-new", bytes.NewReader(data)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer "+s.deployToken)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code < 400 {
				t.Fatal("cancelled request ready")
			}
			f.activationHook = nil
			if first {
				second := newTransactionService(t, s.dataDir, f)
				assertTransactionReady(t, second, "wr-new", b)
			} else {
				assertTransactionReady(t, s, "wr-old", old)
				if _, _, restores := f.counts(); restores != 1 {
					t.Fatal("cancelled context prevented compensation")
				}
			}
		})
	}
}
func TestDeploymentTransactionCrashRecovery(t *testing.T) {
	for _, point := range []string{"after-rename:journal-activating", "remote-activation", "after-rename:journal-verified", "after-rename:bundle", "after-rename:receipt", "after-rename:journal-committed"} {
		for _, first := range []bool{false, true} {
			t.Run(point+fmt.Sprint(first), func(t *testing.T) {
				f := newTransactionRunner()
				s := newTransactionService(t, "", f)
				old := transactionBundle("old")
				if !first && transactionPUT(t, s, "ws-one", "wr-old", old) != 201 {
					t.Fatal("baseline")
				}
				fs := installTransactionFault(s, point)
				fs.crash = true
				if point == "remote-activation" {
					f.activationHook = func() { panic("simulated process exit") }
				}
				b := transactionBundle("new")
				func() {
					defer func() {
						if recover() == nil {
							t.Fatal("crash not exercised")
						}
					}()
					transactionPUT(t, s, "ws-one", "wr-new", b)
				}()
				f.activationHook = nil
				second := newTransactionService(t, s.dataDir, f)
				if point == "after-rename:journal-activating" {
					assertTransactionPending(t, second)
				} else if first || point == "remote-activation" || strings.Contains(point, "committed") {
					assertTransactionReady(t, second, "wr-new", b)
				} else {
					assertTransactionReady(t, second, "wr-old", old)
				}
				if point == "remote-activation" {
					if _, _, restores := f.counts(); restores != 0 {
						t.Fatal("lost receipt recovery owned competitor")
					}
				}
			})
		}
	}
}

func TestDeploymentTransactionPreservesLegacyReceiptBeforeActivation(t *testing.T) {
	s, f, old := baselineTransaction(t)
	path := filepath.Join(s.dataDir, "ws-one", ".minisandbox.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt minisandboxReceipt
	if err = json.Unmarshal(raw, &receipt); err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(receipt)
	if err = os.WriteFile(path, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	stages, activates, restores := f.counts()
	if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got != 503 {
		t.Fatalf("legacy receipt was not fenced before activation: %d", got)
	}
	afterStages, afterActivates, afterRestores := f.counts()
	if stages != afterStages || activates != afterActivates || restores != afterRestores {
		t.Fatal("legacy receipt fence allowed a native mutation")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, legacy) {
		t.Fatal("an unactivated failed deployment rewrote the legacy receipt / invented ownership")
	}
	bundle, err := load(filepath.Join(s.dataDir, "ws-one", "wr-old"))
	if err != nil || bundle != old {
		t.Fatalf("legacy bundle was not preserved: %v", err)
	}
	if got := call(t, s, "GET", "/v1/sites/ws-one/releases/wr-old", s.deployToken, nil).Code; got != 503 {
		t.Fatalf("unbound legacy receipt was reported ready: %d", got)
	}
}

func TestDeploymentTransactionStageDirectories(t *testing.T) {
	points := []string{"mkdir:site", "mkdir:stage-root", "mkdir:stage-bundle"}
	for _, role := range []string{"dir-data", "dir-stage-bundle", "dir-stage-root", "dir-site-initial"} {
		for _, op := range []string{"open", "sync", "close"} {
			points = append(points, op+":"+role)
		}
	}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			s, f, old := baselineTransaction(t)
			fs := installTransactionFault(s, point)
			_, before, _ := f.counts()
			if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got < 400 {
				t.Fatal(got)
			}
			if fs.hits == 0 {
				t.Fatal("directory fault not exercised")
			}
			_, after, _ := f.counts()
			if before != after {
				t.Fatal("upstream activated without durable staging")
			}
			fs.armed = false
			_ = s.Reconcile(context.Background())
			assertTransactionReady(t, s, "wr-old", old)
		})
	}
}
func TestDeploymentTransactionRollbackLocalFailures(t *testing.T) {
	for _, point := range []string{"write:journal-aborting", "sync:dir-journal-aborting", "create:receipt", "write:receipt", "short-write:receipt", "sync:receipt", "close:receipt", "rename:receipt", "after-rename:receipt", "open:dir-receipt", "sync:dir-receipt", "close:dir-receipt", "rename:discard", "after-rename:discard", "sync:dir-discard"} {
		t.Run(point, func(t *testing.T) {
			s, f, old := baselineTransaction(t)
			fs := installTransactionFault(s, "write:receipt")
			f.restoreHook = func() { fs.point = point; fs.hits = 0 }
			if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got != 503 {
				t.Fatalf("restore file failure=%d", got)
			}
			if fs.hits != 1 {
				t.Fatal("restore fault not exercised")
			}
			assertTransactionPending(t, s)
			f.restoreHook = nil
			fs.armed = false
			if err := s.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			assertTransactionReady(t, s, "wr-old", old)
			if _, _, restores := f.counts(); restores != 1 {
				t.Fatal("recovery repeated remote restoration")
			}
			raw, err := os.ReadFile(filepath.Join(s.dataDir, "ws-one", ".minisandbox.json"))
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := parseDeploymentReceipt(raw)
			if err != nil {
				t.Fatal(err)
			}
			active, _ := f.Snapshot(context.Background(), "ws-one")
			if receipt.DeploymentID != active.ID {
				t.Fatal("restored receipt bound to stale original deployment ID")
			}
		})
	}
}
func TestDeploymentTransactionRollbackUnknownNeverReady(t *testing.T) {
	for _, mode := range []string{"restore-borrowed", "restore-unknown"} {
		t.Run(mode, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			f.mode = mode
			installTransactionFault(s, "write:receipt")
			if got := transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")); got != 503 {
				t.Fatal(got)
			}
			second := newTransactionService(t, s.dataDir, f)
			assertTransactionPending(t, second)
			if _, _, restores := f.counts(); restores != 1 {
				t.Fatal("unknown rollback was blindly replayed")
			}
		})
	}
}
func TestDeploymentTransactionCommitCleanupFailures(t *testing.T) {
	points := []string{"remove-all:stage-root", "after-remove-all:stage-root", "remove:" + deploymentJournalName, "after-remove:" + deploymentJournalName}
	for _, role := range []string{"dir-stage-removed", "dir-journal-removed"} {
		for _, op := range []string{"open", "sync", "close"} {
			points = append(points, op+":"+role)
		}
	}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			fs := installTransactionFault(s, point)
			b := transactionBundle("new")
			if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
				t.Fatalf("cleanup pending was called ready: %d", got)
			}
			if fs.hits == 0 {
				t.Fatal("cleanup fault not hit")
			}
			assertTransactionPending(t, s)
			fs.armed = false
			if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 200 {
				t.Fatalf("terminal cleanup recovery=%d", got)
			}
			assertTransactionReady(t, s, "wr-new", b)
			if _, _, restores := f.counts(); restores != 0 {
				t.Fatal("committed transaction rolled back because cleanup failed")
			}
		})
	}
}
func TestDeploymentTransactionCrashAfterCommitCleanup(t *testing.T) {
	for _, point := range []string{"after-remove-all:stage-root", "after-remove:" + deploymentJournalName} {
		t.Run(point, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			fs := installTransactionFault(s, point)
			fs.crash = true
			b := transactionBundle("new")
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("crash not hit")
					}
				}()
				transactionPUT(t, s, "ws-one", "wr-new", b)
			}()
			second := newTransactionService(t, s.dataDir, f)
			assertTransactionReady(t, second, "wr-new", b)
			if _, _, restores := f.counts(); restores != 0 {
				t.Fatal("crash after commit compensated")
			}
		})
	}
}
func TestDeploymentTransactionInvalidJournalCannotCoalesce(t *testing.T) {
	for _, mode := range []string{"package", "version", "targets"} {
		t.Run(mode, func(t *testing.T) {
			s, f, _ := baselineTransaction(t)
			f.mode = "unknown-applied"
			b := transactionBundle("new")
			if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
				t.Fatal(got)
			}
			path := filepath.Join(s.dataDir, "ws-one", deploymentJournalName)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var tx deploymentTransaction
			if err = json.Unmarshal(raw, &tx); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "package":
				tx.Package.Modules["main.js"] += "tampered"
			case "version":
				tx.VersionID = "invalid"
			case "targets":
				f.mu.Lock()
				state := f.active["ws-one"]
				state.Targets[0].Percentage = 99
				f.active["ws-one"] = state
				f.mu.Unlock()
			}
			raw, _ = json.Marshal(tx)
			if err = os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			second := newTransactionService(t, s.dataDir, f)
			assertTransactionPending(t, second)
			if _, _, restores := f.counts(); restores != 0 {
				t.Fatal("invalid unknown transaction compensated")
			}
		})
	}
}
func TestDeploymentTransactionFirstProbeFailureIsNotReady(t *testing.T) {
	f := newTransactionRunner()
	s := newTransactionService(t, "", f)
	f.probeFailure = true
	b := transactionBundle("new")
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	second := newTransactionService(t, s.dataDir, f)
	assertTransactionPending(t, second)
	if _, _, restores := f.counts(); restores != 0 || f.deletes != 0 {
		t.Fatal("first deployment destructive rollback")
	}
	f.probeFailure = false
	if got := transactionPUT(t, second, "ws-one", "wr-new", b); got != 200 {
		t.Fatal(got)
	}
	assertTransactionReady(t, second, "wr-new", b)
}
func TestDeploymentTransactionNativeStageDoesNotBlockOtherSite(t *testing.T) {
	s, f, _ := baselineTransaction(t)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan int, 1)
	var once atomic.Bool
	f.stageHook = func() {
		if once.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	}
	go func() { done <- transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("new")) }()
	<-entered
	otherDone := make(chan int, 1)
	go func() { otherDone <- transactionPUT(t, s, "ws-two", "wr-other", fixture()) }()
	select {
	case code := <-otherDone:
		if code != 201 {
			t.Errorf("other site=%d", code)
		}
	case <-time.After(3 * time.Second):
		t.Error("native Stage held global storage lock")
	}
	close(release)
	if got := <-done; got != 201 {
		t.Fatal(got)
	}
}

func TestDeploymentTransactionV2RequiresIdentityVerifier(t *testing.T) {
	s, _, _ := baselineTransaction(t)
	legacy := &legacyTransactionRunner{}
	second, err := New(Options{DataDir: s.dataDir, DeployToken: s.deployToken, InvokeToken: s.invokeToken, Runner: legacy, Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	if got := call(t, second, "GET", "/v1/sites/ws-one/releases/wr-old", second.deployToken, nil).Code; got != 503 {
		t.Fatalf("unbound legacy Verify accepted v2 receipt: %d", got)
	}
}

// A file fixture models the remote registry surviving the runtime process. This
// is deliberately not a Workers/DO/FDB or power-loss durability qualification.
type transactionRemoteFixture struct {
	Active                      map[string]DeploymentState
	Packages                    map[string]string
	Stages, Activates, Restores int
	Identity                    string
}

func saveTransactionRemote(path string, f *transactionTestRunner) error {
	f.mu.Lock()
	data, err := json.Marshal(transactionRemoteFixture{Active: f.active, Packages: f.packages, Stages: f.stages, Activates: f.activates, Restores: f.restores, Identity: f.identity})
	f.mu.Unlock()
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(writeErr, syncErr, closeErr)
}
func loadTransactionRemote(path string) (*transactionTestRunner, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var stored transactionRemoteFixture
	if err = json.Unmarshal(raw, &stored); err != nil {
		return nil, err
	}
	f := newTransactionRunner()
	f.active = stored.Active
	f.packages = stored.Packages
	f.stages = stored.Stages
	f.activates = stored.Activates
	f.restores = stored.Restores
	f.identity = stored.Identity
	return f, nil
}
func TestDeploymentTransactionCrashProcessHelper(t *testing.T) {
	if os.Getenv("WEBSITE_TX_CRASH_HELPER") != "1" {
		return
	}
	remote, dir, point := os.Getenv("WEBSITE_TX_REMOTE"), os.Getenv("WEBSITE_TX_DIR"), os.Getenv("WEBSITE_TX_POINT")
	f, err := loadTransactionRemote(remote)
	if err != nil {
		t.Fatal(err)
	}
	s := newTransactionService(t, dir, f)
	exit := func() {
		if err := saveTransactionRemote(remote, f); err != nil {
			t.Fatal(err)
		}
		os.Exit(88)
	}
	if point == "activation" {
		f.activationHook = exit
	} else {
		fs := installTransactionFault(s, "after-rename:"+point)
		fs.onFault = exit
	}
	transactionPUT(t, s, "ws-one", "wr-new", transactionBundle("process-crash"))
	t.Fatal("subprocess did not exit at checkpoint")
}
func TestDeploymentTransactionActualProcessExitRecovery(t *testing.T) {
	for _, point := range []string{"activation", "receipt", "journal-committed"} {
		for _, first := range []bool{false, true} {
			t.Run(point+fmt.Sprint(first), func(t *testing.T) {
				f := newTransactionRunner()
				s := newTransactionService(t, "", f)
				old := transactionBundle("old")
				if !first && transactionPUT(t, s, "ws-one", "wr-old", old) != 201 {
					t.Fatal("baseline")
				}
				remote := filepath.Join(t.TempDir(), "offline-remote.json")
				if err := saveTransactionRemote(remote, f); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(os.Args[0], "-test.run=^TestDeploymentTransactionCrashProcessHelper$", "-test.count=1")
				// No cloud credentials or ambient service configuration are passed to helpers.
				cmd.Env = []string{"WEBSITE_TX_CRASH_HELPER=1", "WEBSITE_TX_REMOTE=" + remote, "WEBSITE_TX_DIR=" + s.dataDir, "WEBSITE_TX_POINT=" + point, "TMPDIR=" + os.TempDir()}
				output, err := cmd.CombinedOutput()
				var exited *exec.ExitError
				if !errors.As(err, &exited) || exited.ExitCode() != 88 {
					t.Fatalf("crash helper: %v\n%s", err, output)
				}
				recovered, err := loadTransactionRemote(remote)
				if err != nil {
					t.Fatal(err)
				}
				second := newTransactionService(t, s.dataDir, recovered)
				if point == "receipt" && !first {
					assertTransactionReady(t, second, "wr-old", old)
				} else {
					assertTransactionReady(t, second, "wr-new", transactionBundle("process-crash"))
				}
				if point == "activation" {
					if _, _, restores := recovered.counts(); restores != 0 {
						t.Fatal("unacknowledged activation was compensated")
					}
					raw, _ := os.ReadFile(filepath.Join(s.dataDir, "ws-one", ".minisandbox.json"))
					receipt, _ := parseDeploymentReceipt(raw)
					if receipt.Ownership != ActivationBorrowed {
						t.Fatal("coalesced result guessed ownership")
					}
				}
			})
		}
	}
}

func TestDeploymentTransactionUnknownDifferentTargetsStaysConflict(t *testing.T) {
	s, f, _ := baselineTransaction(t)
	f.mode = "unknown-applied"
	b := transactionBundle("new")
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	f.mu.Lock()
	candidate := f.active["ws-one"]
	other := candidate
	other.ID = "d_" + strings.Repeat("e", 32)
	other.Targets = []minisandboxTarget{{VersionID: "v_" + strings.Repeat("e", 64), Percentage: 100}}
	f.active["ws-one"] = other
	f.mu.Unlock()
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal(got)
	}
	raw, err := os.ReadFile(filepath.Join(s.dataDir, "ws-one", deploymentJournalName))
	if err != nil {
		t.Fatal(err)
	}
	var tx deploymentTransaction
	if err = json.Unmarshal(raw, &tx); err != nil {
		t.Fatal(err)
	}
	if tx.Phase != "conflict" {
		t.Fatalf("different targets were not durably fenced as conflict: %s", tx.Phase)
	}
	f.mu.Lock()
	f.active["ws-one"] = candidate
	f.mu.Unlock()
	if got := transactionPUT(t, s, "ws-one", "wr-new", b); got != 503 {
		t.Fatal("sticky conflict was implicitly cleared")
	}
	assertTransactionPending(t, s)
}

func TestDeploymentTransactionCancellationBoundaries(t *testing.T) {
	for _, point := range []string{"before-stage", "before-activation", "after-receipt", "after-commit"} {
		t.Run(point, func(t *testing.T) {
			s, f, old := baselineTransaction(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			b := transactionBundle("new")
			_, initial, _ := f.counts()
			switch point {
			case "before-stage":
				cancel()
			case "before-activation":
				f.stageHook = cancel
			case "after-receipt", "after-commit":
				role := "receipt"
				if point == "after-commit" {
					role = "journal-committed"
				}
				fs := installTransactionFault(s, "after-rename:"+role)
				fs.onFault = func() { cancel(); fs.armed = false }
			}
			data, _ := json.Marshal(b)
			r := httptest.NewRequest("PUT", "/v1/sites/ws-one/releases/wr-new", bytes.NewReader(data)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer "+s.deployToken)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if point == "after-commit" {
				if w.Code < 200 || w.Code >= 300 {
					t.Fatalf("durable committed result=%d", w.Code)
				}
				assertTransactionReady(t, s, "wr-new", b)
				if _, _, restores := f.counts(); restores != 0 {
					t.Fatal("cancel after commit rolled back")
				}
			} else {
				if w.Code < 400 {
					t.Fatalf("cancelled uncommitted request reported ready=%d", w.Code)
				}
				assertTransactionReady(t, s, "wr-old", old)
			}
			if point == "before-stage" || point == "before-activation" {
				_, after, restores := f.counts()
				if initial != after || restores != 0 {
					t.Fatal("cancel before activation mutated pointer")
				}
			}
		})
	}
}

func TestDeploymentTransactionCompletedReceiptFencesInvocation(t *testing.T) {
	for _, mode := range []string{"configured-identity-changed", "receipt-other-site", "malformed-receipt"} {
		t.Run(mode, func(t *testing.T) {
			s, f, b := baselineTransaction(t)
			journal := filepath.Join(s.dataDir, "ws-one", deploymentJournalName)
			if _, err := os.Lstat(journal); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("baseline transaction is not completed: %v", err)
			}
			receiptPath := filepath.Join(s.dataDir, "ws-one", ".minisandbox.json")
			before, err := os.ReadFile(receiptPath)
			if err != nil {
				t.Fatal(err)
			}
			originalIdentity := f.identity
			switch mode {
			case "configured-identity-changed":
				f.mu.Lock()
				f.identity += "/different-scope"
				f.mu.Unlock()
			case "receipt-other-site":
				var receipt deploymentReceipt
				if err := json.Unmarshal(before, &receipt); err != nil {
					t.Fatal(err)
				}
				receipt.Identity = originalIdentity + "/ws-other"
				data, err := json.Marshal(receipt)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(receiptPath, data, 0600); err != nil {
					t.Fatal(err)
				}
			case "malformed-receipt":
				if err := os.WriteFile(receiptPath, []byte("not a receipt"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			calls := f.calls.Load()
			in := Invocation{SHA256: b.SHA256, Method: "POST", Path: "/api/items"}
			got := call(t, s, "POST", "/v1/sites/ws-one/releases/wr-old/invoke", s.invokeToken, in)
			if got.Code != 503 || f.calls.Load() != calls {
				t.Fatalf("unbound completed receipt executed application: status=%d calls=%d want=%d", got.Code, f.calls.Load(), calls)
			}
			if err := os.WriteFile(receiptPath, before, 0600); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.identity = originalIdentity
			f.mu.Unlock()
			if got := call(t, s, "POST", "/v1/sites/ws-one/releases/wr-old/invoke", s.invokeToken, in).Code; got != 200 {
				t.Fatalf("restored receipt identity is still fenced: %d", got)
			}
		})
	}
}

// Exercise the concrete native adapter over loopback, not a managedRunner mock.
// This proves local migration fences only; it is not native storage qualification.
func TestDeploymentTransactionNativeLegacyReceiptFailsClosed(t *testing.T) {
	for _, schema := range []int{0, 1} {
		for _, operation := range []string{"readiness", "idempotent-put", "new-put", "invoke", "site-read", "release-delete", "site-delete", "direct-verify", "direct-begin"} {
			t.Run(fmt.Sprintf("schema-%d/%s", schema, operation), func(t *testing.T) {
				static, _ := newTestService(t)
				old := fixture()
				path := "/v1/sites/ws-one/releases/wr-old"
				if got := call(t, static, "PUT", path, static.deployToken, old).Code; got != 201 {
					t.Fatal(got)
				}
				pkg, err := buildMinisandboxPackage(map[string]Bundle{"wr-old": old})
				if err != nil {
					t.Fatal(err)
				}
				version := "v_" + strings.Repeat("a", 64)
				deploymentID := "d_" + strings.Repeat("a", 32)
				receipt := deploymentReceipt{minisandboxReceipt: minisandboxReceipt{Version: version, PackageID: pkg.PackageID, Digests: []string{old.SHA256}}, Schema: schema}
				legacy, err := json.Marshal(receipt)
				if err != nil {
					t.Fatal(err)
				}
				receiptPath := filepath.Join(static.dataDir, "ws-one", ".minisandbox.json")
				if err = os.WriteFile(receiptPath, legacy, 0600); err != nil {
					t.Fatal(err)
				}
				var stages, activations, appFetches, deletes atomic.Int64
				var mu sync.Mutex
				activePackage := pkg.PackageID
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					mu.Lock()
					defer mu.Unlock()
					w.Header().Set("Content-Type", "application/json")
					switch {
					case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/versions"):
						stages.Add(1)
						var packet minisandboxPackage
						if err := json.NewDecoder(r.Body).Decode(&packet); err != nil {
							t.Error(err)
						}
						marker, _, _ := strings.Cut(strings.TrimPrefix(packet.Modules["main.js"], "const platformPackageID = "), ";\n")
						if err := json.Unmarshal([]byte(marker), &activePackage); err != nil {
							t.Error(err)
						}
						_ = json.NewEncoder(w).Encode(map[string]string{"id": "v_" + strings.Repeat("b", 64)})
					case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/deployments"):
						activations.Add(1)
						version = "v_" + strings.Repeat("b", 64)
						deploymentID = "d_" + strings.Repeat("b", 32)
						w.WriteHeader(http.StatusCreated)
						_ = json.NewEncoder(w).Encode(minisandboxDeployment{ID: deploymentID, Versions: []minisandboxTarget{{VersionID: version, Percentage: 100}}})
					case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/deployment"):
						_ = json.NewEncoder(w).Encode(minisandboxDeployment{ID: deploymentID, Versions: []minisandboxTarget{{VersionID: version, Percentage: 100}}})
					case r.Method == "DELETE":
						deletes.Add(1)
						w.WriteHeader(http.StatusNoContent)
					case strings.HasSuffix(r.URL.Path, "/fetch") || strings.HasSuffix(r.URL.Path, "/dispatch"):
						if r.Header.Get("X-Workers-Original-URL") == "https://website.invalid/__platform_prepare" {
							_ = json.NewEncoder(w).Encode(map[string]string{"package_id": activePackage})
						} else {
							appFetches.Add(1)
							_, _ = w.Write([]byte(`{"todos":[{"title":"existing-user-data"}]}`))
						}
					default:
						_, _ = w.Write([]byte(`{}`))
					}
				}))
				defer upstream.Close()
				native, err := newMinisandboxClient(upstream.URL, "cn-test", upstream.Client())
				if err != nil {
					t.Fatal(err)
				}
				s, err := New(Options{DataDir: static.dataDir, DeployToken: static.deployToken, InvokeToken: static.invokeToken, Runner: native, Concurrency: 2})
				if err != nil {
					t.Fatal(err)
				}
				switch operation {
				case "direct-verify":
					if err := s.verifyDeploymentReceipt(context.Background(), filepath.Join(s.dataDir, "ws-one", "wr-old"), old.SHA256); err == nil {
						t.Error("legacy native receipt was directly verified")
					}
				case "direct-begin":
					if tx, err := s.beginDeployment(context.Background(), native, filepath.Join(s.dataDir, "ws-one", "wr-new"), transactionBundle("new")); err == nil || tx != nil {
						t.Error("legacy native endpoint was automatically adopted by beginDeployment")
					}
				default:
					method, target, token := "GET", path, s.deployToken
					var body any
					switch operation {
					case "idempotent-put":
						method, body = "PUT", old
					case "new-put":
						method, target, body = "PUT", "/v1/sites/ws-one/releases/wr-new", transactionBundle("new")
					case "invoke":
						method, target, token, body = "POST", path+"/invoke", s.invokeToken, Invocation{SHA256: old.SHA256, Method: "POST", Path: "/api/todos"}
					case "site-read":
						target = "/v1/sites/ws-one"
					case "release-delete":
						method = "DELETE"
					case "site-delete":
						method, target = "DELETE", "/v1/sites/ws-one"
					}
					if got := call(t, s, method, target, token, body).Code; got != 503 {
						t.Errorf("unbound legacy native receipt: %s=%d, want 503", operation, got)
					}
				}
				if stages.Load() != 0 || activations.Load() != 0 || appFetches.Load() != 0 || deletes.Load() != 0 {
					t.Errorf("legacy migration caused native effects: stage=%d activate=%d app-fetch=%d delete=%d", stages.Load(), activations.Load(), appFetches.Load(), deletes.Load())
				}
				after, err := os.ReadFile(receiptPath)
				if err != nil || !bytes.Equal(after, legacy) {
					t.Errorf("legacy receipt was rewritten or removed: %v", err)
				}
				bundle, err := load(filepath.Join(s.dataDir, "ws-one", "wr-old"))
				if err != nil || bundle != old {
					t.Errorf("legacy deployment data was changed or removed: %v", err)
				}
			})
		}
	}
}

func TestDeploymentTransactionFingerprintRejectsMetadataTamper(t *testing.T) {
	f := newTransactionRunner()
	s := newTransactionService(t, "", f)
	tx, err := s.beginDeployment(context.Background(), f, filepath.Join(s.dataDir, "ws-one", "wr-new"), fixture())
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.validate("ws-one"); err != nil {
		t.Fatalf("baseline journal is invalid: %v", err)
	}
	tx.Package.CompatibilityDate = "2026-05-01"
	if err := tx.validate("ws-one"); err == nil {
		t.Fatal("metadata changed without changing the marker/fingerprint was accepted")
	}
}

func TestDeploymentTransactionOldSourceJournalFailsClosed(t *testing.T) {
	f := newTransactionRunner()
	s := newTransactionService(t, "", f)
	tx, err := s.beginDeployment(context.Background(), f, filepath.Join(s.dataDir, "ws-one", "wr-new"), fixture())
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("const platformPackageID = %q;\n", tx.PackageID)
	source := strings.TrimPrefix(tx.Package.Modules["main.js"], prefix)
	tx.PackageID = sha256Hex([]byte(source))
	tx.Package.Modules["main.js"] = fmt.Sprintf("const platformPackageID = %q;\n", tx.PackageID) + source
	if err := s.checkpointDeployment(tx); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(s.dataDir, "ws-one", deploymentJournalName)
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	root := tx.root(s.dataDir)
	stages, activates, restores := f.counts()
	second := newTransactionService(t, s.dataDir, f)
	if err := second.Reconcile(context.Background()); err == nil {
		t.Error("source-only journal was automatically reconciled")
	}
	if !second.pendingDeployment("ws-one") {
		t.Error("source-only journal no longer fences the site")
	}
	after, err := os.ReadFile(journalPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Errorf("source-only journal was rewritten or removed: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Errorf("source-only journal artifacts were removed: %v", err)
	}
	afterStages, afterActivates, afterRestores := f.counts()
	if stages != afterStages || activates != afterActivates || restores != afterRestores {
		t.Error("source-only journal recovery attempted a native mutation")
	}
}
