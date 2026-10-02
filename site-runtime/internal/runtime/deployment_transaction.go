package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// These types form the native adapter contract. HTTP200 is convergence, never
// evidence that this request owns the returned deployment.
type DeploymentState struct {
	Exists  bool                `json:"exists"`
	ID      string              `json:"id"`
	Targets []minisandboxTarget `json:"targets"`
}
type ActivationOwnership string

const (
	ActivationOwned    ActivationOwnership = "owned"
	ActivationBorrowed ActivationOwnership = "borrowed"
	ActivationUnknown  ActivationOwnership = "unknown"
)

type ActivationResult struct {
	Deployment DeploymentState     `json:"deployment"`
	Ownership  ActivationOwnership `json:"ownership"`
	HTTPStatus int                 `json:"http_status"`
}
type PreparedPackage struct{ VersionID, PackageID string }
type transactionalManagedRunner interface {
	managedRunner
	Snapshot(context.Context, string) (DeploymentState, error)
	Stage(context.Context, string, map[string]Bundle) (PreparedPackage, error)
	ActivateCAS(context.Context, string, DeploymentState, string) (ActivationResult, error)
	VerifyPrepared(context.Context, string, DeploymentState, string) error
	RestoreCAS(context.Context, string, string, DeploymentState) (ActivationResult, error)
	DeploymentIdentity(string) (string, error)
}

const deploymentJournalName = ".deploy-txn.json"
const maxDeploymentJournalBytes = 16*maxMinisandboxPackageBytes + 32768
const startupDeploymentRecoveryTimeout = time.Second

var (
	errDeploymentPending       = errors.New("deployment transaction pending")
	errDeploymentConflict      = errors.New("deployment transaction conflict")
	errDeploymentQuota         = errors.New("deployment storage quota exceeded")
	errDeploymentCommitUnknown = errors.New("deployment commit durability unknown")
)

type deploymentTransaction struct {
	Schema           int                `json:"schema"`
	TxID             string             `json:"tx_id"`
	Identity         string             `json:"identity"`
	Site             string             `json:"site"`
	Release          string             `json:"release"`
	Digest           string             `json:"digest"`
	PackageID        string             `json:"package_id"`
	VersionID        string             `json:"version_id"`
	Package          minisandboxPackage `json:"package"`
	Retained         map[string]string  `json:"retained"`
	Before           DeploymentState    `json:"before"`
	HasBeforeReceipt bool               `json:"has_before_receipt"`
	BeforeReceipt    []byte             `json:"before_receipt"`
	Activation       ActivationResult   `json:"activation"`
	Restored         ActivationResult   `json:"restored"`
	Phase            string             `json:"phase"`
	Decision         string             `json:"decision"`
	NoPreviousPolicy string             `json:"no_previous_policy"`
}

type deploymentReceipt struct {
	minisandboxReceipt
	Schema       int                 `json:"schema,omitempty"`
	TxID         string              `json:"tx_id,omitempty"`
	Identity     string              `json:"identity,omitempty"`
	DeploymentID string              `json:"deployment_id,omitempty"`
	Ownership    ActivationOwnership `json:"ownership,omitempty"`
}

// Narrow file operations permit failures at the actual Write/Sync/Close/rename
// boundaries, including a successful rename followed by a directory-sync error.
type deploymentFile interface {
	io.Writer
	Name() string
	Sync() error
	Close() error
}
type deploymentFileOps interface {
	MkdirAll(string, os.FileMode) error
	CreateTemp(string, string) (deploymentFile, error)
	OpenFile(string, int, os.FileMode) (deploymentFile, error)
	OpenDir(string) (deploymentFile, error)
	Rename(string, string) error
	Remove(string) error
	RemoveAll(string) error
}
type osDeploymentFiles struct{}

func (osDeploymentFiles) MkdirAll(p string, m os.FileMode) error         { return os.MkdirAll(p, m) }
func (osDeploymentFiles) CreateTemp(d, p string) (deploymentFile, error) { return os.CreateTemp(d, p) }
func (osDeploymentFiles) OpenFile(p string, f int, m os.FileMode) (deploymentFile, error) {
	return os.OpenFile(p, f, m)
}
func (osDeploymentFiles) OpenDir(p string) (deploymentFile, error) { return os.Open(p) }
func (osDeploymentFiles) Rename(a, b string) error                 { return os.Rename(a, b) }
func (osDeploymentFiles) Remove(p string) error                    { return os.Remove(p) }
func (osDeploymentFiles) RemoveAll(p string) error                 { return os.RemoveAll(p) }

