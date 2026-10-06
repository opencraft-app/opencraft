// Package runtime manages immutable website bundles. User code is executed only
// by Runner; the production executable installs the mandatory runsc runner.
package runtime

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const MaxCodeBytes = 1 << 20
const MaxBodyBytes = 1 << 20
const MaxResponseBytes = 4 << 20
const ExecutionTimeout = 5 * time.Second

var identifier = regexp.MustCompile(`^[a-z][a-z0-9-]{1,95}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Bundle struct {
	Code   string `json:"code"`
	SHA256 string `json:"sha256"`
}
type Invocation struct {
	SHA256   string            `json:"sha256"`
	ReadOnly bool              `json:"read_only,omitempty"`
	Method   string            `json:"method"`
	Path     string            `json:"path"`
	Headers  map[string]string `json:"headers,omitempty"`
	Body     []byte            `json:"body,omitempty"`
}
type Result struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}
type Runner interface {
	Run(context.Context, string, Invocation) (Result, error)
}
type Options struct {
	DataDir, DeployToken, InvokeToken string
	Runner                            Runner
	Concurrency                       int
	SiteConcurrency                   int
}
type Service struct {
	rateLock                          sync.Mutex
	rates                             map[string]rateBucket
	storeLock                         sync.Mutex
	admissionLock                     sync.Mutex
	activeSites                       map[string]int
	siteLocks                         map[string]*sync.RWMutex
	siteConcurrency                   int
	dataDir, deployToken, invokeToken string
	runner                            Runner
	slots                             chan struct{}
	deployFiles                       deploymentFileOps
	pendingDeployments                sync.Map
}

func New(o Options) (*Service, error) {
	if len(o.DeployToken) < 24 || len(o.InvokeToken) < 24 || o.DeployToken == o.InvokeToken {
		return nil, fmt.Errorf("separate deploy/invoke credentials of at least 24 bytes required")
	}
	if o.Runner == nil || o.DataDir == "" || o.Concurrency < 1 || o.Concurrency > 64 {
		return nil, fmt.Errorf("invalid runtime configuration")
	}
	if o.SiteConcurrency == 0 {
		o.SiteConcurrency = min(2, o.Concurrency)
	}
	if o.SiteConcurrency < 1 || o.SiteConcurrency > o.Concurrency {
		return nil, fmt.Errorf("invalid per-site concurrency")
	}
	dir, err := filepath.Abs(o.DataDir)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Service{rates: make(map[string]rateBucket), dataDir: dir, deployToken: o.DeployToken, invokeToken: o.InvokeToken, runner: o.Runner, slots: make(chan struct{}, o.Concurrency), activeSites: make(map[string]int), siteLocks: make(map[string]*sync.RWMutex), siteConcurrency: o.SiteConcurrency, deployFiles: osDeploymentFiles{}}
	// A bounded startup pass must not make one unavailable site hold up all
	// others. Unresolved journals remain an on-disk invocation/readiness fence.
	ctx, cancel := context.WithTimeout(context.Background(), startupDeploymentRecoveryTimeout)
	_ = s.Reconcile(ctx)
	cancel()
	return s, nil
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) == 3 && parts[0] == "v1" && parts[1] == "sites" && identifier.MatchString(parts[2]) && r.URL.RawPath == "" && r.URL.RawQuery == "" {
		s.siteRequest(w, r, parts[2])
		return
	}
	if r.URL.RawQuery != "" || r.URL.RawPath != "" || len(parts) < 5 || len(parts) > 6 || parts[0] != "v1" || parts[1] != "sites" || parts[3] != "releases" || !identifier.MatchString(parts[2]) || !identifier.MatchString(parts[4]) {
		http.Error(w, "not found", 404)
		return
	}
	invoke := len(parts) == 6 && parts[5] == "invoke" && r.Method == "POST"
	manage := len(parts) == 5 && (r.Method == "PUT" || r.Method == "DELETE" || r.Method == "GET")
	if !invoke && !manage {
		http.Error(w, "method not allowed", 405)
		return
	}
	token := s.deployToken
	if invoke {
		token = s.invokeToken
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	if invoke && !s.allowInvocation(parts[2], time.Now()) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "site invocation rate exceeded", http.StatusTooManyRequests)
		return
	}
	if !s.admit(parts[2]) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "runtime busy", http.StatusTooManyRequests)
		return
	}
	defer s.release(parts[2])
	lock := s.admittedSiteLock(parts[2])
	dir := filepath.Join(s.dataDir, parts[2], parts[4])
	_, managed := s.runner.(managedRunner)
	// Managed readiness may reset a stale native DO. Wait for this site's
	// in-flight invocations before verifying; reset must not abort their SQL.
	// Invocation and nonmanaged GET remain read-locked.
	if invoke || (r.Method == "GET" && !managed) {
		lock.RLock()
		defer lock.RUnlock()
	} else {
		lock.Lock()
		defer lock.Unlock()
	}
	if r.Method != "PUT" && s.pendingDeployment(parts[2]) {
		http.Error(w, "deployment transaction pending", 503)
		return
	}
	switch {
	case invoke:
		s.invoke(w, r, dir)
	case r.Method == "PUT":
		s.deploy(w, r, dir)
	case r.Method == "GET":
		bundle, err := load(dir)
		if err != nil {
			storeError(w, err)
			return
		}
		if _, ok := s.runner.(managedRunner); ok {
			if err := s.verifyDeploymentReceipt(r.Context(), dir, bundle.SHA256); err != nil {
				http.Error(w, "persistent runtime not ready", 503)
				return
			}
		}
		writeJSON(w, 200, map[string]string{"sha256": bundle.SHA256, "status": "ready"})
	case r.Method == "DELETE":
		if err := os.RemoveAll(dir); err != nil {
			http.Error(w, "delete failed", 500)
			return
		}
		w.WriteHeader(204)
	}
}

// Admission precedes revision locking, so a hot/blocked site cannot occupy
// every global slot. Only in-flight sites are retained in memory.
func (s *Service) admit(site string) bool {
	s.admissionLock.Lock()
	defer s.admissionLock.Unlock()
	if s.activeSites[site] >= s.siteConcurrency {
		return false
	}
	select {
	case s.slots <- struct{}{}:
		if s.activeSites[site] == 0 {
			s.siteLocks[site] = &sync.RWMutex{}
		}
		s.activeSites[site]++
		return true
	default:
		return false
	}
}
func (s *Service) release(site string) {
	s.admissionLock.Lock()
	defer s.admissionLock.Unlock()
	s.activeSites[site]--
	if s.activeSites[site] == 0 {
		delete(s.activeSites, site)
		delete(s.siteLocks, site)
	}
	<-s.slots
}

// Call only after admission, and unlock before release. Entries are bounded by
// active requests and removed when their last admitted request exits.
func (s *Service) admittedSiteLock(site string) *sync.RWMutex {
	s.admissionLock.Lock()
	defer s.admissionLock.Unlock()
	return s.siteLocks[site]
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*MaxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		http.Error(w, "invalid request", 400)
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		http.Error(w, "invalid request", 400)
		return false
	}
	return true
}
func validBundle(b Bundle) bool {
	sum := sha256.Sum256([]byte(b.Code))
	return len(b.Code) > 0 && len(b.Code) <= MaxCodeBytes && digestPattern.MatchString(b.SHA256) && hex.EncodeToString(sum[:]) == b.SHA256
}
func load(dir string) (Bundle, error) {
	var b Bundle
	f, err := os.Open(filepath.Join(dir, "bundle.json"))
	if err != nil {
		return b, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 2*MaxCodeBytes+1))
	if err != nil {
		return b, err
	}
	if len(data) > 2*MaxCodeBytes || json.Unmarshal(data, &b) != nil || !validBundle(b) {
		return b, fmt.Errorf("invalid stored bundle")
	}
	code, err := os.ReadFile(filepath.Join(dir, "app.mjs"))
	if err != nil {
		return b, err
	}
	if string(code) != b.Code {
		return b, fmt.Errorf("stored code mismatch")
	}
	return b, nil
}
func (s *Service) deploy(w http.ResponseWriter, r *http.Request, dir string) {
	var b Bundle
	if !decode(w, r, &b) {
		return
	}
	if !validBundle(b) {
		http.Error(w, "invalid bundle digest or size", 400)
		return
	}
	if _, managed := s.runner.(managedRunner); managed {
		runner, ok := s.runner.(transactionalManagedRunner)
		if !ok {
			http.Error(w, "transactional runtime adapter unavailable", 503)
			return
		}
		s.deployTransactional(w, r, dir, b, runner)
		return
	}
	previous, err := load(dir)
	if err == nil {
		if previous.SHA256 != b.SHA256 {
			http.Error(w, "immutable release conflict", 409)
			return
		}
		writeJSON(w, 200, map[string]string{"sha256": b.SHA256, "status": "ready"})
		return
	}
	if !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "corrupt release", 500)
		return
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	s.storeLock.Lock()
	defer s.storeLock.Unlock()
	entries, scanErr := os.ReadDir(filepath.Dir(dir))
	total, sizeErr := diskBytes(s.dataDir)
	if scanErr != nil || sizeErr != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	if len(entries) >= 32 || total+int64(8*len(b.Code)+8192) > 1<<30 {
		http.Error(w, "runtime storage quota exceeded", 507)
		return
	}
	temp, err := os.MkdirTemp(filepath.Dir(dir), ".preparing-")
	if err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	defer os.RemoveAll(temp)
	files := map[string]string{"app.mjs": b.Code, "entry.mjs": entryModule, "runtime.capnp": runtimeConfig}
	for name, content := range files {
		if err := writeRuntimeFile(filepath.Join(temp, name), []byte(content)); err != nil {
			http.Error(w, "storage unavailable", 500)
			return
		}
	}
	// The mount root must be traversable by the unprivileged container user.
	if err := os.Chmod(temp, 0755); err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ExecutionTimeout)
	result, err := s.runner.Run(ctx, temp, Invocation{Method: "GET", Path: "/__platform_health"})
	cancel()
	if err != nil || result.Status != 204 {
		http.Error(w, "runtime readiness failed", 422)
		return
	}
	encoded, err := json.Marshal(b)
	if err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	f, err := os.OpenFile(filepath.Join(temp, "bundle.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	_, writeErr := f.Write(encoded)
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	if err := os.Rename(temp, dir); err != nil {
		http.Error(w, "activation failed", 500)
		return
	}
	parent, err := os.Open(filepath.Dir(dir))
	if err != nil {
		http.Error(w, "activation sync failed", 500)
		return
	}
	syncErr = parent.Sync()
	parent.Close()
	if syncErr != nil {
		http.Error(w, "activation sync failed", 500)
		return
	}
	writeJSON(w, 201, map[string]string{"sha256": b.SHA256, "status": "ready"})
}
func (s *Service) invoke(w http.ResponseWriter, r *http.Request, dir string) {
	var in Invocation
	if !decode(w, r, &in) {
		return
	}
	if !validInvocation(in) {
		http.Error(w, "invalid invocation", 400)
		return
	}
	b, err := load(dir)
	if err != nil {
		storeError(w, err)
		return
	}
	if in.SHA256 != b.SHA256 {
		http.Error(w, "release digest mismatch", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ExecutionTimeout)
	defer cancel()
	result, err := s.runner.Run(ctx, dir, in)
	if err != nil {
		http.Error(w, "runtime execution failed", 502)
		return
	}
	if result.Status < 200 || result.Status > 599 || len(result.Body) > MaxResponseBytes {
		http.Error(w, "invalid runtime response", 502)
		return
	}
	result.Headers = allowedHeaders(result.Headers, true)
	writeJSON(w, 200, result)
}
func validInvocation(in Invocation) bool {
	if !digestPattern.MatchString(in.SHA256) || len(in.Body) > MaxBodyBytes {
		return false
	}
	switch in.Method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
	default:
		return false
	}
	u, err := url.ParseRequestURI(in.Path)
	if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(in.Path, "//") || (u.Path != "/api" && !strings.HasPrefix(u.Path, "/api/")) || u.Fragment != "" || path.Clean(u.Path) != u.Path {
		return false
	}
	// Only explicitly permitted application headers enter the user-code boundary.
	for key, value := range in.Headers {
		if len(value) > 8192 || strings.ContainsAny(value, "\r\n") {
			return false
		}
		switch http.CanonicalHeaderKey(key) {
		case "Content-Type", "Accept":
		default:
			return false
		}
	}
	return true
}
func allowedHeaders(in map[string]string, response bool) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		if len(v) > 8192 || strings.ContainsAny(v, "\r\n") {
			continue
		}
		k = http.CanonicalHeaderKey(k)
		if k == "Content-Type" || (!response && k == "Accept") {
			out[k] = v
		}
	}
	return out
}
func storeError(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "release not found", 404)
	} else {
		http.Error(w, "storage unavailable", 500)
	}
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

const entryModule = `import app from './app.mjs';
export default {async fetch(request, env, ctx) {
 if (new URL(request.url).pathname === '/__platform_health') {
  return typeof app.fetch === 'function' ? new Response(null,{status:204}) : new Response(null,{status:500});
 }
 return app.fetch(request,env,ctx);
}};`
const runtimeConfig = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "website", worker = (
   modules = [(name = "entry.mjs", esModule = embed "entry.mjs"),(name = "app.mjs", esModule = embed "app.mjs")],
   compatibilityDate = "2026-09-29", globalOutbound = "deny-egress"
  )),
  (name = "deny-egress", network = (allow = []))
 ],
 sockets = [(name = "http", address = "unix:/socket/http.sock", http = (), service = "website")]
);`

func diskBytes(dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, entry fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected symlink")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}
func (s *Service) siteRequest(w http.ResponseWriter, r *http.Request, site string) {
	if r.Method != "GET" && r.Method != "DELETE" {
		http.Error(w, "method not allowed", 405)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.deployToken)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	if !s.admit(site) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "runtime busy", 429)
		return
	}
	defer s.release(site)
	// Admission retains this site's lock until all admitted requests have released it.
	// Never wait on unrelated tenants' invocations for site management.
	lock := s.admittedSiteLock(site)
	lock.Lock()
	defer lock.Unlock()
	if s.pendingDeployment(site) {
		// An uncertain publication remains fenced for reads, writes and rollback.
		// Explicit irreversible deletion is different: the native DO tombstone
		// wins over even a late activation, without guessing its ownership.
		if r.Method != "DELETE" || !s.pendingSiteDeletionBound(site) {
			http.Error(w, "deployment transaction pending", 503)
			return
		}
	}
	s.storeLock.Lock()
	defer s.storeLock.Unlock()
	dir := filepath.Join(s.dataDir, site)
	if r.Method == "DELETE" {
		if managed, ok := s.runner.(managedRunner); ok {
			ctx, cancel := context.WithTimeout(r.Context(), PrepareTimeout)
			err := managed.DeleteSite(ctx, site)
			cancel()
			if err != nil {
				http.Error(w, "persistent site deletion pending", 503)
				return
			}
		}
		if err := os.RemoveAll(dir); err != nil {
			http.Error(w, "delete failed", 500)
			return
		}
		if err := s.syncDeploymentDir(s.dataDir); err != nil {
			http.Error(w, "delete sync failed", 500)
			return
		}
		s.pendingDeployments.Delete(site)
		w.WriteHeader(204)
		return
	}
	total, err := diskBytes(dir)
	if err != nil {
		http.Error(w, "storage unavailable", 500)
		return
	}
	writeJSON(w, 200, map[string]int64{"storage_bytes": total})
}
