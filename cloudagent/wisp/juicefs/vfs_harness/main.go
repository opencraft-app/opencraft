//go:build linux

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/rand"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/juicedata/juicefs/pkg/object"
	"github.com/juicedata/juicefs/pkg/utils"
	"golang.org/x/sys/unix"
)

type harnessConfig struct {
	JuiceFSBin          string
	WorkRoot            string
	Workspace           string
	Profile             string
	Scenarios           map[string]bool
	KeepSuccess         bool
	SoakDuration        time.Duration
	SoakRoundDuration   time.Duration
	SoakBarrierGrace    time.Duration
	PeriodicSettleDelay time.Duration
	MountReadyTimeout   time.Duration
	RuntimeMaintenance  string
	SnapshotInterval    string
	FuzzSeed            int64
	FuzzOps             int
	FuzzCheckpointEvery int
	RemoteBackend       string
	COSBucket           string
	COSRegion           string
	COSEndpoint         string
	SecretID            string
	SecretKey           string
	SMHAccessDomain     string
	SMHLibraryID        string
	SMHSpaceID          string
	SMHAccessToken      string
	SMHPermanentDelete  string
}

type runManifest struct {
	RunID              string            `json:"run_id"`
	Scenario           string            `json:"scenario"`
	StartedAt          time.Time         `json:"started_at"`
	FinishedAt         time.Time         `json:"finished_at"`
	Volume             string            `json:"volume"`
	MountPoint         string            `json:"mount_point"`
	MountReadyAt       time.Time         `json:"mount_ready_at,omitempty"`
	MountReadyDuration time.Duration     `json:"mount_ready_duration,omitempty"`
	OpenTiming         map[string]string `json:"open_timing,omitempty"`
	RemoteLevels       map[string]int    `json:"remote_levels,omitempty"`
	ScenarioData       map[string]string `json:"scenario_data,omitempty"`
	CheckpointDigests  []string          `json:"checkpoint_digests,omitempty"`
	FinalDigest        string            `json:"final_digest,omitempty"`
	LastCheckpoint     string            `json:"last_successful_checkpoint_digest,omitempty"`
	FailureStep        int               `json:"failure_step,omitempty"`
	MetaURL            string            `json:"-"`
	ReplicaPath        string            `json:"-"`
	COSPrefixes        []string          `json:"-"`
	LocalPaths         map[string]string `json:"local_paths"`
	Commands           []commandResult   `json:"commands"`
	Checks             []string          `json:"checks"`
	Failed             bool              `json:"failed"`
	Failure            string            `json:"failure,omitempty"`
	RetainedPath       string            `json:"retained_path,omitempty"`
}

type commandResult struct {
	Name      string        `json:"name"`
	Args      []string      `json:"args"`
	StartedAt time.Time     `json:"started_at"`
	Finished  time.Time     `json:"finished_at"`
	Duration  time.Duration `json:"duration"`
	ExitCode  int           `json:"exit_code"`
	LogPath   string        `json:"log_path"`
}

type scenarioRun struct {
	cfg                  harnessConfig
	name                 string
	runID                string
	runDir               string
	logDir               string
	metaDir              string
	mountDir             string
	metaDBPath           string
	metaURL              string
	volume               string
	replicaPath          string
	litestreamNS         string
	manifest             runManifest
	mountCmd             *exec.Cmd
	mountLogFile         *os.File
	mountLogPath         string
	mountWaitDone        chan error
	mountCount           int
	syncIntervalOverride string
}

const harnessWorkspacePrefix = "workspace"
const harnessDefaultSnapshotInterval = "1m"
const fuzzReplaySchemaVersion = "fuzz-churn-v2"
const periodicCommitChaosSchemaVersion = "periodic-commit-chaos-v1"
const fuzzPageSize = 4096

type fuzzFileObject struct {
	Content []byte
	Xattrs  map[string][]byte
}

type fuzzModel struct {
	dirs         map[string]struct{}
	filePaths    map[string]string
	fileObjects  map[string]fuzzFileObject
	symlinks     map[string]string
	nextObjectID int
}

type periodicSnapshot struct {
	step  int
	model *fuzzModel
}

type periodicTraceEvent struct {
	Step           int      `json:"step"`
	Event          string   `json:"event"`
	LiveDigest     string   `json:"live_digest,omitempty"`
	DurableDigest  string   `json:"durable_digest,omitempty"`
	ActualDigest   string   `json:"actual_digest,omitempty"`
	MatchedStep    int      `json:"matched_step,omitempty"`
	HistoryDigests []string `json:"history_digests,omitempty"`
}

func (r *scenarioRun) formatSentinelPath() string {
	return filepath.Join(r.runDir, ".formatted")
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		fail(err)
	}
	if err := os.MkdirAll(cfg.WorkRoot, 0o755); err != nil {
		fail(err)
	}

	scenarios := orderedScenarios(cfg)
	if len(scenarios) == 0 {
		fail(fmt.Errorf("no scenarios selected"))
	}

	for _, name := range scenarios {
		run, err := newScenarioRun(cfg, name)
		if err != nil {
			fail(err)
		}
		err = run.execute()
		if err != nil {
			_ = run.finalize(false, err)
			fail(err)
		}
		if err := run.finalize(true, nil); err != nil {
			fail(err)
		}
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "vfs_harness: %v\n", err)
	os.Exit(1)
}

