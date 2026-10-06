package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed minisandbox_worker.mjs
var minisandboxWorker string

const maxMinisandboxPackageBytes = 2 << 20 // The reviewed Worker registry limit.
const maxMinisandboxReleases = 32
const PrepareTimeout = 60 * time.Second
const RollbackTimeout = 40 * time.Second

var scopePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,63}$`)
var versionPattern = regexp.MustCompile(`^v_[a-f0-9]{64}$`)
var deploymentPattern = regexp.MustCompile(`^d_[a-f0-9]{32}$`)

type minisandboxPackage struct {
	MainModule        string            `json:"main_module"`
	Modules           map[string]string `json:"modules"`
	CompatibilityDate string            `json:"compatibility_date"`
	DurableObjects    map[string]string `json:"durable_objects"`
	PackageID         string            `json:"-"`
}

func sha256Hex(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func buildMinisandboxPackage(bundles map[string]Bundle) (minisandboxPackage, error) {
	p := minisandboxPackage{MainModule: "main.js", Modules: map[string]string{}, CompatibilityDate: "2026-06-01", DurableObjects: map[string]string{"SITE": "VelaSite"}}
	if len(bundles) == 0 || len(bundles) > maxMinisandboxReleases {
		return p, fmt.Errorf("invalid retained release count")
	}
	digests := make([]string, 0, len(bundles))
	total := 0
	for release, b := range bundles {
		if !identifier.MatchString(release) || !validBundle(b) {
			return p, fmt.Errorf("invalid retained release")
		}
		name := "backend-" + b.SHA256 + ".js"
		if _, exists := p.Modules[name]; !exists {
			p.Modules[name] = b.Code
			total += len(b.Code)
			digests = append(digests, b.SHA256)
		}
	}
	sort.Strings(digests)
	var imports, table strings.Builder
	for i, digest := range digests {
		fmt.Fprintf(&imports, "const backend%d = () => import(%q);\n", i, "./backend-"+digest+".js")
		fmt.Fprintf(&table, "%q: backend%d,\n", digest, i)
	}
	source := imports.String() + "const backends = globalThis.Object.freeze({\n" + table.String() + "});\n" + minisandboxWorker
	p.Modules["main.js"] = source
	var err error
	p.PackageID, err = minisandboxPackageFingerprint(p)
	if err != nil {
		return p, err
	}
	p.Modules["main.js"] = "const platformPackageID = " + fmt.Sprintf("%q", p.PackageID) + ";\n" + source
	total += len(p.Modules["main.js"])
	if total > maxMinisandboxPackageBytes {
		return p, fmt.Errorf("retained Worker package quota exceeded")
	}
	return p, nil
}

var minisandboxPackageMarker = regexp.MustCompile(`^const platformPackageID = "[a-f0-9]{64}";\n`)

// Cover the complete wire package's execution semantics, not just its generated
// JS source. The injected marker is excluded to avoid a circular fingerprint.
// encoding/json canonicalizes map keys; adding wire metadata also covers it here.
func minisandboxPackageFingerprint(p minisandboxPackage) (string, error) {
	source, ok := p.Modules[p.MainModule]
	if !ok {
		return "", fmt.Errorf("missing package main module")
	}
	modules := make(map[string]string, len(p.Modules))
	for name, contents := range p.Modules {
		modules[name] = contents
	}
	if marker := minisandboxPackageMarker.FindString(source); marker != "" {
		source = strings.TrimPrefix(source, marker)
	}
	modules[p.MainModule] = source
	p.Modules = modules
	data, err := json.Marshal(struct {
		Schema  string             `json:"fingerprint_schema"`
		Package minisandboxPackage `json:"package"`
	}{Schema: "lightvela-minisandbox-package/v2", Package: p})
	if err != nil {
		return "", err
	}
	return sha256Hex(data), nil
}

// Scope and site IDs come exclusively from server configuration/control metadata.
// Never key persistent storage by release: redeploy and rollback share this ID.
func minisandboxIdentity(scope, site string) (string, error) {
	if !scopePattern.MatchString(scope) || !identifier.MatchString(site) {
		return "", fmt.Errorf("invalid minisandbox identity")
	}
	return sha256Hex([]byte("lightvela-website-v1\x00" + scope + "\x00" + site)), nil
}

type managedRunner interface {
	Runner
	Prepare(context.Context, string, map[string]Bundle) (string, error)
	Verify(context.Context, string, string, string) error
	DeleteSite(context.Context, string) error
}

type minisandboxClient struct {
	base, scope string
	http        *http.Client
}

// NewMinisandboxRunner connects to the reviewed private Workers API. There is no
// local JS engine, network proxy, credential forwarding, or Docker fallback.
func NewMinisandboxRunner(base, scope string) (Runner, error) {
	return newMinisandboxClient(base, scope, nil)
}
func newMinisandboxClient(base, scope string, client *http.Client) (*minisandboxClient, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || !scopePattern.MatchString(scope) {
		return nil, fmt.Errorf("invalid minisandbox endpoint/scope")
	}
	if client == nil {
		client = &http.Client{Timeout: PrepareTimeout}
	} else {
		copyClient := *client
		client = &copyClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &minisandboxClient{base: strings.TrimRight(base, "/"), scope: scope, http: client}, nil
}
func (c *minisandboxClient) workerPath(site string) (string, error) {
	id, err := minisandboxIdentity(c.scope, site)
	if err != nil {
		return "", err
	}
	// Workers have a 63-character name limit, unlike the existing website IDs.
	return "/v1/workers/lv-" + id[:56], nil
}
func (c *minisandboxClient) objectPath(site string) (string, error) {
	worker, err := c.workerPath(site)
	if err != nil {
		return "", err
	}
	id, _ := minisandboxIdentity(c.scope, site)
	return worker + "/objects/VelaSite/" + id, nil
}
func (c *minisandboxClient) jsonRequest(ctx context.Context, method, path string, input, output any) (int, error) {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return 0, err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("minisandbox unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("minisandbox rejected %s: %d", method, resp.StatusCode)
	}
	if output != nil {
		data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10+1))
		if err != nil || len(data) > 64<<10 {
			return resp.StatusCode, fmt.Errorf("invalid minisandbox response")
		}
		if json.Unmarshal(data, output) != nil {
			return resp.StatusCode, fmt.Errorf("invalid minisandbox response")
		}
	}
	return resp.StatusCode, nil
}

type minisandboxTarget struct {
	VersionID  string  `json:"version_id"`
	Percentage float64 `json:"percentage"`
}
type minisandboxDeployment struct {
	ID       string              `json:"id"`
	Versions []minisandboxTarget `json:"versions"`
}

func validMinisandboxDeployment(d minisandboxDeployment) bool {
	if !deploymentPattern.MatchString(d.ID) || len(d.Versions) < 1 || len(d.Versions) > 2 {
		return false
	}
	total := 0.0
	seen := map[string]bool{}
	for _, target := range d.Versions {
		if !versionPattern.MatchString(target.VersionID) || target.Percentage <= 0 || target.Percentage > 100 || seen[target.VersionID] {
			return false
		}
		seen[target.VersionID] = true
		total += target.Percentage
	}
	return total == 100
}
func sameMinisandboxTargets(a, b []minisandboxTarget) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (c *minisandboxClient) Prepare(ctx context.Context, site string, bundles map[string]Bundle) (versionID string, prepareErr error) {
	p, err := buildMinisandboxPackage(bundles)
	if err != nil {
		return "", err
	}
	worker, err := c.workerPath(site)
	if err != nil {
		return "", err
	}
	var version struct {
		ID string `json:"id"`
	}
	if _, err = c.jsonRequest(ctx, "POST", worker+"/versions", p, &version); err != nil {
		return "", err
	}
	if !versionPattern.MatchString(version.ID) {
		return "", fmt.Errorf("invalid minisandbox version")
	}
	var current minisandboxDeployment
	status, err := c.jsonRequest(ctx, "GET", worker+"/deployment", nil, &current)
	if err != nil && status != http.StatusNotFound {
		return "", err
	}
	if current.ID != "" && !validMinisandboxDeployment(current) {
		return "", fmt.Errorf("invalid minisandbox deployment")
	}
	var activated struct {
		ID string `json:"id"`
	}
	input := map[string]string{"version_id": version.ID, "expected_deployment_id": current.ID}
	status, err = c.jsonRequest(ctx, "POST", worker+"/deployments", input, &activated)
	if err != nil {
		return "", err
	}
	if status != http.StatusCreated && status != http.StatusOK {
		return "", fmt.Errorf("invalid minisandbox activation status")
	}
	ownedActivation := status == http.StatusCreated
	if !deploymentPattern.MatchString(activated.ID) {
		return "", fmt.Errorf("invalid minisandbox activation")
	}
	// A failed link must not strand existing sites on a new upstream pointer
	// while their local readiness receipt still names the previous version.
	// Only compensate the exact activation we made; CAS must fence a competing
	// deploy. A 200 convergence response belongs to another request and must not
	// be compensated. Detached context also permits rollback after cancellation.
	defer func() {
		if prepareErr == nil || !ownedActivation || current.ID == "" || current.ID == activated.ID {
			return
		}
		rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), RollbackTimeout)
		defer cancel()
		var restored minisandboxDeployment
		input := map[string]any{"versions": current.Versions, "expected_deployment_id": activated.ID}
		if _, err := c.jsonRequest(rollbackCtx, "POST", worker+"/deployments", input, &restored); err != nil {
			prepareErr = fmt.Errorf("%w; minisandbox rollback failed: %v", prepareErr, err)
			return
		}
		if !validMinisandboxDeployment(restored) || !sameMinisandboxTargets(current.Versions, restored.Versions) {
			prepareErr = fmt.Errorf("%w; minisandbox rollback response mismatch", prepareErr)
		}
	}()
	// Link all retained user modules after isolating platform primordials, but
	// never call user fetch/SQL. CTL's active site pointer has not switched.
	// The publishing API replica is fenced immediately; its peers learn the
	// cursor asynchronously. Fence actual stateless execution rather than
	// assuming the first load-balanced probe observes the publication.
	if err := c.verifyPrivatePackage(ctx, worker+"/dispatch", p.PackageID); err != nil {
		return "", err
	}
	if err := c.verifyDurablePackage(ctx, site, p.PackageID); err != nil {
		return "", err
	}
	return version.ID, nil
}
func (c *minisandboxClient) prepare(ctx context.Context, site string, bundles map[string]Bundle) error {
	_, err := c.Prepare(ctx, site, bundles)
	return err
}
func (c *minisandboxClient) Verify(ctx context.Context, site, version, packageID string) error {
	if !versionPattern.MatchString(version) {
		return fmt.Errorf("invalid prepared version")
	}
	current, err := c.Snapshot(ctx, site)
	if err != nil {
		return err
	}
	if !current.Exists || !sameMinisandboxTargets(current.Targets, []minisandboxTarget{{VersionID: version, Percentage: 100}}) {
		return fmt.Errorf("minisandbox active version mismatch")
	}
	// There is no legacy single-snapshot readiness shortcut: verify exact pointer,
	// both execution paths, and the pointer again after all control probes.
	return c.VerifyPrepared(ctx, site, current, packageID)
}

// A retained Object can still be running old code after stateless preparation.
// Read-only control probes require the actual durable isolate to converge before
// CTL may switch the website pointer. No application handler or SQL is invoked.
func (c *minisandboxClient) verifyDurablePackage(parent context.Context, site, packageID string) error {
	object, err := c.objectPath(site)
	if err != nil {
		return err
	}
	return c.verifyPrivatePackageMode(parent, object+"/fetch", packageID, true)
}

// Both facade replicas and native Hosts have independent deployment caches.
// Poll only the platform control endpoint, never a replayable app handler. A
// malformed response fails immediately; a valid stale package may converge
// within this fence, but a permanently stale isolate can never become ready.
func (c *minisandboxClient) verifyPrivatePackage(parent context.Context, endpoint, packageID string) error {
	return c.verifyPrivatePackageMode(parent, endpoint, packageID, false)
}

func (c *minisandboxClient) verifyPrivatePackageMode(parent context.Context, endpoint, packageID string, durable bool) error {
	if !digestPattern.MatchString(packageID) {
		return fmt.Errorf("invalid compiled package ID")
	}
	probeTimeout := 3 * time.Second
	if durable {
		// Normal Engine stop/checkpoint/reallocation is not a three-second
		// stateless watcher-cache refresh. Parent context still bounds this wait.
		probeTimeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	resetArmed := false
	rotationArmed := false
	for {
		req, err := http.NewRequestWithContext(ctx, "GET", c.base+endpoint, nil)
		if err != nil {
			return err
		}
		req.Header.Set("X-Workers-Original-URL", "https://website.invalid/__platform_prepare")
		if resetArmed {
			req.Header.Set("X-Lightvela-Expected-Package-ID", packageID)
		}
		resp, requestErr := c.http.Do(req)
		if requestErr != nil {
			if (!resetArmed && !rotationArmed) || ctx.Err() != nil {
				return fmt.Errorf("minisandbox package unavailable")
			}
		} else {
			data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1025))
			resp.Body.Close()
			// Native state.abort breaks the stale class container without deleting its
			// Depot database. Only an armed, private control probe may retry its transient
			// failure. No application handler or SQL is ever replayed by this fence.
			resetting := (resetArmed || rotationArmed) && (resp.StatusCode == http.StatusInternalServerError || resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusGatewayTimeout)
			// Executor admission/cold preparation can briefly be unavailable while
			// the platform itself stays Ready. Only the native, explicitly retryable
			// 503 envelope may be polled, within the bounded preparation fence.
			// This endpoint is the wrapper's private preparation path: it never
			// invokes application fetch or SQL and cannot arm a durable reset.
			// Native generation rotation is also safe to poll here: Host emits this
			// exact code before dispatch, and Workers API strips internal headers.
			var unavailable struct {
				Error struct {
					Code      string `json:"code"`
					Retryable bool   `json:"retryable"`
				} `json:"error"`
			}
			preparing := readErr == nil && len(data) <= 1024 && resp.StatusCode == http.StatusServiceUnavailable &&
				json.Unmarshal(data, &unavailable) == nil && unavailable.Error.Retryable &&
				((resp.Header.Get("X-Workers-Error") == "true" && (unavailable.Error.Code == "executor_unavailable" || unavailable.Error.Code == "worker_prepare_failed" || unavailable.Error.Code == "executor_overloaded")) ||
					(durable && unavailable.Error.Code == "worker_version_rotating"))
			if preparing && durable && unavailable.Error.Code == "worker_version_rotating" {
				rotationArmed = true
			}
			if !resetting && !preparing {
				var compiled struct {
					PackageID string `json:"package_id"`
				}
				if readErr != nil || len(data) > 1024 || resp.StatusCode != http.StatusOK || json.Unmarshal(data, &compiled) != nil || !digestPattern.MatchString(compiled.PackageID) {
					return fmt.Errorf("minisandbox compiled package preparation failed")
				}
				if compiled.PackageID == packageID {
					return nil
				}
				// Observe a legitimate stale compiled marker before arming reset. Stateless
				// replicas only converge their watcher cache; they cannot acquire this reset.
				resetArmed = durable
			}
		}
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("minisandbox compiled package mismatch")
		case <-timer.C:
		}
	}
}

// A local atomic site receipt binds readiness to the compiled upstream version
// and its retained digests. A registry deployment belonging to someone else,
// even if nominally ready, cannot satisfy website rollback/activation checks.
type minisandboxReceipt struct {
	PackageID string   `json:"package_id"`
	Version   string   `json:"version"`
	Digests   []string `json:"digests"`
}

func saveMinisandboxReceipt(siteDir, version string, bundles map[string]Bundle) error {
	compiled, err := buildMinisandboxPackage(bundles)
	if err != nil {
		return err
	}
	receipt := minisandboxReceipt{Version: version, PackageID: compiled.PackageID}
	for _, b := range bundles {
		receipt.Digests = append(receipt.Digests, b.SHA256)
	}
	sort.Strings(receipt.Digests)
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(siteDir, ".receipt-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(siteDir, ".minisandbox.json")); err != nil {
		return err
	}
	d, err := os.Open(siteDir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func verifyMinisandboxReceipt(ctx context.Context, managed managedRunner, dir, digest string) error {
	siteDir := filepath.Dir(dir)
	f, err := os.Open(filepath.Join(siteDir, ".minisandbox.json"))
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 8193))
	if err != nil || len(data) > 8192 {
		return fmt.Errorf("invalid minisandbox receipt")
	}
	var receipt minisandboxReceipt
	if json.Unmarshal(data, &receipt) != nil || len(receipt.Digests) == 0 || len(receipt.Digests) > maxMinisandboxReleases {
		return fmt.Errorf("invalid minisandbox receipt")
	}
	found := false
	for _, d := range receipt.Digests {
		if d == digest {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("backend is not retained")
	}
	return managed.Verify(ctx, filepath.Base(siteDir), receipt.Version, receipt.PackageID)
}
func (c *minisandboxClient) DeleteSite(ctx context.Context, site string) error {
	object, err := c.objectPath(site)
	if err != nil {
		return err
	}
	_, err = c.jsonRequest(ctx, "DELETE", object, nil, nil)
	// Do not issue Worker DELETE: the reviewed registry rejects historical DO
	// inventory and its durable tombstone must not be bypassed for recreation.
	return err
}

const minisandboxExecutionPackageHeader = "X-Lightvela-Execution-Package-ID"
const minisandboxExecutionDigestHeader = "X-Lightvela-Execution-Backend-SHA256"

// Run cannot rely on a previous private probe: native execution can drift after
// readiness. Bind this one application response to control-owned schema2 state,
// the validated stored bundle and the original invocation before contacting DO.
func (c *minisandboxClient) executionReceipt(dir, digest string) (deploymentReceipt, error) {
	var receipt deploymentReceipt
	bundle, err := load(dir)
	if err != nil || bundle.SHA256 != digest {
		return receipt, fmt.Errorf("minisandbox stored execution identity mismatch")
	}
	data, err := readDeploymentFile(filepath.Join(filepath.Dir(dir), ".minisandbox.json"), 8192)
	if err != nil {
		return receipt, fmt.Errorf("minisandbox execution receipt unavailable")
	}
	receipt, err = parseDeploymentReceipt(data)
	if err != nil || receipt.Schema != 2 {
		return receipt, fmt.Errorf("invalid minisandbox execution receipt")
	}
	identity, err := c.DeploymentIdentity(filepath.Base(filepath.Dir(dir)))
	if err != nil || identity != receipt.Identity {
		return receipt, fmt.Errorf("minisandbox execution receipt identity mismatch")
	}
	for _, retained := range receipt.Digests {
		if retained == digest {
			return receipt, nil
		}
	}
	return receipt, fmt.Errorf("minisandbox execution backend is not retained")
}

func (c *minisandboxClient) Run(ctx context.Context, dir string, in Invocation) (Result, error) {
	var result Result
	site := filepath.Base(filepath.Dir(dir))
	if !validInvocation(in) {
		return result, fmt.Errorf("invalid minisandbox invocation")
	}
	object, err := c.objectPath(site)
	if err != nil {
		return result, err
	}
	receipt, err := c.executionReceipt(dir, in.SHA256)
	if err != nil {
		return result, err
	}
	// Stable PUT is idempotent and completes Actor readiness before user fetch.
	if _, err = c.jsonRequest(ctx, "PUT", object, nil, nil); err != nil {
		return result, err
	}
	// GET/HEAD handlers can write SQL too. A non-rewindable body (even when
	// empty) prevents net/http's implicit replay on a reused connection after
	// an application response is lost; no GetBody/idempotency escape hatch.
	req, err := http.NewRequestWithContext(ctx, in.Method, c.base+object+"/fetch", io.NopCloser(bytes.NewReader(in.Body)))
	if err != nil {
		return result, err
	}
	req.ContentLength = int64(len(in.Body))
	for k, v := range allowedHeaders(in.Headers, false) {
		req.Header.Set(k, v)
	}
	req.Header.Set("X-Workers-Original-URL", "https://website.invalid"+in.Path)
	req.Header.Set("X-Lightvela-Backend-Digest", in.SHA256)
	if in.ReadOnly {
		req.Header.Set("X-Lightvela-Storage-Read-Only", "1")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("minisandbox invocation unavailable")
	}
	defer resp.Body.Close()
	// Missing, conflicting or foreign execution markers fail closed even on
	// HTTP 200 (including native fixture JSON). Never probe, reset or replay the
	// application request after it may already have committed SQL side effects.
	packages := resp.Header.Values(minisandboxExecutionPackageHeader)
	digests := resp.Header.Values(minisandboxExecutionDigestHeader)
	if len(packages) != 1 || packages[0] != receipt.PackageID || len(digests) != 1 || digests[0] != in.SHA256 {
		return result, fmt.Errorf("minisandbox response execution identity mismatch")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil || len(body) > MaxResponseBytes {
		return result, fmt.Errorf("minisandbox response too large")
	}
	result.Status = resp.StatusCode
	result.Body = body
	result.Headers = map[string]string{"Content-Type": resp.Header.Get("Content-Type")}
	return result, nil
}

func retainedBundles(dir string, candidate Bundle) (map[string]Bundle, error) {
	entries, err := os.ReadDir(filepath.Dir(dir))
	if err != nil {
		return nil, err
	}
	bundles := map[string]Bundle{filepath.Base(dir): candidate}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if !identifier.MatchString(entry.Name()) {
			return nil, fmt.Errorf("invalid release directory")
		}
		b, err := load(filepath.Join(filepath.Dir(dir), entry.Name()))
		if err != nil {
			return nil, err
		}
		bundles[entry.Name()] = b
	}
	return bundles, nil
}