func (s *Service) syncDeploymentDir(dir string) error {
	f, err := s.deployFiles.OpenDir(dir)
	if err != nil {
		return err
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	return errors.Join(syncErr, closeErr)
}
func (s *Service) writeDeploymentFile(name string, data []byte) error {
	f, err := s.deployFiles.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	n, writeErr := f.Write(data)
	if writeErr == nil && n != len(data) {
		writeErr = io.ErrShortWrite
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	return errors.Join(writeErr, syncErr, closeErr)
}
func (s *Service) atomicDeploymentFile(dir, name, pattern string, data []byte) error {
	f, err := s.deployFiles.CreateTemp(dir, pattern)
	if err != nil {
		return err
	}
	temp := f.Name()
	defer s.deployFiles.Remove(temp)
	n, writeErr := f.Write(data)
	if writeErr == nil && n != len(data) {
		writeErr = io.ErrShortWrite
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if err = s.deployFiles.Rename(temp, filepath.Join(dir, name)); err != nil {
		return err
	}
	return s.syncDeploymentDir(dir)
}
func readDeploymentFile(name string, limit int64) ([]byte, error) {
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("unexpected deployment file")
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(f, limit+1))
	closeErr := f.Close()
	if len(data) > int(limit) {
		return nil, errors.New("deployment file too large")
	}
	return data, errors.Join(readErr, closeErr)
}

// Validate the saved wire package, not the current binary's compatibility date
// or embedded wrapper. A redeployed binary must not rebuild an in-flight package.
func validDeploymentCompatibilityDate(date string) bool {
	_, err := time.Parse("2006-01-02", date)
	return len(date) == 10 && err == nil
}

func validDeploymentState(state DeploymentState) bool {
	if !state.Exists {
		return state.ID == "" && len(state.Targets) == 0
	}
	return validMinisandboxDeployment(minisandboxDeployment{ID: state.ID, Versions: state.Targets})
}
func candidateDeployment(state DeploymentState, version string) bool {
	return validDeploymentState(state) && state.Exists && len(state.Targets) == 1 && state.Targets[0].VersionID == version && state.Targets[0].Percentage == 100
}
func ownedActivation(a ActivationResult) bool {
	return a.Ownership == ActivationOwned && a.HTTPStatus == http.StatusCreated && validDeploymentState(a.Deployment) && a.Deployment.Exists
}
func validActivation(a ActivationResult, version string) bool {
	return candidateDeployment(a.Deployment, version) && ((a.Ownership == ActivationOwned && a.HTTPStatus == 201) || (a.Ownership == ActivationBorrowed && a.HTTPStatus == 200))
}
func (t *deploymentTransaction) root(dataDir string) string {
	return filepath.Join(dataDir, t.Site, ".deploy-"+t.TxID)
}
func (t *deploymentTransaction) bundles() (map[string]Bundle, error) {
	bundles := make(map[string]Bundle, len(t.Retained))
	if len(t.Retained) == 0 || len(t.Retained) > maxMinisandboxReleases {
		return nil, errDeploymentPending
	}
	for release, digest := range t.Retained {
		if !identifier.MatchString(release) || !digestPattern.MatchString(digest) {
			return nil, errDeploymentPending
		}
		b := Bundle{SHA256: digest, Code: t.Package.Modules["backend-"+digest+".js"]}
		if !validBundle(b) {
			return nil, errDeploymentPending
		}
		bundles[release] = b
	}
	return bundles, nil
}
func (t *deploymentTransaction) validate(site string) error {
	if t.Schema != 1 || t.Site != site || !identifier.MatchString(site) || !identifier.MatchString(t.Release) || len(t.TxID) != 32 || t.Identity == "" || len(t.Identity) > 4096 || !digestPattern.MatchString(t.PackageID) || !validDeploymentState(t.Before) || t.NoPreviousPolicy != "finish_verified_publication" {
		return errDeploymentPending
	}
	if _, err := hex.DecodeString(t.TxID); err != nil || strings.ToLower(t.TxID) != t.TxID {
		return errDeploymentPending
	}
	switch t.Phase {
	case "staged", "versioned", "activating", "activation_unknown", "activated", "verified", "publishing", "committed", "aborting", "rollback_unknown", "aborted", "conflict":
	default:
		return errDeploymentPending
	}
	if t.Decision != "" && t.Decision != "abort" && t.Decision != "commit" {
		return errDeploymentPending
	}
	if t.Phase == "committed" && t.Decision != "commit" {
		return errDeploymentPending
	}
	if t.Phase != "staged" && t.Phase != "aborted" && t.Phase != "aborting" && !versionPattern.MatchString(t.VersionID) {
		return errDeploymentPending
	}
	if t.Retained[t.Release] != t.Digest || !digestPattern.MatchString(t.Digest) {
		return errDeploymentPending
	}
	if _, err := t.bundles(); err != nil {
		return err
	}
	p := t.Package
	if p.MainModule != "main.js" || !validDeploymentCompatibilityDate(p.CompatibilityDate) || len(p.DurableObjects) != 1 || p.DurableObjects["SITE"] != "VelaSite" {
		return errDeploymentPending
	}
	prefix := fmt.Sprintf("const platformPackageID = %q;\n", t.PackageID)
	main := p.Modules["main.js"]
	if !strings.HasPrefix(main, prefix) {
		return errDeploymentPending
	}
	// The exact marker and metadata were checked above. Fingerprint the full
	// versioned package through the native adapter's canonical algorithm; the
	// helper excludes the injected marker itself. Never upgrade an old source-
	// only journal in place or remove its artifacts on an algorithm mismatch.
	fingerprint, err := minisandboxPackageFingerprint(p)
	if err != nil || fingerprint != t.PackageID {
		return errDeploymentPending
	}
	digests := map[string]bool{}
	total := 0
	for _, d := range t.Retained {
		digests[d] = true
	}
	if len(p.Modules) != len(digests)+1 {
		return errDeploymentPending
	}
	for _, v := range p.Modules {
		total += len(v)
	}
	if total > maxMinisandboxPackageBytes {
		return errDeploymentPending
	}
	if t.Before.Exists {
		receipt, err := parseDeploymentReceipt(t.BeforeReceipt)
		if !t.HasBeforeReceipt || err != nil || receipt.Schema < 2 || receipt.Identity != t.Identity || receipt.DeploymentID != t.Before.ID || !candidateDeployment(t.Before, receipt.Version) {
			return errDeploymentPending
		}
	} else if t.HasBeforeReceipt || len(t.BeforeReceipt) > 0 {
		return errDeploymentPending
	}
	if t.Activation.Ownership == ActivationOwned && !ownedActivation(t.Activation) {
		return errDeploymentPending
	}
	if t.Activation.Ownership == ActivationBorrowed && !validActivation(t.Activation, t.VersionID) {
		return errDeploymentPending
	}
	if (t.Phase == "activated" || t.Phase == "verified" || t.Phase == "publishing" || t.Phase == "committed") && !validActivation(t.Activation, t.VersionID) {
		return errDeploymentPending
	}
	return nil
}
func parseDeploymentReceipt(data []byte) (deploymentReceipt, error) {
	var receipt deploymentReceipt
	if len(data) > 8192 || json.Unmarshal(data, &receipt) != nil || !digestPattern.MatchString(receipt.PackageID) || !versionPattern.MatchString(receipt.Version) || len(receipt.Digests) == 0 || len(receipt.Digests) > maxMinisandboxReleases {
		return receipt, errDeploymentPending
	}
	for _, digest := range receipt.Digests {
		if !digestPattern.MatchString(digest) {
			return receipt, errDeploymentPending
		}
	}
	if receipt.Schema != 0 && receipt.Schema != 2 {
		return receipt, errDeploymentPending
	}
	if receipt.Schema == 0 && (receipt.TxID != "" || receipt.Identity != "" || receipt.DeploymentID != "" || receipt.Ownership != "") {
		return receipt, errDeploymentPending
	}
	if receipt.Schema == 2 && (!deploymentPattern.MatchString(receipt.DeploymentID) || receipt.Identity == "" || (receipt.Ownership != ActivationOwned && receipt.Ownership != ActivationBorrowed)) {
		return receipt, errDeploymentPending
	}
	return receipt, nil
}
func (s *Service) checkpointDeployment(t *deploymentTransaction) error {
	s.pendingDeployments.Store(t.Site, t)
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	if len(data) > maxDeploymentJournalBytes {
		return errDeploymentQuota
	}
	return s.atomicDeploymentFile(filepath.Join(s.dataDir, t.Site), deploymentJournalName, ".txn-"+t.Phase+"-*", data)
}
func (s *Service) pendingDeployment(site string) bool {
	if _, managed := s.runner.(managedRunner); !managed {
		return false
	}
	if _, ok := s.pendingDeployments.Load(site); ok {
		return true
	}
	_, err := os.Lstat(filepath.Join(s.dataDir, site, deploymentJournalName))
	if !errors.Is(err, os.ErrNotExist) {
		return true
	}
	// The completed receipt remains an identity fence after journal cleanup.
	// Check it locally before invocation too: GET readiness alone cannot stop an
	// application write being dispatched into a newly configured endpoint/scope.
	// This adds no native probe or application execution to the request gate.
	data, readErr := readDeploymentFile(filepath.Join(s.dataDir, site, ".minisandbox.json"), 8192)
	if readErr != nil {
		if !errors.Is(readErr, os.ErrNotExist) {
			return true
		}
		// No receipt is expected before a site's first publication. Once a
		// release artifact exists, absence cannot prove endpoint/scope ownership:
		// never dispatch an existing release into a newly configured database.
		entries, dirErr := os.ReadDir(filepath.Join(s.dataDir, site))
		if dirErr != nil {
			return !errors.Is(dirErr, os.ErrNotExist)
		}
		for _, entry := range entries {
			if identifier.MatchString(entry.Name()) {
				return true
			}
		}
		return false
	}
	receipt, parseErr := parseDeploymentReceipt(data)
	if parseErr != nil {
		return true
	}
	if _, transactional := s.runner.(transactionalManagedRunner); transactional && receipt.Schema < 2 {
		// An old receipt cannot prove its original endpoint. Explicit migration
		// requires that evidence; matching code at the current endpoint is not it.
		return true
	}
	if receipt.Schema == 2 {
		// Never downgrade a v2 receipt to an unbound legacy verifier.
		runner, ok := s.runner.(transactionalManagedRunner)
		if !ok {
			return true
		}
		identity, identityErr := runner.DeploymentIdentity(site)
		return identityErr != nil || identity != receipt.Identity
	}
	return false
}
func (s *Service) loadDeploymentTransaction(site string) (*deploymentTransaction, error) {
	data, err := readDeploymentFile(filepath.Join(s.dataDir, site, deploymentJournalName), maxDeploymentJournalBytes)
	var t *deploymentTransaction
	if err == nil {
		t = &deploymentTransaction{}
		if json.Unmarshal(data, t) != nil {
			return nil, errDeploymentPending
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errDeploymentPending
	}
	if memory, ok := s.pendingDeployments.Load(site); ok {
		m := memory.(*deploymentTransaction)
		if t == nil || (t.TxID == m.TxID && t.Phase != "committed") {
			t = m
		}
	}
	if t == nil {
		return nil, nil
	}
	if err := t.validate(site); err != nil {
		return nil, err
	}
	s.pendingDeployments.Store(site, t)
	return t, nil
}
func (s *Service) verifyDeploymentReceipt(ctx context.Context, dir, digest string) error {
	data, err := readDeploymentFile(filepath.Join(filepath.Dir(dir), ".minisandbox.json"), 8192)
	if err != nil {
		return err
	}
	receipt, err := parseDeploymentReceipt(data)
	if err != nil {
		return err
	}
	found := false
	for _, d := range receipt.Digests {
		if d == digest {
			found = true
		}
	}
	if !found {
		return errDeploymentPending
	}
	if _, transactional := s.runner.(transactionalManagedRunner); transactional && receipt.Schema < 2 {
		return errDeploymentPending
	}
	if receipt.Schema == 2 {
		runner, ok := s.runner.(transactionalManagedRunner)
		if !ok {
			return errDeploymentPending
		}
		identity, err := runner.DeploymentIdentity(filepath.Base(filepath.Dir(dir)))
		if err != nil || identity != receipt.Identity {
			return errDeploymentPending
		}
		state := DeploymentState{Exists: true, ID: receipt.DeploymentID, Targets: []minisandboxTarget{{VersionID: receipt.Version, Percentage: 100}}}
		return runner.VerifyPrepared(ctx, filepath.Base(filepath.Dir(dir)), state, receipt.PackageID)
	}
	runner, ok := s.runner.(managedRunner)
	if !ok {
		return errDeploymentPending
	}
	return runner.Verify(ctx, filepath.Base(filepath.Dir(dir)), receipt.Version, receipt.PackageID)
}

func (s *Service) beginDeployment(ctx context.Context, runner transactionalManagedRunner, dir string, b Bundle) (*deploymentTransaction, error) {
	site := filepath.Base(filepath.Dir(dir))
	identity, err := runner.DeploymentIdentity(site)
	if err != nil || identity == "" || len(identity) > 4096 {
		return nil, errDeploymentPending
	}
	receiptData, receiptErr := readDeploymentFile(filepath.Join(filepath.Dir(dir), ".minisandbox.json"), 8192)
	hasReceipt := receiptErr == nil
	if receiptErr != nil && !errors.Is(receiptErr, os.ErrNotExist) {
		return nil, errDeploymentPending
	}
	var receipt deploymentReceipt
	if hasReceipt {
		receipt, err = parseDeploymentReceipt(receiptData)
		if err != nil || receipt.Schema < 2 || receipt.Identity != identity {
			return nil, errDeploymentPending
		}
	}
	// Reject an unbound legacy receipt before even consulting a new endpoint.
	before, err := runner.Snapshot(ctx, site)
	if err != nil || !validDeploymentState(before) {
		return nil, errDeploymentPending
	}
	if before.Exists {
		if !hasReceipt || !candidateDeployment(before, receipt.Version) || receipt.DeploymentID != before.ID {
			return nil, errDeploymentPending
		}
		if err = runner.VerifyPrepared(ctx, site, before, receipt.PackageID); err != nil {
			return nil, errDeploymentPending
		}
	} else if hasReceipt {
		return nil, errDeploymentPending
	}
	s.storeLock.Lock()
	defer s.storeLock.Unlock()
	if err = s.deployFiles.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return nil, err
	}
	if err = s.syncDeploymentDir(s.dataDir); err != nil {
		return nil, err
	}
	bundles, err := retainedBundles(dir, b)
	if err != nil {
		return nil, err
	}
	if !before.Exists && len(bundles) != 1 {
		return nil, errDeploymentPending
	}
	pkg, err := buildMinisandboxPackage(bundles)
	if err != nil {
		return nil, err
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return nil, err
	}
	t := &deploymentTransaction{Schema: 1, TxID: hex.EncodeToString(random), Identity: identity, Site: site, Release: filepath.Base(dir), Digest: b.SHA256, PackageID: pkg.PackageID, Package: pkg, Retained: map[string]string{}, Before: before, HasBeforeReceipt: hasReceipt, BeforeReceipt: receiptData, Phase: "staged", NoPreviousPolicy: "finish_verified_publication"}
	for name, bundle := range bundles {
		t.Retained[name] = bundle.SHA256
	}
	data, err := json.Marshal(t)
	if err != nil {
		return nil, err
	}
	total, err := diskBytes(s.dataDir)
	if err != nil {
		return nil, err
	}
	if total+int64(4*len(data)+4*len(b.Code)+65536) > 1<<30 {
		return nil, errDeploymentQuota
	}
	root := t.root(s.dataDir)
	stage := filepath.Join(root, "bundle")
	if err = s.deployFiles.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err = s.deployFiles.MkdirAll(stage, 0700); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	files := []struct {
		name string
		data []byte
	}{{"app.mjs", []byte(b.Code)}, {"entry.mjs", []byte(entryModule)}, {"runtime.capnp", []byte(runtimeConfig)}, {"bundle.json", encoded}, {".deploy-owner", []byte(t.TxID + "\n" + t.Digest)}}
	for _, file := range files {
		if err = s.writeDeploymentFile(filepath.Join(stage, file.name), file.data); err != nil {
			s.deployFiles.RemoveAll(root)
			return nil, err
		}
	}
	for _, path := range []string{stage, root, filepath.Dir(dir)} {
		if err = s.syncDeploymentDir(path); err != nil {
			s.deployFiles.RemoveAll(root)
			return nil, err
		}
	}
	if err = s.checkpointDeployment(t); err != nil {
		return t, err
	}
	return t, nil
}

func (s *Service) deployTransactional(w http.ResponseWriter, r *http.Request, dir string, b Bundle, runner transactionalManagedRunner) {
	site := filepath.Base(filepath.Dir(dir))
	if s.pendingDeployment(site) {
		t, err := s.loadDeploymentTransaction(site)
		if err != nil {
			s.deploymentHTTPError(w, err)
			return
		}
		if t == nil {
			// Receipt-only fences (including unbound legacy receipts) are not
			// immutable-release conflicts and must never start a new transaction.
			s.deploymentHTTPError(w, errDeploymentPending)
			return
		}
		if t.Release != filepath.Base(dir) || t.Digest != b.SHA256 {
			s.deploymentHTTPError(w, errDeploymentConflict)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), PrepareTimeout)
		err = s.reconcileDeployment(ctx, runner, t)
		cancel()
		if err != nil {
			s.deploymentHTTPError(w, err)
			return
		}
	}
	previous, err := load(dir)
	if err == nil {
		if previous.SHA256 != b.SHA256 {
			s.deploymentHTTPError(w, errDeploymentConflict)
			return
		}
		if err = s.verifyDeploymentReceipt(r.Context(), dir, b.SHA256); err != nil {
			s.deploymentHTTPError(w, errDeploymentPending)
			return
		}
		writeJSON(w, 200, map[string]string{"sha256": b.SHA256, "status": "ready"})
		return
	}
	if !errors.Is(err, os.ErrNotExist) {
		s.deploymentHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), PrepareTimeout)
	defer cancel()
	t, err := s.beginDeployment(ctx, runner, dir, b)
	if err != nil {
		if t != nil {
			err = s.failDeployment(r.Context(), runner, t, err, false)
		}
		s.deploymentHTTPError(w, err)
		return
	}
	bundles, _ := t.bundles()
	prepared, err := runner.Stage(ctx, site, bundles)
	if err == nil && (!versionPattern.MatchString(prepared.VersionID) || prepared.PackageID != t.PackageID) {
		err = errors.New("staged package mismatch")
	}
	if err != nil {
		s.deploymentHTTPError(w, s.failDeployment(r.Context(), runner, t, err, false))
		return
	}
	t.VersionID = prepared.VersionID
	t.Phase = "versioned"
	if err = s.checkpointDeployment(t); err == nil {
		err = ctx.Err()
	}
	if err != nil {
		s.deploymentHTTPError(w, s.failDeployment(r.Context(), runner, t, err, false))
		return
	}
	t.Phase = "activating"
	if err = s.checkpointDeployment(t); err != nil {
		s.deploymentHTTPError(w, s.failDeployment(r.Context(), runner, t, err, false))
		return
	}
	result, activationErr := runner.ActivateCAS(ctx, site, t.Before, t.VersionID)
	if !validActivation(result, t.VersionID) || (result.Ownership == ActivationOwned && result.Deployment.ID == t.Before.ID) {
		t.Activation = ActivationResult{Ownership: ActivationUnknown}
		t.Phase = "activation_unknown"
		_ = s.checkpointDeployment(t)
		s.deploymentHTTPError(w, errDeploymentPending)
		return
	}
	t.Activation = result
	t.Phase = "activated"
	err = s.checkpointDeployment(t)
	if err == nil {
		err = activationErr
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = runner.VerifyPrepared(ctx, site, result.Deployment, t.PackageID)
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		s.deploymentHTTPError(w, s.failDeployment(r.Context(), runner, t, err, true))
		return
	}
	t.Phase = "verified"
	if err = s.checkpointDeployment(t); err != nil {
		s.deploymentHTTPError(w, s.failDeployment(r.Context(), runner, t, err, true))
		return
	}
	if err = s.publishDeployment(ctx, runner, t); err != nil {
		if !errors.Is(err, errDeploymentCommitUnknown) && t.Phase != "committed" {
			err = s.failDeployment(r.Context(), runner, t, err, true)
		}
		s.deploymentHTTPError(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"sha256": b.SHA256, "status": "ready"})
}
func (s *Service) deploymentHTTPError(w http.ResponseWriter, err error) {
	code := 500
	switch {
	case errors.Is(err, errDeploymentConflict):
		code = 409
	case errors.Is(err, errDeploymentQuota):
		code = 507
	case errors.Is(err, errDeploymentPending) || errors.Is(err, errDeploymentCommitUnknown):
		code = 503
	}
	http.Error(w, "deployment transaction unavailable", code)
}
func (s *Service) failDeployment(parent context.Context, runner transactionalManagedRunner, t *deploymentTransaction, cause error, attempted bool) error {
	if attempted && (!ownedActivation(t.Activation) || !t.Before.Exists) {
		return errors.Join(cause, errDeploymentPending)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), RollbackTimeout)
	defer cancel()
	if err := s.abortDeployment(ctx, runner, t, attempted); err != nil {
		return errors.Join(cause, errDeploymentPending, err)
	}
	return cause
}
func (s *Service) publishDeployment(ctx context.Context, runner transactionalManagedRunner, t *deploymentTransaction) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validActivation(t.Activation, t.VersionID) {
		return errDeploymentPending
	}
	committed := t.Phase == "committed"
	if !committed {
		t.Phase = "publishing"
		if err := s.checkpointDeployment(t); err != nil {
			return err
		}
	}
	siteDir := filepath.Join(s.dataDir, t.Site)
	root := t.root(s.dataDir)
	final := filepath.Join(siteDir, t.Release)
	stage := filepath.Join(root, "bundle")
	if _, err := os.Lstat(final); errors.Is(err, os.ErrNotExist) {
		if err = s.checkCandidate(stage, t); err != nil {
			return err
		}
		if err = s.deployFiles.Rename(stage, final); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if err := s.checkCandidate(final, t); err != nil {
		return err
	}
	// Retry both syncs even if a previous rename succeeded but its sync failed.
	if err := s.syncDeploymentDir(root); err != nil {
		return err
	}
	if err := s.syncDeploymentDir(siteDir); err != nil {
		return err
	}
	digests := map[string]bool{}
	for _, d := range t.Retained {
		digests[d] = true
	}
	receipt := deploymentReceipt{minisandboxReceipt: minisandboxReceipt{Version: t.VersionID, PackageID: t.PackageID}, Schema: 2, TxID: t.TxID, Identity: t.Identity, DeploymentID: t.Activation.Deployment.ID, Ownership: t.Activation.Ownership}
	for d := range digests {
		receipt.Digests = append(receipt.Digests, d)
	}
	sort.Strings(receipt.Digests)
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if _, err = parseDeploymentReceipt(data); err != nil {
		return err
	}
	if err = s.atomicDeploymentFile(siteDir, ".minisandbox.json", ".receipt-txn-*", data); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = runner.VerifyPrepared(ctx, t.Site, t.Activation.Deployment, t.PackageID); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	t.Phase = "committed"
	t.Decision = "commit"
	if err = s.checkpointDeployment(t); err != nil {
		return errors.Join(errDeploymentCommitUnknown, err)
	}
	// Once the durable commit exists, cancellation/response failure cannot abort it.
	if err = s.finishDeployment(t); err != nil {
		return errors.Join(errDeploymentPending, err)
	}
	return nil
}
func (s *Service) checkCandidate(dir string, t *deploymentTransaction) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errDeploymentConflict
	}
	owner, err := readDeploymentFile(filepath.Join(dir, ".deploy-owner"), 128)
	if err != nil || string(owner) != t.TxID+"\n"+t.Digest {
		return errDeploymentConflict
	}
	b, err := load(dir)
	if err != nil || b.SHA256 != t.Digest || b.Code != t.Package.Modules["backend-"+t.Digest+".js"] {
		return errDeploymentConflict
	}
	return nil
}
func (s *Service) abortDeployment(ctx context.Context, runner transactionalManagedRunner, t *deploymentTransaction, restore bool) error {
	if t.Phase == "committed" || t.Decision == "commit" {
		return errDeploymentCommitUnknown
	}
	t.Decision = "abort"
	t.Phase = "aborting"
	checkpointErr := s.checkpointDeployment(t)
	if restore && t.Restored.Deployment.ID == "" {
		if !ownedActivation(t.Activation) || !t.Before.Exists {
			return errDeploymentPending
		}
		result, err := runner.RestoreCAS(ctx, t.Site, t.Activation.Deployment.ID, t.Before)
		if err != nil || !ownedActivation(result) || !sameMinisandboxTargets(result.Deployment.Targets, t.Before.Targets) {
			if validDeploymentState(result.Deployment) && result.Deployment.Exists {
				t.Restored = result
			}
			t.Phase = "rollback_unknown"
			if err != nil {
				state, snapshotErr := runner.Snapshot(ctx, t.Site)
				if snapshotErr == nil && state.ID != t.Activation.Deployment.ID && !sameMinisandboxTargets(state.Targets, t.Before.Targets) {
					t.Phase = "conflict"
				}
			}
			_ = s.checkpointDeployment(t)
			return errors.Join(errDeploymentPending, err)
		}
		t.Restored = result
		if err = s.checkpointDeployment(t); err != nil {
			return err
		}
	}
	state := t.Before
	if restore {
		if !ownedActivation(t.Restored) || !sameMinisandboxTargets(t.Restored.Deployment.Targets, t.Before.Targets) {
			return errDeploymentPending
		}
		state = t.Restored.Deployment
	}
	if t.Before.Exists {
		receipt, err := parseDeploymentReceipt(t.BeforeReceipt)
		if err != nil {
			return err
		}
		if err = runner.VerifyPrepared(ctx, t.Site, state, receipt.PackageID); err != nil {
			return err
		}
		// Before activation there was no pointer change: preserve even a legacy
		// receipt byte-for-byte, and do not invent ownership of its deployment.
		data := t.BeforeReceipt
		if restore {
			receipt.Schema = 2
			receipt.TxID = t.TxID
			receipt.Identity = t.Identity
			receipt.DeploymentID = state.ID
			receipt.Ownership = t.Restored.Ownership
			data, err = json.Marshal(receipt)
			if err != nil {
				return err
			}
		}
		if err = s.atomicDeploymentFile(filepath.Join(s.dataDir, t.Site), ".minisandbox.json", ".receipt-txn-*", data); err != nil {
			return err
		}
	} else {
		if restore {
			return errDeploymentPending
		}
		state, err := runner.Snapshot(ctx, t.Site)
		if err != nil || state.Exists {
			return errDeploymentPending
		}
	}
	if err := s.discardDeploymentCandidate(t); err != nil {
		return err
	}
	t.Phase = "aborted"
	if err := s.checkpointDeployment(t); err != nil {
		return err
	}
	if err := s.finishDeployment(t); err != nil {
		return err
	}
	return checkpointErr
}
func (s *Service) discardDeploymentCandidate(t *deploymentTransaction) error {
	siteDir := filepath.Join(s.dataDir, t.Site)
	final := filepath.Join(siteDir, t.Release)
	root := t.root(s.dataDir)
	if _, err := os.Lstat(final); err == nil {
		if err = s.checkCandidate(final, t); err != nil {
			return err
		}
		if err = s.deployFiles.Rename(final, filepath.Join(root, "discarded")); err != nil {
			return err
		}
		if err = s.syncDeploymentDir(root); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return s.syncDeploymentDir(siteDir)
}
func (s *Service) finishDeployment(t *deploymentTransaction) error {
	if t.Phase != "committed" && t.Phase != "aborted" {
		return errDeploymentPending
	}
	siteDir := filepath.Join(s.dataDir, t.Site)
	if err := s.deployFiles.RemoveAll(t.root(s.dataDir)); err != nil {
		return err
	}
	if err := s.syncDeploymentDir(siteDir); err != nil {
		return err
	}
	if err := s.deployFiles.Remove(filepath.Join(siteDir, deploymentJournalName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.syncDeploymentDir(siteDir); err != nil {
		return err
	}
	s.pendingDeployments.Delete(t.Site)
	return nil
}
func (s *Service) reconcileDeployment(ctx context.Context, runner transactionalManagedRunner, t *deploymentTransaction) error {
	if err := t.validate(t.Site); err != nil {
		return err
	}
	// Journal recovery cannot silently migrate a currently unbound receipt
	// either. Keep it and all artifacts intact until original-endpoint evidence
	// is supplied through an explicit migration, outside this transaction path.
	receiptData, receiptErr := readDeploymentFile(filepath.Join(s.dataDir, t.Site, ".minisandbox.json"), 8192)
	if receiptErr == nil {
		receipt, parseErr := parseDeploymentReceipt(receiptData)
		if parseErr != nil || receipt.Schema < 2 || receipt.Identity != t.Identity {
			return errDeploymentPending
		}
	} else if !errors.Is(receiptErr, os.ErrNotExist) {
		return errDeploymentPending
	}
	identity, err := runner.DeploymentIdentity(t.Site)
	if err != nil || identity != t.Identity {
		return errDeploymentPending
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	switch t.Phase {
	case "staged", "versioned":
		return s.abortDeployment(ctx, runner, t, false)
	case "aborted":
		return s.finishDeployment(t)
	case "conflict", "rollback_unknown":
		return errDeploymentPending
	case "activating", "activation_unknown":
		// A single, read-only coalescing attempt. Never replay activation and never
		// infer ownership from matching targets. The unchanged predecessor is unknown.
		state, err := runner.Snapshot(ctx, t.Site)
		if err != nil || state.ID == t.Before.ID {
			return errDeploymentPending
		}
		if !candidateDeployment(state, t.VersionID) {
			// Observing a changed pointer with another target is a sticky conflict,
			// not permission to keep polling until a convenient deployment appears.
			t.Phase = "conflict"
			_ = s.checkpointDeployment(t)
			return errDeploymentPending
		}
		if err = runner.VerifyPrepared(ctx, t.Site, state, t.PackageID); err != nil {
			return errDeploymentPending
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		t.Activation = ActivationResult{Deployment: state, Ownership: ActivationBorrowed, HTTPStatus: 200}
		t.Phase = "verified"
		if err = s.checkpointDeployment(t); err != nil {
			return err
		}
		return s.publishDeployment(ctx, runner, t)
	case "aborting":
		return s.abortDeployment(ctx, runner, t, ownedActivation(t.Activation) && t.Before.Exists)
	case "committed":
		if err = runner.VerifyPrepared(ctx, t.Site, t.Activation.Deployment, t.PackageID); err != nil {
			return errDeploymentPending
		}
		// Cleanup may have already removed the staging root before a crash. All
		// publication artifacts are rechecked; rebuild only the empty sync directory.
		if err = s.deployFiles.MkdirAll(t.root(s.dataDir), 0700); err != nil {
			return err
		}
		return s.publishDeployment(ctx, runner, t)
	case "activated", "verified", "publishing":
		if ownedActivation(t.Activation) && t.Before.Exists {
			return s.abortDeployment(ctx, runner, t, true)
		}
		if err = runner.VerifyPrepared(ctx, t.Site, t.Activation.Deployment, t.PackageID); err != nil {
			return errDeploymentPending
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		t.Phase = "verified"
		if err = s.checkpointDeployment(t); err != nil {
			return err
		}
		return s.publishDeployment(ctx, runner, t)
	}
	return errDeploymentPending
}

// Reconcile is bounded by its caller's context and touches only local journals
// and their bound native identity. Errors leave that site fenced, not ready.
func (s *Service) Reconcile(ctx context.Context) error {
	runner, ok := s.runner.(transactionalManagedRunner)
	if !ok {
		return nil
	}
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		return err
	}
	sites := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() && identifier.MatchString(entry.Name()) {
			if _, err := os.Lstat(filepath.Join(s.dataDir, entry.Name(), deploymentJournalName)); !errors.Is(err, os.ErrNotExist) {
				sites[entry.Name()] = true
			}
		}
	}
	s.pendingDeployments.Range(func(key, value any) bool { sites[key.(string)] = true; return true })
	names := make([]string, 0, len(sites))
	for site := range sites {
		names = append(names, site)
	}
	sort.Strings(names)
	var failures []error
	for _, site := range names {
		if ctx.Err() != nil {
			failures = append(failures, ctx.Err())
			break
		}
		if !s.admit(site) {
			failures = append(failures, errDeploymentPending)
			continue
		}
		lock := s.admittedSiteLock(site)
		lock.Lock()
		t, loadErr := s.loadDeploymentTransaction(site)
		if loadErr == nil && t != nil {
			loadErr = s.reconcileDeployment(ctx, runner, t)
		}
		lock.Unlock()
		s.release(site)
		if loadErr != nil {
			failures = append(failures, fmt.Errorf("site %s: %w", site, loadErr))
		}
	}
	return errors.Join(failures...)
}