func loadConfig() (harnessConfig, error) {
	var cfg harnessConfig
	var scenarioCSV string
	flag.StringVar(&cfg.JuiceFSBin, "juicefs-bin", os.Getenv("JUICEFS_BIN"), "path to prebuilt juicefs binary")
	flag.StringVar(&cfg.WorkRoot, "workdir", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_WORKDIR"), filepath.Join(".", "vfs_harness", "runs")), "work directory root")
	flag.StringVar(&cfg.Workspace, "workspace", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_WORKSPACE"), ""), "optional fixed workspace name to reuse the same remote/local paths across runs")
	flag.StringVar(&cfg.Profile, "profile", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_PROFILE"), "quick"), "quick or soak")
	flag.DurationVar(&cfg.SoakDuration, "soak-duration", durationEnv("JUICEFS_HARNESS_SOAK_DURATION", 30*time.Minute), "duration for soak profile")
	flag.DurationVar(&cfg.SoakRoundDuration, "soak-round-duration", durationEnv("JUICEFS_HARNESS_SOAK_ROUND_DURATION", 15*time.Minute), "maximum duration of a single soak mount before barrier/remount")
	flag.DurationVar(&cfg.SoakBarrierGrace, "soak-barrier-grace", durationEnv("JUICEFS_HARNESS_SOAK_BARRIER_GRACE", 10*time.Second), "sleep after barrier before unmount during soak")
	flag.DurationVar(&cfg.PeriodicSettleDelay, "periodic-settle-delay", durationEnv("JUICEFS_HARNESS_PERIODIC_SETTLE_DELAY", 2*time.Second), "sleep before killing the mount during periodic_commit_chaos settle probes")
	flag.DurationVar(&cfg.MountReadyTimeout, "mount-ready-timeout", durationEnv("JUICEFS_HARNESS_MOUNT_READY_TIMEOUT", 30*time.Second), "maximum time to wait for a mount to become ready")
	flag.BoolVar(&cfg.KeepSuccess, "keep-success", boolEnv("JUICEFS_HARNESS_KEEP_SUCCESS", false), "retain successful runs locally and remotely")
	flag.StringVar(&cfg.RuntimeMaintenance, "runtime-maintenance", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_RUNTIME_MAINTENANCE"), "full"), "Litestream runtime maintenance mode: full, off, snapshot_only, or compaction_only")
	flag.StringVar(&cfg.SnapshotInterval, "snapshot-interval", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_SNAPSHOT_INTERVAL"), harnessDefaultSnapshotInterval), "Litestream snapshot interval encoded into the generated META-URL")
	flag.Int64Var(&cfg.FuzzSeed, "fuzz-seed", int64Env("JUICEFS_HARNESS_FUZZ_SEED", 0), "seed for deterministic fuzz-like scenarios; 0 picks a time-based seed")
	flag.IntVar(&cfg.FuzzOps, "fuzz-ops", intEnv("JUICEFS_HARNESS_FUZZ_OPS", 40), "number of random operations in fuzz-like scenarios")
	flag.IntVar(&cfg.FuzzCheckpointEvery, "fuzz-checkpoint-every", intEnv("JUICEFS_HARNESS_FUZZ_CHECKPOINT_EVERY", 8), "run a durable barrier+remount verification every N fuzz ops")
	flag.StringVar(&scenarioCSV, "scenario", firstNonEmpty(os.Getenv("JUICEFS_HARNESS_SCENARIOS"), ""), "comma-separated scenario list")
	flag.Parse()

	cfg.RemoteBackend = resolveHarnessBackend(os.Getenv("REMOTE_BACKEND"))
	cfg.COSBucket = os.Getenv("COS_BUCKET")
	cfg.COSRegion = os.Getenv("COS_REGION")
	cfg.COSEndpoint = os.Getenv("COS_ENDPOINT")
	cfg.SecretID = firstNonEmpty(os.Getenv("TENCENTCLOUD_SECRET_ID"), os.Getenv("COS_SECRETID"))
	cfg.SecretKey = firstNonEmpty(os.Getenv("TENCENTCLOUD_SECRET_KEY"), os.Getenv("COS_SECRETKEY"))
	cfg.SMHAccessDomain = os.Getenv("SMH_ACCESS_DOMAIN")
	cfg.SMHLibraryID = os.Getenv("SMH_LIBRARY_ID")
	cfg.SMHSpaceID = os.Getenv("SMH_SPACE_ID")
	cfg.SMHAccessToken = os.Getenv("SMH_ACCESS_TOKEN")
	cfg.SMHPermanentDelete = os.Getenv("SMH_PERMANENT_DELETE")
	cfg.Scenarios = parseScenarioCSV(scenarioCSV)

	if cfg.JuiceFSBin == "" {
		return cfg, fmt.Errorf("JUICEFS_BIN or -juicefs-bin is required")
	}
	absWorkRoot, err := filepath.Abs(cfg.WorkRoot)
	if err != nil {
		return cfg, fmt.Errorf("resolve workdir: %w", err)
	}
	cfg.WorkRoot = absWorkRoot
	if st, err := os.Stat(cfg.JuiceFSBin); err != nil || st.Mode()&0o111 == 0 {
		return cfg, fmt.Errorf("juicefs binary %q is not executable", cfg.JuiceFSBin)
	}
	switch cfg.RemoteBackend {
	case "cos":
		if cfg.COSBucket == "" || cfg.COSRegion == "" || cfg.COSEndpoint == "" || cfg.SecretID == "" || cfg.SecretKey == "" {
			return cfg, fmt.Errorf("COS_BUCKET, COS_REGION, COS_ENDPOINT, TENCENTCLOUD_SECRET_ID, and TENCENTCLOUD_SECRET_KEY are required")
		}
	case "smh":
		if cfg.SMHAccessDomain == "" || cfg.SMHLibraryID == "" || cfg.SMHSpaceID == "" || cfg.SMHAccessToken == "" {
			return cfg, fmt.Errorf("SMH_ACCESS_DOMAIN, SMH_LIBRARY_ID, SMH_SPACE_ID, and SMH_ACCESS_TOKEN are required")
		}
	default:
		return cfg, fmt.Errorf("unsupported REMOTE_BACKEND %q", cfg.RemoteBackend)
	}
	return cfg, nil
}

func resolveHarnessBackend(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "cos":
		return "cos"
	case "smh":
		return "smh"
	default:
		return strings.ToLower(strings.TrimSpace(v))
	}
}

func buildHarnessMetaURL(cfg harnessConfig, metaDBPath, replicaPath, syncInterval string) (string, error) {
	q := url.Values{}
	q.Set("litestream_write", "true")
	q.Set("litestream_sync_interval", syncInterval)
	q.Set("litestream_barrier_timeout", "60s")
	q.Set("litestream_runtime_maintenance", cfg.RuntimeMaintenance)
	if cfg.SnapshotInterval != "" {
		q.Set("litestream_snapshot_interval", cfg.SnapshotInterval)
	}
	switch cfg.RemoteBackend {
	case "smh":
		replicaURL, err := buildHarnessSMHReplicaURL(cfg, replicaPath)
		if err != nil {
			return "", err
		}
		q.Set("litestream_replica_url", replicaURL)
	default:
		q.Set("litestream_path", replicaPath)
	}
	return "sqlite3://" + metaDBPath + "?" + q.Encode(), nil
}

func buildHarnessSMHReplicaURL(cfg harnessConfig, replicaPath string) (string, error) {
	endpoint, err := normalizedURLWithScheme(cfg.SMHAccessDomain)
	if err != nil {
		return "", fmt.Errorf("parse SMH_ACCESS_DOMAIN: %w", err)
	}
	u := &url.URL{
		Scheme: "smh",
		Host:   endpoint.Host,
		Path:   "/" + strings.Trim(replicaPath, "/"),
	}
	q := u.Query()
	q.Set("endpoint", endpoint.String())
	q.Set("library_id", cfg.SMHLibraryID)
	q.Set("space_id", cfg.SMHSpaceID)
	if cfg.SMHPermanentDelete != "" {
		q.Set("permanent", cfg.SMHPermanentDelete)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func normalizedURLWithScheme(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Host == "" {
		return nil, fmt.Errorf("host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

func parseScenarioCSV(v string) map[string]bool {
	out := make(map[string]bool)
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out[part] = true
		}
	}
	return out
}

func orderedScenarios(cfg harnessConfig) []string {
	all := []string{"mount_smoke", "barrier_cut", "crash_before_barrier", "crash_after_barrier", "snapshot_restore", "tree_restore", "session_churn", "fuzz_churn", "chaos_crash_fuzz", "periodic_commit_chaos", "metadata_restore_matrix", "rename_semantics_matrix", "xattr_restore_matrix", "cross_mode_restore", "local_meta_write_failure_recover"}
	defaultSet := []string{"mount_smoke", "barrier_cut", "crash_before_barrier", "crash_after_barrier", "snapshot_restore", "tree_restore", "session_churn", "metadata_restore_matrix", "rename_semantics_matrix", "xattr_restore_matrix", "cross_mode_restore", "chaos_crash_fuzz", "periodic_commit_chaos"}
	if cfg.Profile == "soak" {
		all = append(all, "soak")
		defaultSet = append(defaultSet, "soak")
	}
	if len(cfg.Scenarios) == 0 {
		return defaultSet
	}
	var selected []string
	for _, name := range all {
		if cfg.Scenarios[name] {
			selected = append(selected, name)
		}
	}
	return selected
}

func newScenarioRun(cfg harnessConfig, name string) (*scenarioRun, error) {
	runID := fmt.Sprintf("%s-%d-%04d", name, time.Now().Unix(), rand.Intn(10000))
	if cfg.Workspace != "" {
		runID = fmt.Sprintf("%s-%s", name, cfg.Workspace)
	}
	workspace := safeHarnessWorkspaceName(runID)
	if cfg.Workspace != "" {
		workspace = cfg.Workspace
	}
	runDir := filepath.Join(cfg.WorkRoot, runID)
	logDir := filepath.Join(runDir, "logs")
	metaDir := filepath.Join(runDir, workspace)
	mountDir := filepath.Join(runDir, "mnt")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(metaDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		return nil, err
	}
	metaDBPath := filepath.Join(metaDir, "meta.db")
	volume := workspace
	litestreamNS := filepath.ToSlash(filepath.Join(harnessWorkspacePrefix, workspace))
	replicaPath := filepath.ToSlash(filepath.Join(litestreamNS, "meta.db"))
	syncInterval := "3s"
	if name == "crash_before_barrier" {
		syncInterval = "30s"
	}
	metaURL, err := buildHarnessMetaURL(cfg, metaDBPath, replicaPath, syncInterval)
	if err != nil {
		return nil, err
	}
	manifest := runManifest{
		RunID:       runID,
		Scenario:    name,
		StartedAt:   time.Now(),
		MetaURL:     metaURL,
		Volume:      volume,
		MountPoint:  mountDir,
		ReplicaPath: replicaPath,
		COSPrefixes: []string{
			litestreamNS + "/",
			filepath.ToSlash(filepath.Join(harnessWorkspacePrefix, workspace)) + "/",
		},
		LocalPaths: map[string]string{
			"run_dir":   runDir,
			"log_dir":   logDir,
			"meta_dir":  metaDir,
			"mount_dir": mountDir,
			"meta_db":   metaDBPath,
		},
	}
	return &scenarioRun{
		cfg:          cfg,
		name:         name,
		runID:        runID,
		runDir:       runDir,
		logDir:       logDir,
		metaDir:      metaDir,
		mountDir:     mountDir,
		metaDBPath:   metaDBPath,
		metaURL:      metaURL,
		volume:       volume,
		replicaPath:  replicaPath,
		litestreamNS: litestreamNS,
		manifest:     manifest,
	}, nil
}

func safeHarnessWorkspaceName(runID string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(runID) {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		name = "run"
	}
	if len(name) <= 63 {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	suffix := fmt.Sprintf("%x", sum[:4])
	name = strings.TrimRight(name[:63-len(suffix)-1], "-") + "-" + suffix
	if len(name) < 3 {
		return "run-" + suffix
	}
	return name
}

func (r *scenarioRun) execute() error {
	switch r.name {
	case "mount_smoke":
		return r.scenarioMountSmoke()
	case "barrier_cut":
		return r.scenarioBarrierCut()
	case "crash_before_barrier":
		return r.scenarioCrashBeforeBarrier()
	case "crash_after_barrier":
		return r.scenarioCrashAfterBarrier()
	case "snapshot_restore":
		return r.scenarioSnapshotRestore()
	case "tree_restore":
		return r.scenarioTreeRestore()
	case "session_churn":
		return r.scenarioSessionChurn()
	case "fuzz_churn":
		return r.scenarioFuzzChurn()
	case "chaos_crash_fuzz":
		return r.scenarioChaosCrashFuzz()
	case "periodic_commit_chaos":
		return r.scenarioPeriodicCommitChaos()
	case "metadata_restore_matrix":
		return r.scenarioMetadataRestoreMatrix()
	case "rename_semantics_matrix":
		return r.scenarioRenameSemanticsMatrix()
	case "xattr_restore_matrix":
		return r.scenarioXattrRestoreMatrix()
	case "cross_mode_restore":
		return r.scenarioCrossModeRestore()
	case "local_meta_write_failure_recover":
		return r.scenarioLocalMetaWriteFailureRecover()
	case "soak":
		return r.scenarioSoak()
	default:
		return fmt.Errorf("unknown scenario %q", r.name)
	}
}

func (r *scenarioRun) finalize(success bool, runErr error) error {
	_ = r.ensureUnmount()
	r.manifest.FinishedAt = time.Now()
	r.manifest.Failed = !success
	if runErr != nil {
		r.manifest.Failure = runErr.Error()
	}
	r.captureRemoteLevels()
	r.captureOpenTiming()
	manifestPath := filepath.Join(r.runDir, "manifest.json")
	data, err := json.MarshalIndent(r.manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return err
	}
	if success && !r.cfg.KeepSuccess {
		if err := r.cleanupRemote(); err != nil {
			return err
		}
		return os.RemoveAll(r.runDir)
	}
	r.manifest.RetainedPath = r.runDir
	return nil
}

func (r *scenarioRun) captureOpenTiming() {
	if r.mountLogPath == "" {
		return
	}
	data, err := os.ReadFile(r.mountLogPath)
	if err != nil {
		return
	}
	var fields map[string]string
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, "vfs open timings") {
			continue
		}
		fields = map[string]string{}
		for _, key := range []string{"restorePlan", "pageSize", "buildIndex", "hydrationInit", "total", "restoreInfos", "snapshots", "l0", "l1", "higherLevels", "fastPath"} {
			if v := extractKV(line, key); v != "" {
				fields[key] = v
			}
		}
	}
	if len(fields) > 0 {
		r.manifest.OpenTiming = fields
	}
	if r.manifest.RemoteLevels != nil && r.manifest.OpenTiming != nil {
		if r.manifest.RemoteLevels["level_9"] > 0 && r.manifest.OpenTiming["snapshots"] == "0" {
			r.manifest.Checks = append(r.manifest.Checks, "snapshots-exist-but-not-selected")
		}
		if r.manifest.RemoteLevels["level_9"] > 0 && r.manifest.OpenTiming["snapshots"] != "0" {
			r.manifest.Checks = append(r.manifest.Checks, "snapshot-selected")
		}
	}
}

func extractKV(line, key string) string {
	needle := key + "="
	idx := strings.Index(line, needle)
	if idx < 0 {
		return ""
	}
	rest := line[idx+len(needle):]
	end := strings.IndexByte(rest, ' ')
	if end < 0 {
		return rest
	}
	return rest[:end]
}

func (r *scenarioRun) captureRemoteLevels() {
	levels := map[string]int{}
	for _, prefix := range r.manifest.COSPrefixes {
		_ = prefix
	}
	store, err := r.remoteStorage()
	if err != nil {
		return
	}
	defer object.Shutdown(store)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	base := filepath.ToSlash(filepath.Join(harnessWorkspacePrefix, r.workspaceName(), "meta.db"))
	for _, level := range []int{0, 1, 2, 3, 9} {
		prefix := fmt.Sprintf("%s/%04d/", base, level)
		ch, err := object.ListAll(ctx, store, prefix, "", true, true)
		if err != nil {
			continue
		}
		n := 0
		for range ch {
			n++
		}
		levels[fmt.Sprintf("level_%d", level)] = n
	}
	if len(levels) > 0 {
		r.manifest.RemoteLevels = levels
	}
}

func (r *scenarioRun) scenarioMountSmoke() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	payload := []byte("mount-smoke-payload")
	if err := os.MkdirAll(filepath.Join(r.mountDir, "dir"), 0o755); err != nil {
		return err
	}
	filePath := filepath.Join(r.mountDir, "dir", "hello.txt")
	if err := os.WriteFile(filePath, payload, 0o644); err != nil {
		return err
	}
	if err := unix.Setxattr(filePath, "user.vfs_harness", []byte("ok"), 0); err != nil {
		return err
	}
	linkPath := filepath.Join(r.mountDir, "dir", "hello.link")
	if err := os.Symlink("hello.txt", linkPath); err != nil {
		return err
	}
	renamed := filepath.Join(r.mountDir, "dir", "renamed.txt")
	if err := renamePath(filePath, renamed); err != nil {
		return err
	}
	if got, err := os.ReadFile(renamed); err != nil || !bytes.Equal(got, payload) {
		return fmt.Errorf("verify renamed file in mounted session: %w", err)
	}
	if target, err := os.Readlink(linkPath); err != nil || target != "hello.txt" {
		return fmt.Errorf("verify symlink in mounted session: %w", err)
	}
	if got, err := getXattr(renamed, "user.vfs_harness"); err != nil || string(got) != "ok" {
		return fmt.Errorf("verify xattr in mounted session: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "created/renamed/xattr/symlink")
	return nil
}

func (r *scenarioRun) scenarioBarrierCut() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	stableFile := filepath.Join(r.mountDir, "stable.txt")
	if err := os.WriteFile(stableFile, []byte("stable-v1"), 0o644); err != nil {
		return err
	}
	if err := unix.Setxattr(stableFile, "user.stable", []byte("yes"), 0); err != nil {
		return err
	}
	if err := r.fileBarrier(stableFile); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.umountGraceful(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if got, err := os.ReadFile(stableFile); err != nil || string(got) != "stable-v1" {
		return fmt.Errorf("verify stable file after barrier restore: %w", err)
	}
	if got, err := getXattr(stableFile, "user.stable"); err != nil || string(got) != "yes" {
		return fmt.Errorf("verify stable xattr after barrier restore: %w", err)
	}
	return nil
}

func (r *scenarioRun) scenarioCrashBeforeBarrier() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	baseline := filepath.Join(r.mountDir, "baseline.txt")
	volatile := filepath.Join(r.mountDir, "volatile.txt")
	if err := os.WriteFile(baseline, []byte("baseline"), 0o644); err != nil {
		return err
	}
	if err := r.fileBarrier(baseline); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := os.WriteFile(volatile, []byte("volatile"), 0o644); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if got, err := os.ReadFile(baseline); err != nil || string(got) != "baseline" {
		return fmt.Errorf("baseline lost after crash-before-barrier: %w", err)
	}
	if _, err := os.Stat(volatile); err == nil {
		return fmt.Errorf("volatile change unexpectedly survived crash-before-barrier")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (r *scenarioRun) scenarioCrashAfterBarrier() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	stable := filepath.Join(r.mountDir, "stable.txt")
	if err := os.WriteFile(stable, []byte("after-barrier"), 0o644); err != nil {
		return err
	}
	if err := r.fileBarrier(stable); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if got, err := os.ReadFile(stable); err != nil || string(got) != "after-barrier" {
		return fmt.Errorf("durable cut did not survive crash: %w", err)
	}
	return nil
}

func (r *scenarioRun) scenarioSnapshotRestore() error {
	prevInterval := r.cfg.SnapshotInterval
	r.cfg.SnapshotInterval = "10s"
	defer func() { r.cfg.SnapshotInterval = prevInterval }()

	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}

	p := filepath.Join(r.mountDir, "snapshot.txt")
	if err := os.WriteFile(p, []byte("snapshot-payload"), 0o644); err != nil {
		return err
	}

	// Keep changing the database long enough for the snapshot monitor to fire
	// and observe fresh remote coverage.
	deadline := time.Now().Add(22 * time.Second)
	tick := 0
	for time.Now().Before(deadline) {
		payload := []byte(fmt.Sprintf("snapshot-payload-%02d", tick))
		if err := os.WriteFile(p, payload, 0o644); err != nil {
			return err
		}
		time.Sleep(2 * time.Second)
		tick++
	}

	r.captureRemoteLevels()
	if r.manifest.RemoteLevels["level_9"] == 0 {
		return fmt.Errorf("expected snapshot level objects to exist after snapshot interval")
	}

	if err := r.umountGraceful(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}

	r.captureRemoteLevels()
	r.captureOpenTiming()
	if r.manifest.OpenTiming["snapshots"] == "0" || r.manifest.OpenTiming["snapshots"] == "" {
		return fmt.Errorf("expected restore plan to select a snapshot")
	}
	if got, err := os.ReadFile(p); err != nil || !strings.HasPrefix(string(got), "snapshot-payload-") {
		return fmt.Errorf("verify snapshot-restored file: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "snapshot-selected")
	return nil
}

func (r *scenarioRun) scenarioTreeRestore() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	for i := 0; i < 24; i++ {
		dir := filepath.Join(r.mountDir, fmt.Sprintf("tree/d%02d", i))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		for j := 0; j < 6; j++ {
			p := filepath.Join(dir, fmt.Sprintf("f%02d.txt", j))
			if err := os.WriteFile(p, []byte(fmt.Sprintf("payload-%02d-%02d", i, j)), 0o644); err != nil {
				return err
			}
		}
	}
	symlinkPath := filepath.Join(r.mountDir, "tree", "link")
	targetPath := filepath.Join("d00", "f00.txt")
	if err := os.Symlink(targetPath, symlinkPath); err != nil {
		return err
	}
	xattrFile := filepath.Join(r.mountDir, "tree", "d01", "f01.txt")
	if err := unix.Setxattr(xattrFile, "user.tree", []byte("present"), 0); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if got, err := os.ReadFile(filepath.Join(r.mountDir, "tree", "d13", "f04.txt")); err != nil || string(got) != "payload-13-04" {
		return fmt.Errorf("verify tree payload: %w", err)
	}
	if target, err := os.Readlink(symlinkPath); err != nil || target != targetPath {
		return fmt.Errorf("verify tree symlink: %w", err)
	}
	if got, err := getXattr(xattrFile, "user.tree"); err != nil || string(got) != "present" {
		return fmt.Errorf("verify tree xattr: %w", err)
	}
	return nil
}

func (r *scenarioRun) scenarioSessionChurn() error {
	if err := r.format(); err != nil {
		return err
	}
	for i := 0; i < 4; i++ {
		if err := r.mount(); err != nil {
			return err
		}
		p := filepath.Join(r.mountDir, fmt.Sprintf("churn-%02d.txt", i))
		if err := os.WriteFile(p, []byte(fmt.Sprintf("round-%02d", i)), 0o644); err != nil {
			return err
		}
		if _, err := r.runCommand("status", filepath.Join(r.logDir, fmt.Sprintf("status-%02d.log", i)), "status", r.metaURL); err != nil {
			return err
		}
		if err := r.umountGraceful(); err != nil {
			return err
		}
	}
	if err := r.mount(); err != nil {
		return err
	}
	for i := 0; i < 4; i++ {
		p := filepath.Join(r.mountDir, fmt.Sprintf("churn-%02d.txt", i))
		if got, err := os.ReadFile(p); err != nil || string(got) != fmt.Sprintf("round-%02d", i) {
			return fmt.Errorf("verify churn file %d: %w", i, err)
		}
	}
	return nil
}

func (r *scenarioRun) scenarioMetadataRestoreMatrix() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}

	root := filepath.Join(r.mountDir, "compat")
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	baseline := filepath.Join(root, "baseline.txt")
	linkPath := filepath.Join(root, "baseline.link")
	hardlinkPath := filepath.Join(root, "baseline.hard")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(baseline, []byte("baseline-v1"), 0o644); err != nil {
		return err
	}
	if err := unix.Setxattr(baseline, "user.compat", []byte("v1"), 0); err != nil {
		return err
	}
	if err := os.Symlink("baseline.txt", linkPath); err != nil {
		return err
	}
	if err := os.Link(baseline, hardlinkPath); err != nil {
		return err
	}
	if err := r.fileBarrier(baseline); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.umountGraceful(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := verifyFileContent(baseline, "baseline-v1"); err != nil {
		return fmt.Errorf("baseline after graceful restore: %w", err)
	}
	if err := verifyXattrValue(baseline, "user.compat", "v1"); err != nil {
		return fmt.Errorf("baseline xattr after graceful restore: %w", err)
	}
	if err := verifySymlinkTarget(linkPath, "baseline.txt"); err != nil {
		return fmt.Errorf("baseline symlink after graceful restore: %w", err)
	}
	if err := verifySameInode(baseline, hardlinkPath); err != nil {
		return fmt.Errorf("baseline hardlink after graceful restore: %w", err)
	}

	renamed := filepath.Join(root, "renamed.txt")
	durable := filepath.Join(root, "durable.txt")
	if err := renamePath(baseline, renamed); err != nil {
		return err
	}
	if err := unix.Setxattr(renamed, "user.compat", []byte("v2"), 0); err != nil {
		return err
	}
	if err := os.WriteFile(durable, []byte("durable-v2"), 0o644); err != nil {
		return err
	}
	if err := r.fileBarrier(durable); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := verifyFileContent(renamed, "baseline-v1"); err != nil {
		return fmt.Errorf("renamed file after crash-after-barrier restore: %w", err)
	}
	if err := verifyXattrValue(renamed, "user.compat", "v2"); err != nil {
		return fmt.Errorf("renamed xattr after crash-after-barrier restore: %w", err)
	}
	if err := verifyFileContent(durable, "durable-v2"); err != nil {
		return fmt.Errorf("durable file after crash-after-barrier restore: %w", err)
	}
	if err := verifySameInode(renamed, hardlinkPath); err != nil {
		return fmt.Errorf("hardlink after crash-after-barrier restore: %w", err)
	}

	volatile := filepath.Join(root, "volatile.txt")
	if err := os.WriteFile(volatile, []byte("volatile-v3"), 0o644); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if _, err := os.Stat(volatile); err == nil {
		return fmt.Errorf("volatile file unexpectedly survived crash-before-barrier restore")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := verifyFileContent(renamed, "baseline-v1"); err != nil {
		return fmt.Errorf("renamed file after crash-before-barrier restore: %w", err)
	}
	if err := verifyFileContent(durable, "durable-v2"); err != nil {
		return fmt.Errorf("durable file after crash-before-barrier restore: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "metadata-restore-matrix")
	return nil
}

func (r *scenarioRun) scenarioRenameSemanticsMatrix() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}

	root := filepath.Join(r.mountDir, "rename-matrix")
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}

	fileSrc := filepath.Join(root, "file-src.txt")
	fileDst := filepath.Join(root, "file-dst.txt")
	if err := os.WriteFile(fileSrc, []byte("file-overwrite-src"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(fileDst, []byte("file-overwrite-dst"), 0o644); err != nil {
		return err
	}
	if err := renamePath(fileSrc, fileDst); err != nil {
		return fmt.Errorf("file overwrite rename: %w", err)
	}
	if err := verifyFileContent(fileDst, "file-overwrite-src"); err != nil {
		return fmt.Errorf("file overwrite content: %w", err)
	}
	if _, err := os.Stat(fileSrc); err == nil {
		return fmt.Errorf("file overwrite source still exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	dirMissingSrc := filepath.Join(root, "dir-missing-src")
	dirMissingDst := filepath.Join(root, "dir-missing-dst")
	if err := os.MkdirAll(filepath.Join(dirMissingSrc, "nested"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dirMissingSrc, "nested", "payload.txt"), []byte("missing"), 0o644); err != nil {
		return err
	}
	if err := renamePath(dirMissingSrc, dirMissingDst); err != nil {
		return fmt.Errorf("dir to missing rename: %w", err)
	}
	if err := verifyFileContent(filepath.Join(dirMissingDst, "nested", "payload.txt"), "missing"); err != nil {
		return fmt.Errorf("dir to missing payload: %w", err)
	}

	dirEmptySrc := filepath.Join(root, "dir-empty-src")
	dirEmptyDst := filepath.Join(root, "dir-empty-dst")
	if err := os.MkdirAll(filepath.Join(dirEmptySrc, "nested"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dirEmptySrc, "nested", "payload.txt"), []byte("empty"), 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(dirEmptyDst, 0o755); err != nil {
		return err
	}
	if err := renamePath(dirEmptySrc, dirEmptyDst); err != nil {
		return fmt.Errorf("dir to empty dir rename: %w", err)
	}
	if err := verifyFileContent(filepath.Join(dirEmptyDst, "nested", "payload.txt"), "empty"); err != nil {
		return fmt.Errorf("dir to empty dir payload: %w", err)
	}

	dirNonEmptySrc := filepath.Join(root, "dir-nonempty-src")
	dirNonEmptyDst := filepath.Join(root, "dir-nonempty-dst")
	if err := os.MkdirAll(filepath.Join(dirNonEmptySrc, "nested"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dirNonEmptySrc, "nested", "payload.txt"), []byte("nonempty-src"), 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(dirNonEmptyDst, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dirNonEmptyDst, "keep.txt"), []byte("keep"), 0o644); err != nil {
		return err
	}
	if err := renamePath(dirNonEmptySrc, dirNonEmptyDst); err == nil {
		return fmt.Errorf("dir to non-empty dir unexpectedly succeeded")
	}
	if err := verifyFileContent(filepath.Join(dirNonEmptySrc, "nested", "payload.txt"), "nonempty-src"); err != nil {
		return fmt.Errorf("dir to non-empty src changed: %w", err)
	}
	if err := verifyFileContent(filepath.Join(dirNonEmptyDst, "keep.txt"), "keep"); err != nil {
		return fmt.Errorf("dir to non-empty dst changed: %w", err)
	}

	dirToFileSrc := filepath.Join(root, "dir-file-src")
	dirToFileDst := filepath.Join(root, "dir-file-dst.txt")
	if err := os.MkdirAll(filepath.Join(dirToFileSrc, "nested"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dirToFileSrc, "nested", "payload.txt"), []byte("dir-file-src"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(dirToFileDst, []byte("target-file"), 0o644); err != nil {
		return err
	}
	if err := renamePath(dirToFileSrc, dirToFileDst); err == nil {
		return fmt.Errorf("dir to file unexpectedly succeeded")
	}
	if err := verifyFileContent(dirToFileDst, "target-file"); err != nil {
		return fmt.Errorf("dir to file dst changed: %w", err)
	}

	fileToDirSrc := filepath.Join(root, "file-dir-src.txt")
	fileToDirDst := filepath.Join(root, "file-dir-dst")
	if err := os.WriteFile(fileToDirSrc, []byte("file-dir-src"), 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(fileToDirDst, 0o755); err != nil {
		return err
	}
	if err := renamePath(fileToDirSrc, fileToDirDst); err == nil {
		return fmt.Errorf("file to dir unexpectedly succeeded")
	}
	if err := verifyFileContent(fileToDirSrc, "file-dir-src"); err != nil {
		return fmt.Errorf("file to dir src changed: %w", err)
	}

	hardBase := filepath.Join(root, "hard-base.txt")
	hardAlias := filepath.Join(root, "hard-alias.txt")
	hardMoved := filepath.Join(root, "hard-moved.txt")
	if err := os.WriteFile(hardBase, []byte("hardlink-payload"), 0o644); err != nil {
		return err
	}
	if err := os.Link(hardBase, hardAlias); err != nil {
		return err
	}
	if err := renamePath(hardAlias, hardMoved); err != nil {
		return fmt.Errorf("hardlink rename: %w", err)
	}
	if err := verifySameInode(hardBase, hardMoved); err != nil {
		return fmt.Errorf("hardlink rename inode: %w", err)
	}
	if err := verifyFileContent(hardMoved, "hardlink-payload"); err != nil {
		return fmt.Errorf("hardlink rename content: %w", err)
	}

	r.manifest.Checks = append(r.manifest.Checks, "rename-semantics-matrix")
	return nil
}

func (r *scenarioRun) scenarioXattrRestoreMatrix() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}

	root := filepath.Join(r.mountDir, "xattr-matrix")
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	base := filepath.Join(root, "base.txt")
	alias := filepath.Join(root, "alias.txt")
	renamed := filepath.Join(root, "renamed.txt")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(base, []byte("xattr-payload"), 0o644); err != nil {
		return err
	}
	if err := os.Link(base, alias); err != nil {
		return err
	}
	if err := unix.Setxattr(base, "user.alpha", []byte("a1"), 0); err != nil {
		return err
	}
	if err := unix.Setxattr(base, "user.beta", []byte("b1"), 0); err != nil {
		return err
	}
	if err := unix.Setxattr(alias, "user.alpha", []byte("a2"), 0); err != nil {
		return err
	}
	if err := unix.Removexattr(alias, "user.beta"); err != nil {
		return err
	}
	if err := unix.Setxattr(alias, "user.gamma", []byte("g1"), 0); err != nil {
		return err
	}
	if err := renamePath(base, renamed); err != nil {
		return err
	}
	if err := r.fileBarrier(renamed); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.umountGraceful(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := verifyFileContent(renamed, "xattr-payload"); err != nil {
		return fmt.Errorf("renamed payload after restore: %w", err)
	}
	if err := verifySameInode(renamed, alias); err != nil {
		return fmt.Errorf("hardlink inode after restore: %w", err)
	}
	if err := verifyXattrValue(renamed, "user.alpha", "a2"); err != nil {
		return fmt.Errorf("alpha after restore: %w", err)
	}
	if err := verifyMissingXattr(renamed, "user.beta"); err != nil {
		return fmt.Errorf("beta after restore: %w", err)
	}
	if err := verifyXattrValue(alias, "user.gamma", "g1"); err != nil {
		return fmt.Errorf("gamma after restore via alias: %w", err)
	}

	if err := unix.Setxattr(renamed, "user.gamma", []byte("g2"), 0); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := verifyXattrValue(renamed, "user.alpha", "a2"); err != nil {
		return fmt.Errorf("alpha after crash restore: %w", err)
	}
	if err := verifyMissingXattr(renamed, "user.beta"); err != nil {
		return fmt.Errorf("beta after crash restore: %w", err)
	}
	if err := verifyXattrValue(alias, "user.gamma", "g2"); err != nil {
		return fmt.Errorf("gamma after crash restore: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "xattr-restore-matrix")
	return nil
}

func (r *scenarioRun) scenarioCrossModeRestore() error {
	modes := []string{"full", "snapshot_only", "compaction_only", "off"}
	originalMode := r.cfg.RuntimeMaintenance
	defer func() { r.cfg.RuntimeMaintenance = originalMode }()

	if err := r.format(); err != nil {
		return err
	}
	r.cfg.RuntimeMaintenance = "full"
	if err := r.mount(); err != nil {
		return err
	}
	root := filepath.Join(r.mountDir, "cross-mode")
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	base := filepath.Join(root, "base.txt")
	link := filepath.Join(root, "base.link")
	hard := filepath.Join(root, "base.hard")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(base, []byte("cross-mode-payload"), 0o644); err != nil {
		return err
	}
	if err := unix.Setxattr(base, "user.cross", []byte("ok"), 0); err != nil {
		return err
	}
	if err := os.Symlink("base.txt", link); err != nil {
		return err
	}
	if err := os.Link(base, hard); err != nil {
		return err
	}
	if err := r.fileBarrier(base); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.umountGraceful(); err != nil {
		return err
	}

	for _, mode := range modes {
		if err := r.removeLocalMetaArtifacts(); err != nil {
			return err
		}
		r.cfg.RuntimeMaintenance = mode
		if err := r.mount(); err != nil {
			return fmt.Errorf("mount in mode %s: %w", mode, err)
		}
		if err := verifyFileContent(base, "cross-mode-payload"); err != nil {
			return fmt.Errorf("base in mode %s: %w", mode, err)
		}
		if err := verifyXattrValue(base, "user.cross", "ok"); err != nil {
			return fmt.Errorf("xattr in mode %s: %w", mode, err)
		}
		if err := verifySymlinkTarget(link, "base.txt"); err != nil {
			return fmt.Errorf("symlink in mode %s: %w", mode, err)
		}
		if err := verifySameInode(base, hard); err != nil {
			return fmt.Errorf("hardlink in mode %s: %w", mode, err)
		}
		r.manifest.Checks = append(r.manifest.Checks, "cross-mode-"+mode)
		if err := r.umountGraceful(); err != nil {
			return err
		}
	}
	r.manifest.Checks = append(r.manifest.Checks, "cross-mode-restore")
	return nil
}

func (r *scenarioRun) scenarioLocalMetaWriteFailureRecover() error {
	if err := r.format(); err != nil {
		return err
	}
	originalBin := r.cfg.JuiceFSBin
	limitedBin, err := r.createFileSizeLimitedWrapper(128)
	if err != nil {
		return err
	}
	r.cfg.JuiceFSBin = limitedBin
	if err := r.mount(); err != nil {
		r.cfg.JuiceFSBin = originalBin
		return err
	}

	root := filepath.Join(r.mountDir, "local-meta-write-failure")
	baseline := filepath.Join(root, "baseline.txt")
	linkPath := filepath.Join(root, "baseline.link")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(baseline, []byte("baseline-durable"), 0o644); err != nil {
		return err
	}
	if err := unix.Setxattr(baseline, "user.failure", []byte("durable"), 0); err != nil {
		return err
	}
	if err := os.Symlink("baseline.txt", linkPath); err != nil {
		return err
	}
	if err := r.fileBarrier(baseline); err != nil {
		return err
	}
	if err := r.metaBarrier(); err != nil {
		return err
	}

	failureObserved := false
	var failureText string
	for i := 0; i < 5000; i++ {
		dir := filepath.Join(root, "fill", fmt.Sprintf("d%04d", i/100))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			failureObserved = true
			failureText = err.Error()
			break
		}
		p := filepath.Join(dir, fmt.Sprintf("f%04d.txt", i))
		if err := os.WriteFile(p, []byte(fmt.Sprintf("fill-%04d", i)), 0o644); err != nil {
			failureObserved = true
			failureText = err.Error()
			break
		}
		if err := unix.Setxattr(p, "user.fill", []byte(fmt.Sprintf("x%04d", i)), 0); err != nil {
			failureObserved = true
			failureText = err.Error()
			break
		}
		if r.mountCmd != nil && r.mountCmd.Process != nil {
			if err := r.mountCmd.Process.Signal(syscall.Signal(0)); err != nil {
				failureObserved = true
				failureText = err.Error()
				break
			}
		}
	}
	if !failureObserved {
		return fmt.Errorf("failed to induce local metadata write failure under file-size-limited mount")
	}
	r.manifest.Checks = append(r.manifest.Checks, "local-meta-write-failure-observed")
	if r.manifest.ScenarioData == nil {
		r.manifest.ScenarioData = map[string]string{}
	}
	r.manifest.ScenarioData["local_failure_mode"] = failureText

	_ = r.killMount()
	_ = r.ensureUnmount()
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	r.cfg.JuiceFSBin = originalBin
	if err := r.mount(); err != nil {
		return err
	}
	if err := verifyFileContent(baseline, "baseline-durable"); err != nil {
		return fmt.Errorf("baseline after local meta failure recover: %w", err)
	}
	if err := verifyXattrValue(baseline, "user.failure", "durable"); err != nil {
		return fmt.Errorf("baseline xattr after local meta failure recover: %w", err)
	}
	if err := verifySymlinkTarget(linkPath, "baseline.txt"); err != nil {
		return fmt.Errorf("baseline symlink after local meta failure recover: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "local-meta-write-failure-recover")
	return nil
}

func (r *scenarioRun) scenarioFuzzChurn() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(r.mountDir, "fuzz")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(r.mountDir, "fuzz"), 0o755); err != nil {
		return err
	}
	seed := r.cfg.FuzzSeed
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	checkpointEvery := r.cfg.FuzzCheckpointEvery
	if checkpointEvery <= 0 {
		checkpointEvery = 8
	}
	if r.cfg.FuzzOps <= 0 {
		return fmt.Errorf("fuzz-ops must be > 0")
	}
	r.manifest.ScenarioData = map[string]string{
		"replay_schema":    fuzzReplaySchemaVersion,
		"seed":             fmt.Sprintf("%d", seed),
		"ops":              fmt.Sprintf("%d", r.cfg.FuzzOps),
		"checkpoint_every": fmt.Sprintf("%d", checkpointEvery),
		"large_files":      "fuzz/large/large-00.bin,fuzz/large/large-01.bin",
	}
	rng := rand.New(rand.NewSource(seed))
	model := newFuzzModel()
	nameSeq := 0
	if err := r.runStructuredFuzzCoverage(rng, model, &nameSeq); err != nil {
		r.recordFuzzFailure(0)
		return err
	}

	for i := 0; i < r.cfg.FuzzOps; i++ {
		if err := r.applyRandomFuzzOp(rng, model, &nameSeq, i); err != nil {
			r.recordFuzzFailure(i + 1)
			return err
		}
		if (i+1)%checkpointEvery == 0 {
			if err := r.fuzzCheckpoint(model, i+1); err != nil {
				r.recordFuzzFailure(i + 1)
				return err
			}
		}
	}
	if r.cfg.FuzzOps%checkpointEvery == 0 {
		r.finalizeFuzzDigest(model)
		return nil
	}
	if err := r.fuzzCheckpoint(model, r.cfg.FuzzOps); err != nil {
		r.recordFuzzFailure(r.cfg.FuzzOps)
		return err
	}
	r.finalizeFuzzDigest(model)
	return nil
}

func (r *scenarioRun) scenarioChaosCrashFuzz() error {
	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(r.mountDir, "fuzz")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(r.mountDir, "fuzz"), 0o755); err != nil {
		return err
	}
	seed := r.cfg.FuzzSeed
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	checkpointEvery := r.cfg.FuzzCheckpointEvery
	if checkpointEvery <= 0 {
		checkpointEvery = 7
	}
	if r.cfg.FuzzOps <= 0 {
		return fmt.Errorf("fuzz-ops must be > 0")
	}
	r.manifest.ScenarioData = map[string]string{
		"replay_schema":     fuzzReplaySchemaVersion,
		"seed":              fmt.Sprintf("%d", seed),
		"ops":               fmt.Sprintf("%d", r.cfg.FuzzOps),
		"checkpoint_every":  fmt.Sprintf("%d", checkpointEvery),
		"chaos_crash_rate":  "1/6",
		"chaos_commit_rate": "1/5",
	}
	rng := rand.New(rand.NewSource(seed))
	liveModel := newFuzzModel()
	nameSeq := 0
	if err := r.runStructuredFuzzCoverage(rng, liveModel, &nameSeq); err != nil {
		r.recordFuzzFailure(0)
		return err
	}
	if err := r.fuzzCheckpoint(liveModel, 0); err != nil {
		r.recordFuzzFailure(0)
		return err
	}
	durableModel := liveModel.clone()

	for i := 0; i < r.cfg.FuzzOps; i++ {
		if err := r.applyRandomFuzzOp(rng, liveModel, &nameSeq, i); err != nil {
			r.recordFuzzFailure(i + 1)
			return err
		}

		step := i + 1
		switch event := rng.Intn(11); {
		case event == 0:
			if err := r.chaosCrashRestore(durableModel, step); err != nil {
				r.recordFuzzFailure(step)
				return err
			}
			liveModel = durableModel.clone()
			r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("chaos-crash-%d", step))
		case event == 1 || step%checkpointEvery == 0:
			if err := r.chaosCommitCheckpoint(liveModel, step); err != nil {
				r.recordFuzzFailure(step)
				return err
			}
			durableModel = liveModel.clone()
			r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("chaos-commit-%d", step))
		}
	}

	if err := r.chaosCommitCheckpoint(liveModel, r.cfg.FuzzOps); err != nil {
		r.recordFuzzFailure(r.cfg.FuzzOps)
		return err
	}
	r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("chaos-commit-%d", r.cfg.FuzzOps))
	r.finalizeFuzzDigest(liveModel)
	return nil
}

func (r *scenarioRun) scenarioPeriodicCommitChaos() error {
	originalSync := r.syncIntervalOverride
	r.syncIntervalOverride = "1s"
	defer func() { r.syncIntervalOverride = originalSync }()

	if err := r.format(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(r.mountDir, "fuzz")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(r.mountDir, "fuzz"), 0o755); err != nil {
		return err
	}
	seed := r.cfg.FuzzSeed
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	checkpointEvery := r.cfg.FuzzCheckpointEvery
	if checkpointEvery <= 0 {
		checkpointEvery = 7
	}
	if r.cfg.FuzzOps <= 0 {
		return fmt.Errorf("fuzz-ops must be > 0")
	}
	settleDelay := r.cfg.PeriodicSettleDelay
	r.manifest.ScenarioData = map[string]string{
		"replay_schema":        periodicCommitChaosSchemaVersion,
		"seed":                 fmt.Sprintf("%d", seed),
		"ops":                  fmt.Sprintf("%d", r.cfg.FuzzOps),
		"checkpoint_every":     fmt.Sprintf("%d", checkpointEvery),
		"periodic_sync_window": r.syncIntervalOverride,
		"settle_delay":         settleDelay.String(),
		"chaos_crash_rate":     "1/6",
		"settle_probe_rate":    "1/5",
	}
	tracePath := filepath.Join(r.runDir, "periodic_trace.json")
	r.manifest.LocalPaths["periodic_trace"] = tracePath
	var trace []periodicTraceEvent
	defer func() {
		_ = writeJSONFile(tracePath, trace)
	}()
	rng := rand.New(rand.NewSource(seed))
	liveModel := newFuzzModel()
	nameSeq := 0
	if err := r.runStructuredFuzzCoverage(rng, liveModel, &nameSeq); err != nil {
		r.recordFuzzFailure(0)
		return err
	}
	if err := r.periodicCommitProbe(liveModel, 0, settleDelay); err != nil {
		r.recordFuzzFailure(0)
		return err
	}
	durableModel := liveModel.clone()
	history := []periodicSnapshot{{step: 0, model: durableModel.clone()}}
	trace = append(trace, periodicTraceEvent{
		Step:          0,
		Event:         "initial-settle",
		LiveDigest:    liveModel.digest(),
		DurableDigest: durableModel.digest(),
		MatchedStep:   0,
	})

	for i := 0; i < r.cfg.FuzzOps; i++ {
		if err := r.applyRandomFuzzOp(rng, liveModel, &nameSeq, i); err != nil {
			r.recordFuzzFailure(i + 1)
			return err
		}
		step := i + 1
		history = append(history, periodicSnapshot{step: step, model: liveModel.clone()})
		switch event := rng.Intn(11); {
		case event == 0:
			historyDigests := periodicHistoryDigests(history)
			matched, matchedStep, actualDigest, err := r.periodicCrashRestore(history, step)
			trace = append(trace, periodicTraceEvent{
				Step:           step,
				Event:          "crash",
				LiveDigest:     liveModel.digest(),
				DurableDigest:  durableModel.digest(),
				ActualDigest:   actualDigest,
				MatchedStep:    matchedStep,
				HistoryDigests: historyDigests,
			})
			if err != nil {
				r.recordFuzzFailure(step)
				return err
			}
			durableModel = matched.clone()
			liveModel = matched.clone()
			history = []periodicSnapshot{{step: matchedStep, model: matched.clone()}}
			r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("periodic-crash-%d->%d", step, matchedStep))
		case event == 1 || step%checkpointEvery == 0:
			if err := r.periodicCommitProbe(liveModel, step, settleDelay); err != nil {
				r.recordFuzzFailure(step)
				return err
			}
			durableModel = liveModel.clone()
			history = []periodicSnapshot{{step: step, model: durableModel.clone()}}
			trace = append(trace, periodicTraceEvent{
				Step:          step,
				Event:         "settle",
				LiveDigest:    liveModel.digest(),
				DurableDigest: durableModel.digest(),
				MatchedStep:   step,
			})
			r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("periodic-settle-%d", step))
		}
	}

	if err := r.periodicCommitProbe(liveModel, r.cfg.FuzzOps, settleDelay); err != nil {
		r.recordFuzzFailure(r.cfg.FuzzOps)
		return err
	}
	r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("periodic-settle-%d", r.cfg.FuzzOps))
	r.finalizeFuzzDigest(liveModel)
	return nil
}

func (r *scenarioRun) scenarioSoak() error {
	if err := r.format(); err != nil {
		return err
	}
	deadline := time.Now().Add(r.cfg.SoakDuration)
	round := 0
	for time.Now().Before(deadline) {
		if err := r.mount(); err != nil {
			return err
		}
		roundBudget := r.cfg.SoakRoundDuration
		if roundBudget <= 0 {
			roundBudget = r.cfg.SoakDuration
		}
		roundDeadline := time.Now().Add(roundBudget)
		if roundDeadline.After(deadline) {
			roundDeadline = deadline
		}
		if err := r.runSoakRound(round, roundDeadline); err != nil {
			return err
		}
		if err := r.metaBarrier(); err != nil {
			return err
		}
		barrierGrace := r.cfg.SoakBarrierGrace
		if remain := time.Until(deadline); remain > 0 {
			if remain < barrierGrace {
				barrierGrace = remain
			}
			if barrierGrace > 0 {
				time.Sleep(barrierGrace)
			}
		}
		if round%2 == 0 {
			if err := r.umountGraceful(); err != nil {
				return err
			}
		} else {
			if err := r.killMount(); err != nil {
				return err
			}
			if err := r.ensureUnmount(); err != nil {
				return err
			}
		}
		round++
	}
	return nil
}

func newFuzzModel() *fuzzModel {
	return &fuzzModel{
		dirs:        map[string]struct{}{"": {}},
		filePaths:   make(map[string]string),
		fileObjects: make(map[string]fuzzFileObject),
		symlinks:    make(map[string]string),
	}
}

func (r *scenarioRun) applyRandomFuzzOp(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	ops := []func(*rand.Rand, *fuzzModel, *int, int) error{
		r.fuzzOpMkdir,
		r.fuzzOpWriteFile,
		r.fuzzOpOverwriteFile,
		r.fuzzOpAppendFile,
		r.fuzzOpPartialOverwriteFile,
		r.fuzzOpTruncateFile,
		r.fuzzOpLargeFileWrite,
		r.fuzzOpHardlinkFile,
		r.fuzzOpRenameEntry,
		r.fuzzOpRemoveEntry,
		r.fuzzOpSetXattr,
		r.fuzzOpSymlink,
	}
	for attempt := 0; attempt < len(ops)*2; attempt++ {
		op := ops[rng.Intn(len(ops))]
		if err := op(rng, model, nameSeq, opIndex); err != nil {
			if errors.Is(err, errFuzzSkip) {
				continue
			}
			return err
		}
		return nil
	}
	return r.fuzzOpWriteFile(rng, model, nameSeq, opIndex)
}

var errFuzzSkip = errors.New("fuzz-op-skip")

func (r *scenarioRun) runStructuredFuzzCoverage(rng *rand.Rand, model *fuzzModel, nameSeq *int) error {
	if err := r.ensureFuzzDir(model, "links"); err != nil {
		return err
	}
	if err := r.ensureFuzzDir(model, "matrix"); err != nil {
		return err
	}
	if err := r.ensureFuzzDir(model, "large"); err != nil {
		return err
	}
	if err := r.runHardlinkCoverage(rng, model, nameSeq); err != nil {
		return err
	}
	if err := r.runRenameOverwriteCoverage(rng, model, nameSeq); err != nil {
		return err
	}
	return r.runLargeFileCoverage(rng, model)
}

func (r *scenarioRun) runHardlinkCoverage(rng *rand.Rand, model *fuzzModel, nameSeq *int) error {
	baseRel := joinRel("links", fmt.Sprintf("base-%03d.txt", *nameSeq))
	*nameSeq = *nameSeq + 1
	payload := fuzzPayload(rng, 900, 96)
	if err := r.writeNewFuzzFile(model, baseRel, payload); err != nil {
		return err
	}
	aliasRel := joinRel("links", fmt.Sprintf("alias-%03d.txt", *nameSeq))
	*nameSeq = *nameSeq + 1
	if err := r.createHardlink(model, baseRel, aliasRel); err != nil {
		return err
	}
	mutated := fuzzPayload(rng, 901, 128)
	if err := r.overwriteExistingFuzzFile(model, aliasRel, mutated); err != nil {
		return err
	}
	if got, err := os.ReadFile(r.fuzzFSPath(baseRel)); err != nil || !bytes.Equal(got, mutated) {
		return fmt.Errorf("hardlink alias write did not reflect through base: %w", err)
	}
	if err := r.truncateExistingFuzzFile(model, baseRel, 41); err != nil {
		return err
	}
	if got, err := os.ReadFile(r.fuzzFSPath(aliasRel)); err != nil || len(got) != 41 {
		return fmt.Errorf("hardlink truncate did not reflect through alias: %w", err)
	}
	if err := r.removeFuzzPath(model, aliasRel); err != nil {
		return err
	}
	if _, err := os.Stat(r.fuzzFSPath(baseRel)); err != nil {
		return fmt.Errorf("base path disappeared after alias unlink: %w", err)
	}
	finalRel := joinRel("links", fmt.Sprintf("final-%03d.txt", *nameSeq))
	*nameSeq = *nameSeq + 1
	if err := r.createHardlink(model, baseRel, finalRel); err != nil {
		return err
	}
	if err := r.removeFuzzPath(model, baseRel); err != nil {
		return err
	}
	if _, err := os.Stat(r.fuzzFSPath(finalRel)); err != nil {
		return fmt.Errorf("surviving hardlink missing after base unlink: %w", err)
	}
	if err := r.removeFuzzPath(model, finalRel); err != nil {
		return err
	}
	if _, err := os.Stat(r.fuzzFSPath(finalRel)); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("final hardlink path still exists after last unlink: %w", err)
	}
	r.manifest.Checks = append(r.manifest.Checks, "hardlink-semantics")
	return nil
}

func (r *scenarioRun) runRenameOverwriteCoverage(rng *rand.Rand, model *fuzzModel, nameSeq *int) error {
	type renameCase struct {
		label    string
		setup    func(srcRel, dstRel string) error
		renameOk bool
	}
	cases := []renameCase{
		{
			label: "dir-to-missing",
			setup: func(srcRel, _ string) error {
				return r.populateRenameSource(model, srcRel, rng)
			},
			renameOk: true,
		},
		{
			label: "dir-to-empty-dir",
			setup: func(srcRel, dstRel string) error {
				if err := r.populateRenameSource(model, srcRel, rng); err != nil {
					return err
				}
				return r.ensureFuzzDir(model, dstRel)
			},
			renameOk: true,
		},
		{
			label: "dir-to-non-empty-dir",
			setup: func(srcRel, dstRel string) error {
				if err := r.populateRenameSource(model, srcRel, rng); err != nil {
					return err
				}
				if err := r.ensureFuzzDir(model, dstRel); err != nil {
					return err
				}
				return r.writeNewFuzzFile(model, joinRel(dstRel, "existing.txt"), fuzzPayload(rng, 910, 32))
			},
			renameOk: false,
		},
		{
			label: "dir-to-file",
			setup: func(srcRel, dstRel string) error {
				if err := r.populateRenameSource(model, srcRel, rng); err != nil {
					return err
				}
				return r.writeNewFuzzFile(model, dstRel, fuzzPayload(rng, 911, 32))
			},
			renameOk: false,
		},
		{
			label: "file-to-dir",
			setup: func(srcRel, dstRel string) error {
				if err := r.writeNewFuzzFile(model, srcRel, fuzzPayload(rng, 912, 40)); err != nil {
					return err
				}
				return r.ensureFuzzDir(model, dstRel)
			},
			renameOk: false,
		},
	}
	for _, tc := range cases {
		base := joinRel("matrix", fmt.Sprintf("%s-%03d", tc.label, *nameSeq))
		*nameSeq = *nameSeq + 1
		var srcRel, dstRel string
		if tc.label == "file-to-dir" {
			srcRel = base + "-src.txt"
			dstRel = base + "-dst"
		} else {
			srcRel = base + "-src"
			dstRel = base + "-dst"
		}
		if err := tc.setup(srcRel, dstRel); err != nil {
			return err
		}
		before := model.clone()
		err := renamePath(r.fuzzFSPath(srcRel), r.fuzzFSPath(dstRel))
		if tc.renameOk {
			if err != nil {
				return fmt.Errorf("%s expected success: %w (src_exists=%t dst_exists=%t dst_entries=%v)", tc.label, err, pathExists(r.fuzzFSPath(srcRel)), pathExists(r.fuzzFSPath(dstRel)), listDirNames(r.fuzzFSPath(dstRel)))
			}
			if err := model.renameDirOrFile(srcRel, dstRel); err != nil {
				return fmt.Errorf("%s model update: %w", tc.label, err)
			}
		} else {
			if err == nil {
				return fmt.Errorf("%s expected failure but rename succeeded", tc.label)
			}
			if diff := before.diff(model); diff != "" {
				return fmt.Errorf("%s mutated model on expected failure: %s", tc.label, diff)
			}
			if err := r.verifyRenameFailureFSState(before, srcRel, dstRel); err != nil {
				return fmt.Errorf("%s fs state changed on expected failure: %w", tc.label, err)
			}
		}
	}
	r.manifest.Checks = append(r.manifest.Checks, "rename-overwrite-matrix")
	return nil
}

func (r *scenarioRun) runLargeFileCoverage(rng *rand.Rand, model *fuzzModel) error {
	for _, rel := range []string{largeFilePath(0), largeFilePath(1)} {
		if err := r.writeNewFuzzFile(model, rel, nil); err != nil {
			return err
		}
	}
	largeA := largeFilePath(0)
	largeB := largeFilePath(1)
	if err := r.largeWriteAt(model, largeA, 0, fuzzPayload(rng, 920, 3*fuzzPageSize)); err != nil {
		return err
	}
	if err := r.largeWriteAt(model, largeA, 7*fuzzPageSize+137, fuzzPayload(rng, 921, 2*fuzzPageSize+200)); err != nil {
		return err
	}
	if err := r.largeAppend(model, largeA, fuzzPayload(rng, 922, fuzzPageSize/2)); err != nil {
		return err
	}
	if err := r.largeTruncate(model, largeA, 5*fuzzPageSize+123); err != nil {
		return err
	}
	if err := r.largeWriteAt(model, largeA, 5*fuzzPageSize+17, fuzzPayload(rng, 923, 2*fuzzPageSize+180)); err != nil {
		return err
	}
	if err := r.largeWriteAt(model, largeB, fuzzPageSize+91, fuzzPayload(rng, 924, 3*fuzzPageSize)); err != nil {
		return err
	}
	r.manifest.Checks = append(r.manifest.Checks, "large-file-semantics")
	return nil
}

func (r *scenarioRun) recordFuzzFailure(step int) {
	if step > 0 {
		r.manifest.FailureStep = step
	}
}

func (r *scenarioRun) finalizeFuzzDigest(model *fuzzModel) {
	digest := model.digest()
	r.manifest.FinalDigest = digest
	if r.manifest.LastCheckpoint == "" {
		r.manifest.LastCheckpoint = digest
	}
}

func (r *scenarioRun) fuzzFSPath(rel string) string {
	return filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
}

func (r *scenarioRun) ensureFuzzDir(model *fuzzModel, rel string) error {
	full := r.fuzzFSPath(rel)
	if err := os.MkdirAll(full, 0o755); err != nil {
		return err
	}
	model.addDir(rel)
	return nil
}

func (r *scenarioRun) writeNewFuzzFile(model *fuzzModel, rel string, payload []byte) error {
	if err := r.ensureFuzzDir(model, pathDirRel(rel)); err != nil {
		return err
	}
	if err := os.WriteFile(r.fuzzFSPath(rel), payload, 0o644); err != nil {
		return err
	}
	model.createFile(rel, payload)
	return nil
}

func (r *scenarioRun) overwriteExistingFuzzFile(model *fuzzModel, rel string, payload []byte) error {
	if err := os.WriteFile(r.fuzzFSPath(rel), payload, 0o644); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	state.Content = append([]byte{}, payload...)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) truncateExistingFuzzFile(model *fuzzModel, rel string, size int) error {
	if err := os.Truncate(r.fuzzFSPath(rel), int64(size)); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	state.Content = applyTruncate(state.Content, size)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) removeFuzzPath(model *fuzzModel, rel string) error {
	if err := os.Remove(r.fuzzFSPath(rel)); err != nil {
		return err
	}
	model.removeFilePath(rel)
	delete(model.symlinks, rel)
	delete(model.dirs, rel)
	return nil
}

func (r *scenarioRun) createHardlink(model *fuzzModel, srcRel, dstRel string) error {
	if err := r.ensureFuzzDir(model, pathDirRel(dstRel)); err != nil {
		return err
	}
	if err := os.Link(r.fuzzFSPath(srcRel), r.fuzzFSPath(dstRel)); err != nil {
		return err
	}
	model.filePaths[dstRel] = model.filePaths[srcRel]
	return nil
}

func (r *scenarioRun) populateRenameSource(model *fuzzModel, srcRel string, rng *rand.Rand) error {
	if err := r.ensureFuzzDir(model, srcRel); err != nil {
		return err
	}
	if err := r.ensureFuzzDir(model, joinRel(srcRel, "nested")); err != nil {
		return err
	}
	if err := r.writeNewFuzzFile(model, joinRel(srcRel, "nested", "payload.txt"), fuzzPayload(rng, 930, 64)); err != nil {
		return err
	}
	return r.writeNewFuzzFile(model, joinRel(srcRel, "leaf.txt"), fuzzPayload(rng, 931, 48))
}

func (m *fuzzModel) renameDirOrFile(srcRel, dstRel string) error {
	if _, ok := m.filePaths[srcRel]; ok {
		m.filePaths[dstRel] = m.filePaths[srcRel]
		delete(m.filePaths, srcRel)
		return nil
	}
	if _, ok := m.symlinks[srcRel]; ok {
		m.symlinks[dstRel] = m.symlinks[srcRel]
		delete(m.symlinks, srcRel)
		return nil
	}
	if _, ok := m.dirs[srcRel]; ok {
		m.renameDirTree(srcRel, dstRel)
		return nil
	}
	return fmt.Errorf("rename source %s not tracked", srcRel)
}

func (r *scenarioRun) verifyRenameFailureFSState(before *fuzzModel, srcRel, dstRel string) error {
	if _, err := os.Lstat(r.fuzzFSPath(srcRel)); err != nil {
		return fmt.Errorf("source missing: %w", err)
	}
	if _, err := os.Lstat(r.fuzzFSPath(dstRel)); err != nil {
		return fmt.Errorf("destination missing: %w", err)
	}
	return r.verifyFuzzModel(before)
}

func (r *scenarioRun) largeWriteAt(model *fuzzModel, rel string, offset int, payload []byte) error {
	full := r.fuzzFSPath(rel)
	f, err := os.OpenFile(full, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(payload, int64(offset)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	state.Content = applyWriteAt(state.Content, offset, payload)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) largeAppend(model *fuzzModel, rel string, payload []byte) error {
	full := r.fuzzFSPath(rel)
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	if _, err := f.Write(payload); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	state.Content = append(state.Content, payload...)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) largeTruncate(model *fuzzModel, rel string, size int) error {
	if err := os.Truncate(r.fuzzFSPath(rel), int64(size)); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	state.Content = applyTruncate(state.Content, size)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpMkdir(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	parent := pickRandomDir(rng, model)
	rel := joinRel(parent, fmt.Sprintf("dir-%03d-%03d", opIndex, *nameSeq))
	*nameSeq = *nameSeq + 1
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.MkdirAll(full, 0o755); err != nil {
		return err
	}
	model.dirs[rel] = struct{}{}
	return nil
}

func (r *scenarioRun) fuzzOpWriteFile(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	parent := pickRandomDir(rng, model)
	rel := joinRel(parent, fmt.Sprintf("file-%03d-%03d.txt", opIndex, *nameSeq))
	*nameSeq = *nameSeq + 1
	payload := fuzzPayload(rng, opIndex, 24+rng.Intn(80))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.WriteFile(full, payload, 0o644); err != nil {
		return err
	}
	model.createFile(rel, payload)
	return nil
}

func (r *scenarioRun) fuzzOpOverwriteFile(rng *rand.Rand, model *fuzzModel, _ *int, opIndex int) error {
	rel := pickRandomRegularFile(rng, model)
	if rel == "" {
		return errFuzzSkip
	}
	state := model.getFileObject(rel)
	payload := fuzzPayload(rng, opIndex, max(1, len(state.Content)+rng.Intn(48)-16))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.WriteFile(full, payload, 0o644); err != nil {
		return err
	}
	state.Content = payload
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpAppendFile(rng *rand.Rand, model *fuzzModel, _ *int, opIndex int) error {
	rel := pickRandomRegularFile(rng, model)
	if rel == "" {
		return errFuzzSkip
	}
	state := model.getFileObject(rel)
	payload := fuzzPayload(rng, opIndex, 8+rng.Intn(40))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	if _, err := f.Write(payload); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	state.Content = append(append([]byte{}, state.Content...), payload...)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpPartialOverwriteFile(rng *rand.Rand, model *fuzzModel, _ *int, opIndex int) error {
	rel := pickRandomRegularFile(rng, model)
	if rel == "" {
		return errFuzzSkip
	}
	state := model.getFileObject(rel)
	maxOffset := len(state.Content) + 16
	offset := rng.Intn(maxOffset + 1)
	payload := fuzzPayload(rng, opIndex, 4+rng.Intn(48))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	f, err := os.OpenFile(full, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(payload, int64(offset)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	state.Content = applyWriteAt(state.Content, offset, payload)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpTruncateFile(rng *rand.Rand, model *fuzzModel, _ *int, _ int) error {
	rel := pickRandomRegularFile(rng, model)
	if rel == "" {
		return errFuzzSkip
	}
	state := model.getFileObject(rel)
	var size int
	if len(state.Content) == 0 {
		size = rng.Intn(64)
	} else {
		size = rng.Intn(len(state.Content) + 65)
	}
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.Truncate(full, int64(size)); err != nil {
		return err
	}
	state.Content = applyTruncate(state.Content, size)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpLargeFileWrite(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	rel := largeFilePath(rng.Intn(2))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	if _, ok := model.filePaths[rel]; !ok {
		if err := os.WriteFile(full, nil, 0o644); err != nil {
			return err
		}
		model.createFile(rel, nil)
	}
	state := model.getFileObject(rel)
	baseOffset := fuzzPageSize*(7+rng.Intn(3)) - rng.Intn(fuzzPageSize/2)
	if baseOffset < 0 {
		baseOffset = 0
	}
	payload := fuzzPayload(rng, opIndex, fuzzPageSize+rng.Intn(fuzzPageSize*2))
	f, err := os.OpenFile(full, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(payload, int64(baseOffset)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	state.Content = applyWriteAt(state.Content, baseOffset, payload)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpHardlinkFile(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	srcRel := pickRandomRegularFile(rng, model)
	if srcRel == "" {
		return errFuzzSkip
	}
	parent := pickRandomDir(rng, model)
	dstRel := joinRel(parent, fmt.Sprintf("hardlink-%03d-%03d.txt", opIndex, *nameSeq))
	*nameSeq = *nameSeq + 1
	srcPath := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel))
	dstPath := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))
	if err := os.Link(srcPath, dstPath); err != nil {
		return err
	}
	model.filePaths[dstRel] = model.filePaths[srcRel]
	return nil
}

func (r *scenarioRun) fuzzOpRenameOverwriteMatrix(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	type renameCase int
	const (
		dirToMissing renameCase = iota
		dirToEmptyDir
		dirToNonEmptyDir
		dirToFile
		fileToDir
	)
	cases := []renameCase{dirToMissing, dirToEmptyDir, dirToNonEmptyDir, dirToFile, fileToDir}
	for attempt := 0; attempt < len(cases)*2; attempt++ {
		switch cases[rng.Intn(len(cases))] {
		case dirToMissing:
			srcRel := pickRandomNonRootDir(rng, model)
			if srcRel == "" {
				continue
			}
			parent := pickRandomDir(rng, model)
			dstRel := joinRel(parent, fmt.Sprintf("dir-missing-%03d-%03d", opIndex, *nameSeq))
			if dstRel == srcRel || isAncestor(dstRel, srcRel) || isAncestor(srcRel, dstRel) {
				continue
			}
			*nameSeq = *nameSeq + 1
			if err := os.Rename(filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel)), filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))); err != nil {
				return err
			}
			model.renameDirTree(srcRel, dstRel)
			return nil
		case dirToEmptyDir:
			srcRel := pickRandomNonRootDir(rng, model)
			if srcRel == "" {
				continue
			}
			parent := pickRandomDir(rng, model)
			dstRel := joinRel(parent, fmt.Sprintf("dir-empty-%03d-%03d", opIndex, *nameSeq))
			if dstRel == srcRel || isAncestor(dstRel, srcRel) || isAncestor(srcRel, dstRel) {
				continue
			}
			dstFull := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))
			if err := os.MkdirAll(dstFull, 0o755); err != nil {
				return err
			}
			model.dirs[dstRel] = struct{}{}
			*nameSeq = *nameSeq + 1
			if err := os.Rename(filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel)), dstFull); err != nil {
				return err
			}
			delete(model.dirs, dstRel)
			model.renameDirTree(srcRel, dstRel)
			return nil
		case dirToNonEmptyDir:
			srcRel := pickRandomNonRootDir(rng, model)
			if srcRel == "" {
				continue
			}
			parent := pickRandomDir(rng, model)
			dstRel := joinRel(parent, fmt.Sprintf("dir-nonempty-%03d-%03d", opIndex, *nameSeq))
			if dstRel == srcRel || isAncestor(dstRel, srcRel) || isAncestor(srcRel, dstRel) {
				continue
			}
			dstFull := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))
			if err := os.MkdirAll(filepath.Join(dstFull, "child"), 0o755); err != nil {
				return err
			}
			model.dirs[dstRel] = struct{}{}
			model.dirs[joinRel(dstRel, "child")] = struct{}{}
			err := os.Rename(filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel)), dstFull)
			if err == nil {
				return fmt.Errorf("expected directory rename to non-empty target to fail")
			}
			return r.verifyFuzzModel(model)
		case dirToFile:
			srcRel := pickRandomNonRootDir(rng, model)
			if srcRel == "" {
				continue
			}
			parent := pickRandomDir(rng, model)
			dstRel := joinRel(parent, fmt.Sprintf("dir-file-%03d-%03d.txt", opIndex, *nameSeq))
			dstFull := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))
			payload := fuzzPayload(rng, opIndex, 32)
			if err := os.WriteFile(dstFull, payload, 0o644); err != nil {
				return err
			}
			model.createFile(dstRel, payload)
			*nameSeq = *nameSeq + 1
			err := os.Rename(filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel)), dstFull)
			if err == nil {
				return fmt.Errorf("expected directory rename to file target to fail")
			}
			return r.verifyFuzzModel(model)
		case fileToDir:
			srcRel := pickRandomRegularFile(rng, model)
			if srcRel == "" {
				continue
			}
			parent := pickRandomDir(rng, model)
			dstRel := joinRel(parent, fmt.Sprintf("file-dir-%03d-%03d", opIndex, *nameSeq))
			dstFull := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dstRel))
			if err := os.MkdirAll(dstFull, 0o755); err != nil {
				return err
			}
			model.dirs[dstRel] = struct{}{}
			*nameSeq = *nameSeq + 1
			err := os.Rename(filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(srcRel)), dstFull)
			if err == nil {
				return fmt.Errorf("expected file rename to directory target to fail")
			}
			return r.verifyFuzzModel(model)
		}
	}
	return nil
}

func (r *scenarioRun) fuzzOpRenameEntry(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	type entry struct {
		rel  string
		kind string
	}
	var entries []entry
	for rel := range model.filePaths {
		if isStructuredFuzzPath(rel) {
			continue
		}
		entries = append(entries, entry{rel: rel, kind: "file"})
	}
	for rel := range model.symlinks {
		if isStructuredFuzzPath(rel) {
			continue
		}
		entries = append(entries, entry{rel: rel, kind: "symlink"})
	}
	if len(entries) == 0 {
		return errFuzzSkip
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].rel == entries[j].rel {
			return entries[i].kind < entries[j].kind
		}
		return entries[i].rel < entries[j].rel
	})
	chosen := entries[rng.Intn(len(entries))]
	parent := pathDirRel(chosen.rel)
	dst := joinRel(parent, fmt.Sprintf("renamed-%03d-%03d", opIndex, *nameSeq))
	if chosen.kind == "file" {
		dst += ".txt"
	} else {
		dst += ".lnk"
	}
	*nameSeq = *nameSeq + 1
	srcPath := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(chosen.rel))
	dstPath := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(dst))
	if err := renamePath(srcPath, dstPath); err != nil {
		return err
	}
	if chosen.kind == "file" {
		model.filePaths[dst] = model.filePaths[chosen.rel]
		delete(model.filePaths, chosen.rel)
	} else {
		model.symlinks[dst] = model.symlinks[chosen.rel]
		delete(model.symlinks, chosen.rel)
	}
	return nil
}

func (r *scenarioRun) fuzzOpRemoveEntry(rng *rand.Rand, model *fuzzModel, _ *int, _ int) error {
	choices := r.fuzzRemovableEntries(model)
	if len(choices) == 0 {
		return errFuzzSkip
	}
	rel := choices[rng.Intn(len(choices))]
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := os.Remove(full); err != nil {
		return err
	}
	model.removeFilePath(rel)
	delete(model.symlinks, rel)
	delete(model.dirs, rel)
	return nil
}

func (r *scenarioRun) fuzzOpSetXattr(rng *rand.Rand, model *fuzzModel, _ *int, opIndex int) error {
	rel := pickRandomRegularFile(rng, model)
	if rel == "" {
		return errFuzzSkip
	}
	name := fmt.Sprintf("user.fuzz_%02d", rng.Intn(3))
	value := []byte(fmt.Sprintf("xattr-%03d-%08x", opIndex, rng.Uint32()))
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(rel))
	if err := unix.Setxattr(full, name, value, 0); err != nil {
		return err
	}
	state := model.getFileObject(rel)
	if state.Xattrs == nil {
		state.Xattrs = map[string][]byte{}
	}
	state.Xattrs[name] = append([]byte{}, value...)
	model.setFileObject(rel, state)
	return nil
}

func (r *scenarioRun) fuzzOpSymlink(rng *rand.Rand, model *fuzzModel, nameSeq *int, opIndex int) error {
	targetRel := pickRandomRegularFile(rng, model)
	if targetRel == "" {
		return errFuzzSkip
	}
	parent := pickRandomDir(rng, model)
	linkRel := joinRel(parent, fmt.Sprintf("link-%03d-%03d.lnk", opIndex, *nameSeq))
	*nameSeq = *nameSeq + 1
	linkDir := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(parent))
	target := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(targetRel))
	linkTarget, err := filepath.Rel(linkDir, target)
	if err != nil {
		return err
	}
	full := filepath.Join(r.mountDir, "fuzz", filepath.FromSlash(linkRel))
	if err := os.Symlink(linkTarget, full); err != nil {
		return err
	}
	model.symlinks[linkRel] = linkTarget
	return nil
}

func (r *scenarioRun) fuzzCheckpoint(model *fuzzModel, step int) error {
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if step%2 == 0 {
		if err := r.umountGraceful(); err != nil {
			return err
		}
	} else {
		if err := r.killMount(); err != nil {
			return err
		}
		if err := r.ensureUnmount(); err != nil {
			return err
		}
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := r.verifyFuzzModel(model); err != nil {
		r.manifest.FailureStep = step
		return fmt.Errorf("fuzz checkpoint %d: %w", step, err)
	}
	digest := model.digest()
	r.manifest.Checks = append(r.manifest.Checks, fmt.Sprintf("fuzz-checkpoint-%d", step))
	r.manifest.CheckpointDigests = append(r.manifest.CheckpointDigests, fmt.Sprintf("%d:%s", step, digest))
	r.manifest.LastCheckpoint = digest
	r.manifest.FinalDigest = digest
	return nil
}

func (r *scenarioRun) chaosCommitCheckpoint(model *fuzzModel, step int) error {
	if err := r.metaBarrier(); err != nil {
		return err
	}
	if err := r.umountGraceful(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := r.verifyFuzzModel(model); err != nil {
		r.manifest.FailureStep = step
		return fmt.Errorf("chaos commit checkpoint %d: %w", step, err)
	}
	digest := model.digest()
	r.manifest.CheckpointDigests = append(r.manifest.CheckpointDigests, fmt.Sprintf("%d:%s", step, digest))
	r.manifest.LastCheckpoint = digest
	r.manifest.FinalDigest = digest
	return nil
}

func (r *scenarioRun) chaosCrashRestore(durable *fuzzModel, step int) error {
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := r.verifyFuzzModel(durable); err != nil {
		r.manifest.FailureStep = step
		return fmt.Errorf("chaos crash restore %d: %w", step, err)
	}
	return nil
}

func (r *scenarioRun) periodicCommitProbe(live *fuzzModel, step int, settleDelay time.Duration) error {
	time.Sleep(settleDelay)
	if err := r.killMount(); err != nil {
		return err
	}
	if err := r.ensureUnmount(); err != nil {
		return err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return err
	}
	if err := r.mount(); err != nil {
		return err
	}
	if err := r.verifyFuzzModel(live); err != nil {
		r.manifest.FailureStep = step
		return fmt.Errorf("periodic commit probe %d: %w", step, err)
	}
	digest := live.digest()
	r.manifest.CheckpointDigests = append(r.manifest.CheckpointDigests, fmt.Sprintf("%d:%s", step, digest))
	r.manifest.LastCheckpoint = digest
	r.manifest.FinalDigest = digest
	return nil
}

func (r *scenarioRun) periodicCrashRestore(history []periodicSnapshot, step int) (*fuzzModel, int, string, error) {
	if err := r.killMount(); err != nil {
		return nil, 0, "", err
	}
	if err := r.ensureUnmount(); err != nil {
		return nil, 0, "", err
	}
	if err := r.removeLocalMetaArtifacts(); err != nil {
		return nil, 0, "", err
	}
	if err := r.mount(); err != nil {
		return nil, 0, "", err
	}
	for i := len(history) - 1; i >= 0; i-- {
		if err := r.verifyFuzzModel(history[i].model); err == nil {
			d := history[i].model.digest()
			return history[i].model, history[i].step, d, nil
		}
	}
	actualModel, actualErr := r.captureActualFuzzModel()
	actualDigest := ""
	if actualErr == nil {
		actualDigest = actualModel.digest()
	}
	r.manifest.FailureStep = step
	if actualErr != nil {
		return nil, 0, "", fmt.Errorf("periodic crash restore %d did not match any coherent prior snapshot; also failed to capture actual model: %w", step, actualErr)
	}
	return nil, 0, actualDigest, fmt.Errorf("periodic crash restore %d did not match any coherent prior snapshot (actual_digest=%s)", step, actualDigest)
}

func (r *scenarioRun) verifyFuzzModel(model *fuzzModel) error {
	root := filepath.Join(r.mountDir, "fuzz")
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return fmt.Errorf("missing fuzz root: %w", err)
	}
	actualDirs := map[string]struct{}{"": {}}
	actualFiles := make(map[string]struct{})
	actualSymlinks := make(map[string]struct{})
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			actualDirs[rel] = struct{}{}
		case mode&os.ModeSymlink != 0:
			actualSymlinks[rel] = struct{}{}
		case mode.IsRegular():
			actualFiles[rel] = struct{}{}
		default:
			return fmt.Errorf("unexpected entry mode for %s: %s", rel, mode.String())
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := compareStringSets("directories", modelDirSet(model), actualDirs); err != nil {
		return err
	}
	if err := compareStringSets("files", modelFileSet(model), actualFiles); err != nil {
		return err
	}
	if err := compareStringSets("symlinks", modelSymlinkSet(model), actualSymlinks); err != nil {
		return err
	}
	objectToInode := make(map[string]uint64)
	inodeToObject := make(map[uint64]string)
	for rel, objectID := range model.filePaths {
		state := model.fileObjects[objectID]
		full := filepath.Join(root, filepath.FromSlash(rel))
		var st unix.Stat_t
		if err := unix.Lstat(full, &st); err != nil {
			return fmt.Errorf("lstat %s: %w", rel, err)
		}
		if prev, ok := objectToInode[objectID]; ok && prev != st.Ino {
			return fmt.Errorf("hardlink inode mismatch for object %s via %s: got inode=%d want inode=%d", objectID, rel, st.Ino, prev)
		}
		if prev, ok := inodeToObject[st.Ino]; ok && prev != objectID {
			return fmt.Errorf("unexpected shared inode %d between objects %s and %s", st.Ino, prev, objectID)
		}
		objectToInode[objectID] = st.Ino
		inodeToObject[st.Ino] = objectID
		got, err := os.ReadFile(full)
		if err != nil {
			return fmt.Errorf("read %s: %w", rel, err)
		}
		if len(got) != len(state.Content) {
			return fmt.Errorf("content length mismatch for %s: got=%d want=%d got_sha=%s want_sha=%s", rel, len(got), len(state.Content), contentSHA256(got), contentSHA256(state.Content))
		}
		if gotHash, wantHash := contentSHA256(got), contentSHA256(state.Content); gotHash != wantHash {
			return fmt.Errorf("content hash mismatch for %s: got_sha=%s want_sha=%s", rel, gotHash, wantHash)
		}
		for name, expected := range state.Xattrs {
			got, err := getXattr(full, name)
			if err != nil {
				return fmt.Errorf("xattr %s on %s: %w", name, rel, err)
			}
			if !bytes.Equal(got, expected) {
				return fmt.Errorf("xattr mismatch for %s on %s", name, rel)
			}
		}
	}
	for rel, expected := range model.symlinks {
		full := filepath.Join(root, filepath.FromSlash(rel))
		got, err := os.Readlink(full)
		if err != nil {
			return fmt.Errorf("readlink %s: %w", rel, err)
		}
		if got != expected {
			return fmt.Errorf("symlink mismatch for %s: got %q want %q", rel, got, expected)
		}
	}
	return nil
}

func (r *scenarioRun) captureActualFuzzModel() (*fuzzModel, error) {
	root := filepath.Join(r.mountDir, "fuzz")
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("missing fuzz root: %w", err)
	}
	model := newFuzzModel()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			model.addDir(rel)
		case mode&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			model.symlinks[rel] = target
		case mode.IsRegular():
			var st unix.Stat_t
			if err := unix.Lstat(path, &st); err != nil {
				return err
			}
			objectID := fmt.Sprintf("ino-%d", st.Ino)
			model.filePaths[rel] = objectID
			if _, ok := model.fileObjects[objectID]; !ok {
				content, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				xattrs, err := listXattrs(path)
				if err != nil {
					return err
				}
				model.fileObjects[objectID] = fuzzFileObject{Content: content, Xattrs: xattrs}
			}
		default:
			return fmt.Errorf("unexpected entry mode for %s: %s", rel, mode.String())
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return model, nil
}

func (r *scenarioRun) fuzzRemovableEntries(model *fuzzModel) []string {
	var out []string
	for rel := range model.filePaths {
		if strings.HasPrefix(rel, "large/") {
			continue
		}
		out = append(out, rel)
	}
	for rel := range model.symlinks {
		out = append(out, rel)
	}
	for rel := range model.dirs {
		if rel == "" {
			continue
		}
		if isStructuredFuzzPath(rel) {
			continue
		}
		if !modelHasChildren(model, rel) {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	return out
}

func modelHasChildren(model *fuzzModel, dir string) bool {
	prefix := dir + "/"
	for rel := range model.dirs {
		if rel != dir && strings.HasPrefix(rel, prefix) {
			return true
		}
	}
	for rel := range model.filePaths {
		if strings.HasPrefix(rel, prefix) {
			return true
		}
	}
	for rel := range model.symlinks {
		if strings.HasPrefix(rel, prefix) {
			return true
		}
	}
	return false
}

func modelDirSet(model *fuzzModel) map[string]struct{} {
	out := make(map[string]struct{}, len(model.dirs))
	for rel := range model.dirs {
		out[rel] = struct{}{}
	}
	return out
}

func modelFileSet(model *fuzzModel) map[string]struct{} {
	out := make(map[string]struct{}, len(model.filePaths))
	for rel := range model.filePaths {
		out[rel] = struct{}{}
	}
	return out
}

func modelSymlinkSet(model *fuzzModel) map[string]struct{} {
	out := make(map[string]struct{}, len(model.symlinks))
	for rel := range model.symlinks {
		out[rel] = struct{}{}
	}
	return out
}

func compareStringSets(name string, expected, actual map[string]struct{}) error {
	for key := range expected {
		if _, ok := actual[key]; !ok {
			return fmt.Errorf("missing %s entry %q", name, key)
		}
	}
	for key := range actual {
		if _, ok := expected[key]; !ok {
			return fmt.Errorf("unexpected %s entry %q", name, key)
		}
	}
	return nil
}

func pickRandomDir(rng *rand.Rand, model *fuzzModel) string {
	dirs := make([]string, 0, len(model.dirs))
	for rel := range model.dirs {
		if rel != "" && isStructuredFuzzPath(rel) {
			continue
		}
		dirs = append(dirs, rel)
	}
	sort.Strings(dirs)
	return dirs[rng.Intn(len(dirs))]
}

func pickRandomRegularFile(rng *rand.Rand, model *fuzzModel) string {
	var files []string
	for rel := range model.filePaths {
		if isStructuredFuzzPath(rel) {
			continue
		}
		files = append(files, rel)
	}
	if len(files) == 0 {
		return ""
	}
	sort.Strings(files)
	return files[rng.Intn(len(files))]
}

func pickRandomNonRootDir(rng *rand.Rand, model *fuzzModel) string {
	var dirs []string
	for rel := range model.dirs {
		if rel == "" || isStructuredFuzzPath(rel) {
			continue
		}
		dirs = append(dirs, rel)
	}
	if len(dirs) == 0 {
		return ""
	}
	sort.Strings(dirs)
	return dirs[rng.Intn(len(dirs))]
}

func isStructuredFuzzPath(rel string) bool {
	return rel == "links" || rel == "matrix" || rel == "large" ||
		strings.HasPrefix(rel, "links/") ||
		strings.HasPrefix(rel, "matrix/") ||
		strings.HasPrefix(rel, "large/")
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func listDirNames(path string) []string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func joinRel(parts ...string) string {
	var filtered []string
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	return filepath.ToSlash(filepath.Join(filtered...))
}

func pathDirRel(rel string) string {
	dir := filepath.Dir(filepath.FromSlash(rel))
	if dir == "." {
		return ""
	}
	return filepath.ToSlash(dir)
}

func largeFilePath(idx int) string {
	return joinRel("large", fmt.Sprintf("large-%02d.bin", idx))
}

func cloneXattrs(in map[string][]byte) map[string][]byte {
	out := map[string][]byte{}
	for key, value := range in {
		out[key] = append([]byte{}, value...)
	}
	return out
}

func (m *fuzzModel) getFileObject(rel string) fuzzFileObject {
	return m.fileObjects[m.filePaths[rel]]
}

func (m *fuzzModel) setFileObject(rel string, state fuzzFileObject) {
	objectID := m.filePaths[rel]
	m.fileObjects[objectID] = state
}

func (m *fuzzModel) removeFilePath(rel string) {
	objectID, ok := m.filePaths[rel]
	if !ok {
		return
	}
	delete(m.filePaths, rel)
	for _, other := range m.filePaths {
		if other == objectID {
			return
		}
	}
	delete(m.fileObjects, objectID)
}

func (m *fuzzModel) renameDirTree(oldPrefix, newPrefix string) {
	nextDirs := make(map[string]struct{}, len(m.dirs))
	for rel := range m.dirs {
		nextDirs[replaceRelPrefix(rel, oldPrefix, newPrefix)] = struct{}{}
	}
	nextFiles := make(map[string]string, len(m.filePaths))
	for rel, objectID := range m.filePaths {
		nextFiles[replaceRelPrefix(rel, oldPrefix, newPrefix)] = objectID
	}
	nextSymlinks := make(map[string]string, len(m.symlinks))
	for rel, target := range m.symlinks {
		nextSymlinks[replaceRelPrefix(rel, oldPrefix, newPrefix)] = target
	}
	m.dirs = nextDirs
	m.filePaths = nextFiles
	m.symlinks = nextSymlinks
}

func (m *fuzzModel) digest() string {
	var parts []string
	for _, rel := range sortedKeys(m.dirs) {
		parts = append(parts, "dir:"+rel)
	}
	for _, rel := range sortedKeys(m.filePaths) {
		objectID := m.filePaths[rel]
		parts = append(parts, "path:"+rel+"="+objectID)
	}
	objectIDs := make([]string, 0, len(m.fileObjects))
	for objectID := range m.fileObjects {
		objectIDs = append(objectIDs, objectID)
	}
	sort.Strings(objectIDs)
	for _, objectID := range objectIDs {
		state := m.fileObjects[objectID]
		parts = append(parts, "obj:"+objectID+":"+fmt.Sprintf("%d", len(state.Content))+":"+contentSHA256(state.Content))
		xattrs := make([]string, 0, len(state.Xattrs))
		for name, value := range state.Xattrs {
			xattrs = append(xattrs, name+"="+contentSHA256(value))
		}
		sort.Strings(xattrs)
		parts = append(parts, xattrs...)
	}
	for _, rel := range sortedKeys(m.symlinks) {
		parts = append(parts, "symlink:"+rel+"->"+m.symlinks[rel])
	}
	return contentSHA256([]byte(strings.Join(parts, "\n")))
}

func (m *fuzzModel) clone() *fuzzModel {
	out := &fuzzModel{
		dirs:         make(map[string]struct{}, len(m.dirs)),
		filePaths:    make(map[string]string, len(m.filePaths)),
		fileObjects:  make(map[string]fuzzFileObject, len(m.fileObjects)),
		symlinks:     make(map[string]string, len(m.symlinks)),
		nextObjectID: m.nextObjectID,
	}
	for rel := range m.dirs {
		out.dirs[rel] = struct{}{}
	}
	for rel, objectID := range m.filePaths {
		out.filePaths[rel] = objectID
	}
	for objectID, state := range m.fileObjects {
		out.fileObjects[objectID] = fuzzFileObject{
			Content: append([]byte{}, state.Content...),
			Xattrs:  cloneXattrs(state.Xattrs),
		}
	}
	for rel, target := range m.symlinks {
		out.symlinks[rel] = target
	}
	return out
}

func (m *fuzzModel) diff(other *fuzzModel) string {
	if m.digest() == other.digest() {
		return ""
	}
	return fmt.Sprintf("before=%s after=%s", m.digest(), other.digest())
}

func (m *fuzzModel) fileState(rel string) (fuzzFileObject, error) {
	objectID, ok := m.filePaths[rel]
	if !ok {
		return fuzzFileObject{}, fmt.Errorf("missing file path %q", rel)
	}
	state, ok := m.fileObjects[objectID]
	if !ok {
		return fuzzFileObject{}, fmt.Errorf("missing file object %q for %q", objectID, rel)
	}
	return fuzzFileObject{
		Content: append([]byte{}, state.Content...),
		Xattrs:  cloneXattrs(state.Xattrs),
	}, nil
}

func (m *fuzzModel) addDir(rel string) {
	if rel == "" {
		m.dirs[""] = struct{}{}
		return
	}
	parts := strings.Split(rel, "/")
	cur := ""
	for _, part := range parts {
		cur = joinRel(cur, part)
		m.dirs[cur] = struct{}{}
	}
}

func (m *fuzzModel) createFile(rel string, content []byte) string {
	objectID := fmt.Sprintf("obj-%06d", m.nextObjectID)
	m.nextObjectID++
	m.filePaths[rel] = objectID
	m.fileObjects[objectID] = fuzzFileObject{
		Content: append([]byte{}, content...),
		Xattrs:  map[string][]byte{},
	}
	return objectID
}

func (m *fuzzModel) setFileState(rel string, state fuzzFileObject) error {
	objectID, ok := m.filePaths[rel]
	if !ok {
		return fmt.Errorf("missing file path %q", rel)
	}
	m.fileObjects[objectID] = fuzzFileObject{
		Content: append([]byte{}, state.Content...),
		Xattrs:  cloneXattrs(state.Xattrs),
	}
	return nil
}

func (m *fuzzModel) renameFile(oldRel, newRel string) error {
	objectID, ok := m.filePaths[oldRel]
	if !ok {
		return fmt.Errorf("missing file path %q", oldRel)
	}
	delete(m.filePaths, oldRel)
	m.filePaths[newRel] = objectID
	return nil
}

func sortedKeys[T any](in map[string]T) []string {
	out := make([]string, 0, len(in))
	for key := range in {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func periodicHistoryDigests(history []periodicSnapshot) []string {
	out := make([]string, 0, len(history))
	for _, snap := range history {
		out = append(out, fmt.Sprintf("%d:%s", snap.step, snap.model.digest()))
	}
	return out
}

func replaceRelPrefix(rel, oldPrefix, newPrefix string) string {
	if rel == oldPrefix {
		return newPrefix
	}
	prefix := oldPrefix + "/"
	if strings.HasPrefix(rel, prefix) {
		return newPrefix + "/" + strings.TrimPrefix(rel, prefix)
	}
	return rel
}

func isAncestor(parent, child string) bool {
	if parent == "" || child == "" || parent == child {
		return false
	}
	return strings.HasPrefix(child, parent+"/")
}

func fuzzPayload(rng *rand.Rand, opIndex, n int) []byte {
	if n < 1 {
		n = 1
	}
	buf := make([]byte, n)
	prefix := []byte(fmt.Sprintf("op=%03d|", opIndex))
	copy(buf, prefix)
	for i := len(prefix); i < len(buf); i++ {
		buf[i] = byte(rng.Intn(256))
	}
	return buf
}

func applyWriteAt(base []byte, offset int, payload []byte) []byte {
	if offset < 0 {
		offset = 0
	}
	outLen := len(base)
	if needed := offset + len(payload); needed > outLen {
		outLen = needed
	}
	out := make([]byte, outLen)
	copy(out, base)
	copy(out[offset:], payload)
	return out
}

func applyTruncate(base []byte, size int) []byte {
	if size < 0 {
		size = 0
	}
	out := make([]byte, size)
	copy(out, base)
	return out
}

func contentSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:])
}

// Go's os.Rename rejects an existing directory target in user space before it
// reaches the filesystem. For harness validation we need the filesystem's
// actual rename semantics, so use the syscall directly.
func renamePath(oldPath, newPath string) error {
	if err := syscall.Rename(oldPath, newPath); err != nil {
		return &os.LinkError{Op: "rename", Old: oldPath, New: newPath, Err: err}
	}
	return nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (r *scenarioRun) runSoakRound(round int, deadline time.Time) error {
	root := filepath.Join(r.mountDir, fmt.Sprintf("soak-%03d", round))
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}

	iteration := 0
	for time.Now().Before(deadline) {
		iterDir := filepath.Join(root, fmt.Sprintf("iter-%03d", iteration))
		if err := os.MkdirAll(iterDir, 0o755); err != nil {
			return err
		}

		for i := 0; i < 20; i++ {
			p := filepath.Join(iterDir, fmt.Sprintf("file-%02d.txt", i))
			payload := []byte(fmt.Sprintf("round-%03d iter-%03d file-%02d %d", round, iteration, i, time.Now().UnixNano()))
			if err := os.WriteFile(p, payload, 0o644); err != nil {
				return err
			}
			if got, err := os.ReadFile(p); err != nil || !bytes.Equal(got, payload) {
				return fmt.Errorf("verify soak file %s: %w", p, err)
			}
			if i%3 == 0 {
				renamed := filepath.Join(iterDir, fmt.Sprintf("renamed-%02d.txt", i))
				if err := renamePath(p, renamed); err != nil {
					return err
				}
				p = renamed
			}
			if i%4 == 0 {
				link := filepath.Join(iterDir, fmt.Sprintf("link-%02d.txt", i))
				if err := os.Symlink(filepath.Base(p), link); err != nil && !errors.Is(err, os.ErrExist) {
					return err
				}
			}
		}

		if iteration > 0 {
			oldDir := filepath.Join(root, fmt.Sprintf("iter-%03d", iteration-1))
			_ = os.RemoveAll(oldDir)
		}

		time.Sleep(10 * time.Second)
		iteration++
	}

	return nil
}

func (r *scenarioRun) format() error {
	if r.cfg.Workspace != "" {
		if _, err := os.Stat(r.formatSentinelPath()); err == nil {
			r.manifest.Checks = append(r.manifest.Checks, "format skipped (reused workspace)")
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	workspace := r.workspaceName()
	args := []string{
		"sformat",
		"--meta-base", filepath.Dir(r.metaDir),
		"--workspace-prefix", harnessWorkspacePrefix,
		"--sync-interval", r.currentSyncInterval(),
		"--barrier-timeout", "60s",
		"--runtime-maintenance", r.cfg.RuntimeMaintenance,
		"--snapshot-interval", r.cfg.SnapshotInterval,
		workspace,
	}
	_, err := r.runCommand("format", filepath.Join(r.logDir, "format.log"), args...)
	if err != nil {
		return err
	}
	if r.cfg.Workspace != "" {
		if err := os.WriteFile(r.formatSentinelPath(), []byte(time.Now().Format(time.RFC3339Nano)), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (r *scenarioRun) mount() error {
	if r.mountCmd != nil {
		return nil
	}
	r.mountCount++
	logPath := filepath.Join(r.logDir, fmt.Sprintf("mount-%02d.log", r.mountCount))
	r.mountLogPath = logPath
	workspace := r.workspaceName()
	cmd, logFile, err := r.startCommand("mount", logPath,
		"smount",
		"--mountpoint", r.mountDir,
		"--meta-base", filepath.Dir(r.metaDir),
		"--workspace-prefix", harnessWorkspacePrefix,
		"--sync-interval", r.currentSyncInterval(),
		"--barrier-timeout", "60s",
		"--runtime-maintenance", r.cfg.RuntimeMaintenance,
		"--snapshot-interval", r.cfg.SnapshotInterval,
		"--enable-xattr",
		"--attr-cache", "0",
		"--entry-cache", "0",
		"--dir-entry-cache", "0",
		"--cache-dir", "memory",
		"--no-usage-report",
		"--log", logPath,
		workspace,
	)
	if err != nil {
		return err
	}
	r.mountCmd = cmd
	r.mountLogFile = logFile
	done := make(chan error, 1)
	r.mountWaitDone = done
	go func() {
		done <- cmd.Wait()
	}()
	readyStarted := time.Now()
	deadline := time.Now().Add(r.cfg.MountReadyTimeout)
	for {
		select {
		case err := <-r.mountWaitDone:
			if r.mountLogFile != nil {
				_ = r.mountLogFile.Close()
			}
			r.mountCmd = nil
			r.mountLogFile = nil
			r.mountWaitDone = nil
			if err != nil {
				return fmt.Errorf("mount exited early: %w; see %s", err, logPath)
			}
			return fmt.Errorf("mount exited early; see %s", logPath)
		default:
		}
		if inode, err := utils.GetFileInode(r.mountDir); err == nil && inode == 1 {
			r.manifest.MountReadyAt = time.Now()
			r.manifest.MountReadyDuration = r.manifest.MountReadyAt.Sub(readyStarted)
			return nil
		}
		if time.Now().After(deadline) {
			_ = r.killMount()
			return fmt.Errorf("mount did not become ready within %s; see %s", r.cfg.MountReadyTimeout, logPath)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (r *scenarioRun) workspaceName() string {
	return r.volume
}

func (r *scenarioRun) currentSyncInterval() string {
	if strings.TrimSpace(r.syncIntervalOverride) != "" {
		return r.syncIntervalOverride
	}
	if r.name == "crash_before_barrier" {
		return "30s"
	}
	return "3s"
}

func (r *scenarioRun) umountGraceful() error {
	if r.mountCmd == nil {
		return nil
	}
	_, err := r.runCommand("umount", filepath.Join(r.logDir, "umount.log"), "umount", r.mountDir)
	waitErr := r.waitMountExit(30 * time.Second)
	r.mountCmd = nil
	r.mountLogFile = nil
	if err != nil {
		return err
	}
	return waitErr
}

func (r *scenarioRun) killMount() error {
	if r.mountCmd == nil || r.mountCmd.Process == nil {
		return nil
	}
	if err := r.mountCmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return r.waitMountExit(10 * time.Second)
}

func (r *scenarioRun) waitMountExit(timeout time.Duration) error {
	if r.mountCmd == nil {
		return nil
	}
	done := r.mountWaitDone
	if done == nil {
		return nil
	}
	select {
	case err := <-done:
		if r.mountLogFile != nil {
			_ = r.mountLogFile.Close()
		}
		r.mountWaitDone = nil
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				return nil
			}
		}
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("mount process did not exit within %s", timeout)
	}
}

func (r *scenarioRun) ensureUnmount() error {
	if r.mountCmd == nil {
		return nil
	}
	_ = r.killMount()
	commands := [][]string{
		{"umount", r.mountDir},
		{"fusermount", "-uz", r.mountDir},
		{"fusermount3", "-uz", r.mountDir},
		{"umount", "-lf", r.mountDir},
	}
	for _, argv := range commands {
		_ = exec.Command(argv[0], argv[1:]...).Run()
	}
	if r.mountLogFile != nil {
		_ = r.mountLogFile.Close()
	}
	r.mountCmd = nil
	r.mountLogFile = nil
	return nil
}

func (r *scenarioRun) metaBarrier() error {
	if err := syncMount(r.mountDir); err != nil {
		return err
	}
	_, err := r.runCommand("meta-barrier", filepath.Join(r.logDir, fmt.Sprintf("barrier-%d.log", time.Now().UnixNano())),
		"meta-barrier", r.mountDir,
	)
	return err
}

func (r *scenarioRun) fileBarrier(path string) error {
	if err := syncMount(r.mountDir); err != nil {
		return err
	}
	_, err := r.runCommand("file-barrier", filepath.Join(r.logDir, fmt.Sprintf("file-barrier-%d.log", time.Now().UnixNano())),
		"file-barrier", path,
	)
	return err
}

func syncMount(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := unix.Syncfs(int(f.Fd())); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// The harness tests crash recovery cuts. A system sync matches the manual
	// operator path and prevents kernel/FUSE writeback from hiding fresh SQLite
	// pages from the Litestream VFS before a checkpoint cut.
	unix.Sync()
	return nil
}

func (r *scenarioRun) removeLocalMetaArtifacts() error {
	if err := os.Remove(r.metaDBPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.RemoveAll(filepath.Join(r.metaDir, ".litestream"))
}

func (r *scenarioRun) runCommand(name, logPath string, args ...string) (commandResult, error) {
	cmd, logFile, err := r.startCommand(name, logPath, args...)
	if err != nil {
		return commandResult{}, err
	}
	err = cmd.Wait()
	_ = logFile.Close()
	result := r.manifest.Commands[len(r.manifest.Commands)-1]
	result.Finished = time.Now()
	result.Duration = result.Finished.Sub(result.StartedAt)
	if err == nil {
		result.ExitCode = 0
		r.manifest.Commands[len(r.manifest.Commands)-1] = result
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		r.manifest.Commands[len(r.manifest.Commands)-1] = result
		return result, fmt.Errorf("%s %v failed with exit code %d; see %s", r.cfg.JuiceFSBin, args, result.ExitCode, logPath)
	}
	result.ExitCode = -1
	r.manifest.Commands[len(r.manifest.Commands)-1] = result
	return result, err
}

func (r *scenarioRun) startCommand(name, logPath string, args ...string) (*exec.Cmd, *os.File, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, nil, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.Command(r.cfg.JuiceFSBin, args...)
	cmd.Env = r.childEnv()
	if len(args) > 0 && args[0] == "mount" {
		cmd.Env = append(cmd.Env, "JFS_SUPERVISOR=test")
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	started := time.Now()
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, nil, err
	}
	r.manifest.Commands = append(r.manifest.Commands, commandResult{
		Name:      name,
		Args:      redactArgs(args),
		StartedAt: started,
		LogPath:   logPath,
	})
	return cmd, logFile, nil
}

func (r *scenarioRun) childEnv() []string {
	env := os.Environ()
	env = append(env,
		"REMOTE_BACKEND="+r.cfg.RemoteBackend,
		"COS_SECRETID="+r.cfg.SecretID,
		"COS_SECRETKEY="+r.cfg.SecretKey,
		"TENCENTCLOUD_SECRET_ID="+r.cfg.SecretID,
		"TENCENTCLOUD_SECRET_KEY="+r.cfg.SecretKey,
		"COS_BUCKET="+r.cfg.COSBucket,
		"COS_REGION="+r.cfg.COSRegion,
		"COS_ENDPOINT="+r.cfg.COSEndpoint,
		"SMH_ACCESS_DOMAIN="+r.cfg.SMHAccessDomain,
		"SMH_LIBRARY_ID="+r.cfg.SMHLibraryID,
		"SMH_SPACE_ID="+r.cfg.SMHSpaceID,
		"SMH_ACCESS_TOKEN="+r.cfg.SMHAccessToken,
		"SMH_PERMANENT_DELETE="+r.cfg.SMHPermanentDelete,
		fmt.Sprintf("JFS_MOUNT_TIMEOUT=%d", int(r.cfg.MountReadyTimeout.Seconds())),
	)
	return env
}

func (r *scenarioRun) cleanupRemote() error {
	store, err := r.remoteStorage()
	if err != nil {
		return err
	}
	defer object.Shutdown(store)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, prefix := range r.manifest.COSPrefixes {
		ch, err := object.ListAll(ctx, store, prefix, "", true, true)
		if err != nil {
			return err
		}
		var keys []string
		for obj := range ch {
			if obj == nil {
				break
			}
			keys = append(keys, obj.Key())
		}
		for i := len(keys) - 1; i >= 0; i-- {
			if err := store.Delete(ctx, keys[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *scenarioRun) remoteStorage() (object.ObjectStorage, error) {
	switch r.cfg.RemoteBackend {
	case "smh":
		endpoint, err := normalizedURLWithScheme(r.cfg.SMHAccessDomain)
		if err != nil {
			return nil, err
		}
		q := endpoint.Query()
		q.Set("library_id", r.cfg.SMHLibraryID)
		q.Set("space_id", r.cfg.SMHSpaceID)
		if r.cfg.SMHPermanentDelete != "" {
			q.Set("permanent", r.cfg.SMHPermanentDelete)
		}
		endpoint.RawQuery = q.Encode()
		return object.CreateStorage("smh", endpoint.String(), r.cfg.SMHAccessToken, "", "")
	default:
		return object.CreateStorage("s3", fmt.Sprintf("https://%s.cos.%s.myqcloud.com?force-path-style=false", r.cfg.COSBucket, r.cfg.COSRegion), r.cfg.SecretID, r.cfg.SecretKey, "")
	}
}

func getXattr(path, name string) ([]byte, error) {
	size, err := unix.Getxattr(path, name, nil)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, size)
	_, err = unix.Getxattr(path, name, buf)
	return buf, err
}

func writeJSONFile(path string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func listXattrs(path string) (map[string][]byte, error) {
	size, err := unix.Listxattr(path, nil)
	if err != nil {
		if errors.Is(err, unix.ENODATA) {
			return map[string][]byte{}, nil
		}
		return nil, err
	}
	if size == 0 {
		return map[string][]byte{}, nil
	}
	buf := make([]byte, size)
	n, err := unix.Listxattr(path, buf)
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	start := 0
	for i := 0; i < n; i++ {
		if buf[i] != 0 {
			continue
		}
		name := string(buf[start:i])
		start = i + 1
		value, err := getXattr(path, name)
		if err != nil {
			return nil, err
		}
		out[name] = value
	}
	return out, nil
}

func verifyFileContent(path, want string) error {
	got, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(got) != want {
		return fmt.Errorf("got %q want %q", string(got), want)
	}
	return nil
}

func verifyXattrValue(path, name, want string) error {
	got, err := getXattr(path, name)
	if err != nil {
		return err
	}
	if string(got) != want {
		return fmt.Errorf("got %q want %q", string(got), want)
	}
	return nil
}

func verifyMissingXattr(path, name string) error {
	_, err := getXattr(path, name)
	if err == nil {
		return fmt.Errorf("xattr %s unexpectedly present", name)
	}
	if errors.Is(err, unix.ENODATA) {
		return nil
	}
	return err
}

func verifySymlinkTarget(path, want string) error {
	got, err := os.Readlink(path)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("got %q want %q", got, want)
	}
	return nil
}

func verifySameInode(left, right string) error {
	var ls, rs unix.Stat_t
	if err := unix.Lstat(left, &ls); err != nil {
		return err
	}
	if err := unix.Lstat(right, &rs); err != nil {
		return err
	}
	if ls.Ino != rs.Ino {
		return fmt.Errorf("inode mismatch %d vs %d", ls.Ino, rs.Ino)
	}
	return nil
}

func (r *scenarioRun) createFileSizeLimitedWrapper(limitKB int) (string, error) {
	if limitKB <= 0 {
		return "", fmt.Errorf("limitKB must be > 0")
	}
	path := filepath.Join(r.runDir, "juicefs-filelimit-wrapper.sh")
	content := fmt.Sprintf("#!/usr/bin/env bash\nulimit -f %d\nexec %q \"$@\"\n", limitKB, r.cfg.JuiceFSBin)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func redactArgs(args []string) []string {
	out := make([]string, len(args))
	copy(out, args)
	for i, arg := range out {
		if strings.Contains(strings.ToLower(arg), "secret") || strings.Contains(strings.ToLower(arg), "access-key") {
			out[i] = "REDACTED"
		}
	}
	return out
}

func bucketURL(bucket, region string) string {
	if strings.HasPrefix(bucket, "http://") || strings.HasPrefix(bucket, "https://") {
		return bucket
	}
	return fmt.Sprintf("https://%s.cos.%s.myqcloud.com", bucket, region)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func boolEnv(key string, defaultV bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return defaultV
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "y":
		return true
	case "0", "false", "no", "n":
		return false
	default:
		return defaultV
	}
}

func durationEnv(key string, defaultV time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return defaultV
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return defaultV
	}
	return d
}

func intEnv(key string, defaultV int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultV
	}
	var out int
	if _, err := fmt.Sscanf(v, "%d", &out); err != nil {
		return defaultV
	}
	return out
}

func int64Env(key string, defaultV int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return defaultV
	}
	var out int64
	if _, err := fmt.Sscanf(v, "%d", &out); err != nil {
		return defaultV
	}
	return out
}
