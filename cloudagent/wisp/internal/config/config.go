package config

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	jsonnet "github.com/google/go-jsonnet"
)

type Config struct {
	ConfigFile        string
	OverlayConfigFile string

	WispName            string
	RemoteBackend       string
	JFSRoot             string
	COSEnabled          bool
	COSBucket           string
	COSRegion           string
	COSEndpoint         string
	COSTencentSecretID  string
	COSTencentSecretKey string
	COSWorkspace        string
	JFSLocalRoot        string
	JFSPrefix           string
	JFSBin              string
	JFSBuild            string
	JuiceFSRepoRoot     string
	JFSSMountScript     string
	JFSSFormatScript    string
	JFSMetaURL          string
	JFSBucketURL        string
	SMHEnabled          bool
	SMHLibraryID        string
	SMHAccessDomain     string
	SMHLibrarySecret    string
	SMHAccessToken      string
	SMHSpaceID          string
	SMHTokenTTLSeconds  int
	StateRoot           string
	ActiveRoot          string
	ActiveImg           string

	CheckpointsRoot string
	PolicyRoot      string
	LowerRoot       string
	LowerLanguages  string
	LowerSystem     string
	LowerSystemBase string

	RuntimeRoot       string
	RootFSMount       string
	UpperImageMount   string
	ActiveViewMount   string
	LoopDeviceFile    string
	PIDFile           string
	AdminRoot         string
	AdminSocketPath   string
	AdminListenAddr   string
	DaemonLockFile    string
	EnvSocketPath     string
	EnvSocketHostPath string
	CrunStateRoot     string
	CrunBundleRoot    string
	CrunBundleRootFS  string
	CrunBinaryPath    string
	LegacyRuntimeRoot string
	ContainerID       string

	CgroupRoot          string
	CgroupParent        string
	CgroupUserParent    string
	CgroupRuntimeParent string
	CgroupUserContainer string

	TempRoot   string
	TmpRoot    string
	DockerRoot string
	LogRoot    string

	RootUpperSize        string
	DefaultRootUpperSize string
	BlankRootUpperSparse string
	BlankRootUpperImage  string
	BlankRootUpperTar    string
	WispUser             string
	WispUID              int
	WispGID              int
	ShellPath            string

	CrunBinary        string
	WispEnvBinary     string
	WispFSAgentBinary string
	TiniBinary        string
	TiniVersion       string

	WispPath           string
	WispLang           string
	WispBrowser        string
	WispDebianFrontend string
	ResolvNameservers  string

	MemoryReserveMB     int64
	UserMemoryMaxBytes  string
	UserMemoryHighBytes string
	MemoryHighPercent   int64

	CPUReserveMillicores int64
	UserCPUMaxMillicores string
	CPUPeriodUS          int64

	TotalPIDsBudget    string
	RuntimePIDsReserve int64
	UserPIDsMax        string

	BaseRootFSDir   string
	BaseRootFSImage string
}

func (c Config) GetTempRoot() string {
	return c.TempRoot
}

func (c Config) GetRuntimeRoot() string {
	return c.RuntimeRoot
}

func (c Config) GetAdminRoot() string {
	return c.AdminRoot
}

func Load(path string) (Config, error) {
	overlayPath, err := DefaultOverlayPath(path)
	if err != nil {
		return Config{}, err
	}
	return loadWithOverlay(path, overlayPath)
}

func LoadContainer(path, name string) (Config, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Load(path)
	}
	overlayPath := ContainerOverlayPath(path, name)
	if _, err := os.Stat(overlayPath); err != nil {
		if os.IsNotExist(err) {
			return Config{}, fmt.Errorf("container %s not found", name)
		}
		return Config{}, fmt.Errorf("stat container overlay %s: %w", overlayPath, err)
	}
	return loadWithOverlay(path, overlayPath)
}

func loadWithOverlay(path, overlayPath string) (Config, error) {
	baseEnv, err := parseJSONNetFile(path)
	if err != nil {
		return Config{}, err
	}
	overlayEnv, err := parseOptionalJSONNetFile(overlayPath)
	if err != nil {
		return Config{}, err
	}

	fileEnv := mergeConfigMaps(baseEnv, overlayEnv)
	env := mergeEnv(fileEnv, os.Environ())

	cfg := Config{
		ConfigFile:        path,
		OverlayConfigFile: overlayPath,
	}
	cfg.WispName = get(env, "WISP_NAME", "default")
	cfg.RemoteBackend = normalizeRemoteBackend(get(env, "REMOTE_BACKEND", "cos"))
	cfg.JFSRoot = get(env, "JFS_ROOT", "/jfs")
	cfg.COSEnabled = getBool(env, "COS_ENABLED", false)
	cfg.COSBucket = get(env, "COS_BUCKET", "")
	cfg.COSRegion = get(env, "COS_REGION", "")
	cfg.COSEndpoint = get(env, "COS_ENDPOINT", "")
	cfg.COSTencentSecretID = get(env, "TENCENTCLOUD_SECRET_ID", "")
	cfg.COSTencentSecretKey = get(env, "TENCENTCLOUD_SECRET_KEY", "")
	cfg.COSWorkspace = get(env, "COS_WORKSPACE", cfg.WispName)
	cfg.JFSLocalRoot = get(env, "JFS_LOCAL_ROOT", "")
	cfg.JFSPrefix = get(env, "JFS_PREFIX", "workspace")
	cfg.JFSBin = get(env, "JFS_BIN", "")
	cfg.JFSBuild = get(env, "JFS_BUILD", "")
	cfg.JuiceFSRepoRoot = get(env, "JUICEFS_REPO_ROOT", "")
	cfg.JFSSMountScript = get(env, "JFS_SMOUNT_SCRIPT", "")
	cfg.JFSSFormatScript = get(env, "JFS_SFORMAT_SCRIPT", "")
	cfg.JFSMetaURL = get(env, "JFS_META_URL", "")
	cfg.JFSBucketURL = get(env, "JFS_BUCKET_URL", "")
	cfg.SMHEnabled = getBool(env, "SMH_ENABLED", cfg.RemoteBackend == "smh")
	cfg.SMHLibraryID = get(env, "SMH_LIBRARY_ID", "")
	cfg.SMHAccessDomain = get(env, "SMH_ACCESS_DOMAIN", "")
	cfg.SMHLibrarySecret = get(env, "SMH_LIBRARY_SECRET", "")
	cfg.SMHAccessToken = get(env, "SMH_ACCESS_TOKEN", "")
	cfg.SMHSpaceID = get(env, "SMH_SPACE_ID", "")
	cfg.SMHTokenTTLSeconds = getInt(env, "SMH_TOKEN_TTL_SECONDS", 86400)
	cfg.TempRoot = get(env, "TEMP_ROOT", filepath.Join("/var/lib/wisp", cfg.WispName))
	sharedRoot := filepath.Join(filepath.Dir(cfg.TempRoot), "shared")
	cfg.TmpRoot = get(env, "TMP_ROOT", filepath.Join(cfg.TempRoot, "tmp"))
	cfg.DockerRoot = get(env, "DOCKER_ROOT", filepath.Join(cfg.TempRoot, "var-lib-docker"))
	cfg.LogRoot = get(env, "LOG_ROOT", filepath.Join(cfg.TempRoot, "logs"))
	cfg.StateRoot = get(env, "STATE_ROOT", filepath.Join(cfg.JFSRoot, "wisp", cfg.WispName))
	cfg.ActiveRoot = get(env, "ACTIVE_ROOT", filepath.Join(cfg.StateRoot, "active"))
	cfg.ActiveImg = get(env, "ACTIVE_IMG", filepath.Join(cfg.ActiveRoot, "root-upper.img"))
	cfg.CheckpointsRoot = get(env, "CHECKPOINTS_ROOT", filepath.Join(cfg.StateRoot, "checkpoints"))
	cfg.PolicyRoot = get(env, "POLICY_ROOT", filepath.Join(cfg.StateRoot, "policy"))
	cfg.LowerRoot = get(env, "LOWER_ROOT", filepath.Join(sharedRoot, "lower"))
	cfg.LowerLanguages = get(env, "LOWER_LANGUAGES", filepath.Join(cfg.LowerRoot, "languages-image"))
	cfg.LowerSystem = get(env, "LOWER_SYSTEM", filepath.Join(cfg.LowerRoot, "system"))
	cfg.LowerSystemBase = get(env, "LOWER_SYSTEM_BASE", filepath.Join(cfg.LowerRoot, "system-base"))
	sharedToolsRoot := filepath.Join(sharedRoot, "tools")
	cfg.RuntimeRoot = get(env, "RUNTIME_ROOT", filepath.Join("/var/lib/wisp-runtime", cfg.WispName))
	cfg.RootFSMount = get(env, "ROOTFS_MOUNT", filepath.Join(cfg.RuntimeRoot, "rootfs"))
	cfg.UpperImageMount = get(env, "UPPER_IMAGE_MOUNT", filepath.Join(cfg.RuntimeRoot, "root-upper-rw"))
	cfg.ActiveViewMount = get(env, "ACTIVE_VIEW_MOUNT", filepath.Join(cfg.RootFSMount, ".wisp/checkpoints/active"))
	cfg.LoopDeviceFile = get(env, "LOOP_DEVICE_FILE", filepath.Join(cfg.RuntimeRoot, "loop-device"))
	cfg.PIDFile = get(env, "PID_FILE", filepath.Join(cfg.RuntimeRoot, "enter.pid"))
	cfg.AdminRoot = get(env, "ADMIN_ROOT", "/run/envd")
	cfg.AdminSocketPath = get(env, "ADMIN_SOCKET_PATH", filepath.Join(cfg.AdminRoot, "admin.sock"))
	cfg.AdminListenAddr = get(env, "ADMIN_LISTEN_ADDR", "0.0.0.0:8520")
	cfg.DaemonLockFile = get(env, "DAEMON_LOCK_FILE", filepath.Join(filepath.Dir(cfg.AdminSocketPath), "wisp.lock"))
	cfg.EnvSocketPath = get(env, "ENV_SOCKET_PATH", "/.wisp/api.sock")
	cfg.EnvSocketHostPath = get(env, "ENV_SOCKET_HOST_PATH", filepath.Join(cfg.RuntimeRoot, "api.sock"))
	cfg.CrunStateRoot = get(env, "CRUN_STATE_ROOT", filepath.Join(cfg.RuntimeRoot, ".crun"))
	cfg.CrunBundleRoot = get(env, "CRUN_BUNDLE_ROOT", filepath.Join(cfg.RuntimeRoot, "bundle"))
	cfg.CrunBundleRootFS = get(env, "CRUN_BUNDLE_ROOTFS", filepath.Join(cfg.CrunBundleRoot, "rootfs"))
	cfg.CrunBinaryPath = get(env, "CRUN_BINARY_PATH", filepath.Join(sharedToolsRoot, "crun"))
	cfg.LegacyRuntimeRoot = get(env, "LEGACY_RUNTIME_ROOT", "")
	cfg.ContainerID = get(env, "CONTAINER_ID", "wisp-"+cfg.WispName)
	cfg.CgroupRoot = get(env, "CGROUP_ROOT", "/sys/fs/cgroup/wisp")
	cfg.CgroupParent = get(env, "CGROUP_PARENT", filepath.Join(cfg.CgroupRoot, cfg.WispName))
	cfg.CgroupUserParent = get(env, "CGROUP_USER_PARENT", filepath.Join(cfg.CgroupParent, "user"))
	cfg.CgroupRuntimeParent = get(env, "CGROUP_RUNTIME_PARENT", filepath.Join(cfg.CgroupParent, "runtime"))
	cfg.CgroupUserContainer = get(env, "CGROUP_USER_CONTAINER", filepath.Join(cfg.CgroupUserParent, cfg.ContainerID))
	cfg.RootUpperSize = get(env, "ROOT_UPPER_SIZE", "")
	cfg.DefaultRootUpperSize = get(env, "DEFAULT_ROOT_UPPER_SIZE", "5G")
	cfg.BlankRootUpperSparse = get(env, "BLANK_ROOT_UPPER_SPARSE", "")
	cfg.BlankRootUpperImage = get(env, "BLANK_ROOT_UPPER_IMG", "")
	cfg.BlankRootUpperTar = get(env, "BLANK_ROOT_UPPER_TAR", "")
	cfg.WispUser = get(env, "WISP_USER", "wisp")
	cfg.WispUID = getInt(env, "WISP_UID", 1001)
	cfg.WispGID = getInt(env, "WISP_GID", 1001)
	cfg.ShellPath = get(env, "SHELL_PATH", "/bin/bash")
	cfg.CrunBinary = get(env, "CRUN_BINARY", "")
	cfg.WispEnvBinary = get(env, "WISPENV_BINARY", "")
	cfg.WispFSAgentBinary = get(env, "WISP_FS_AGENT_BINARY", "")
	cfg.TiniBinary = get(env, "TINI_BINARY", "")
	cfg.TiniVersion = get(env, "TINI_VERSION", "v0.19.0")
	cfg.WispPath = get(env, "WISP_PATH", "/home/wisp/.local/bin:/.wisp/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	cfg.WispLang = get(env, "WISP_LANG", "en_US.UTF-8")
	cfg.WispBrowser = get(env, "WISP_BROWSER", "/.wisp/bin/wisp-browser")
	cfg.WispDebianFrontend = get(env, "WISP_DEBIAN_FRONTEND", "noninteractive")
	cfg.ResolvNameservers = get(env, "RESOLV_NAMESERVERS", "114.114.114.114")
	cfg.MemoryReserveMB = getInt64(env, "MEMORY_RESERVE_MB", 512)
	cfg.UserMemoryMaxBytes = get(env, "USER_MEMORY_MAX_BYTES", "")
	cfg.UserMemoryHighBytes = get(env, "USER_MEMORY_HIGH_BYTES", "")
	cfg.MemoryHighPercent = getInt64(env, "MEMORY_HIGH_PERCENT", 90)
	cfg.CPUReserveMillicores = getInt64(env, "CPU_RESERVE_MILLICORES", 500)
	cfg.UserCPUMaxMillicores = get(env, "USER_CPU_MAX_MILLICORES", "")
	cfg.CPUPeriodUS = getInt64(env, "CPU_PERIOD_US", 100000)
	cfg.TotalPIDsBudget = get(env, "TOTAL_PIDS_BUDGET", "")
	cfg.RuntimePIDsReserve = getInt64(env, "RUNTIME_PIDS_RESERVE", 128)
	cfg.UserPIDsMax = get(env, "USER_PIDS_MAX", "")
	cfg.BaseRootFSDir = get(env, "BASE_ROOTFS_DIR", "")
	cfg.BaseRootFSImage = get(env, "BASE_ROOTFS_IMG", "")

	return cfg, nil
}

func DefaultConfigPath() string {
	if path := os.Getenv("WISP_CONFIG"); path != "" {
		return path
	}
	candidates := []string{
		"config.jsonnet",
		filepath.Join("config", "config.jsonnet"),
	}
	if wd, err := os.Getwd(); err == nil {
		for _, name := range candidates {
			path := filepath.Join(wd, name)
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}
	exe, err := os.Executable()
	if err == nil {
		exeDir := filepath.Dir(exe)
		for _, name := range candidates {
			for _, path := range []string{
				filepath.Join(exeDir, name),
				filepath.Join(exeDir, "..", name),
			} {
				if _, err := os.Stat(path); err == nil {
					return path
				}
			}
		}
	}
	return "config.jsonnet"
}

func DefaultOverlayPath(basePath string) (string, error) {
	if path := os.Getenv("WISP_CONFIG_OVERLAY"); path != "" {
		return path, nil
	}
	baseEnv, err := parseJSONNetFile(basePath)
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(baseEnv["WISP_NAME"])
	if name == "" {
		name = "default"
	}
	return ContainerOverlayPath(basePath, name), nil
}

func ContainerConfigDir(basePath string) string {
	baseDir := filepath.Dir(basePath)
	if baseDir == "." || baseDir == "" {
		if wd, err := os.Getwd(); err == nil {
			baseDir = wd
		}
	}
	return filepath.Join(baseDir, "containers")
}

func ContainerOverlayPath(basePath, name string) string {
	return filepath.Join(ContainerConfigDir(basePath), name, "overlay.jsonnet")
}

func parseJSONNetFile(path string) (map[string]string, error) {
	vm := jsonnet.MakeVM()
	vm.Importer(&jsonnet.FileImporter{
		JPaths: []string{filepath.Dir(path)},
	})

	out, err := vm.EvaluateFile(path)
	if err != nil {
		return nil, fmt.Errorf("evaluate jsonnet %s: %w", path, err)
	}

	var raw map[string]any
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("decode jsonnet %s: %w", path, err)
	}

	env := map[string]string{}
	for key, value := range raw {
		switch v := value.(type) {
		case nil:
			continue
		case string:
			env[key] = v
		case bool:
			if v {
				env[key] = "true"
			} else {
				env[key] = "false"
			}
		case float64:
			env[key] = strconv.FormatFloat(v, 'f', -1, 64)
		default:
			buf, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("encode jsonnet key %s from %s: %w", key, path, err)
			}
			env[key] = string(buf)
		}
	}
	return env, nil
}

func parseOptionalJSONNetFile(path string) (map[string]string, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("stat optional jsonnet %s: %w", path, err)
	}
	values, err := parseJSONNetFile(path)
	if err == nil {
		return values, nil
	}
	return nil, err
}

func SetEnvValue(path, key, value string) error {
	overlayPath, err := DefaultOverlayPath(path)
	if err != nil {
		return err
	}
	values, err := parseOptionalJSONNetFile(overlayPath)
	if err != nil {
		return err
	}
	values[key] = value
	return writeJSONNetFile(overlayPath, values)
}

func SetWorkspaceLayout(path string, cfg Config, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("workspace name must not be empty")
	}

	tempRootBase := filepath.Dir(cfg.TempRoot)
	runtimeRootBase := filepath.Dir(cfg.RuntimeRoot)
	stateRootBase := filepath.Join(cfg.JFSRoot, "wisp")
	runtimeRoot := filepath.Join(runtimeRootBase, name)
	tempRoot := filepath.Join(tempRootBase, name)
	stateRoot := filepath.Join(stateRootBase, name)
	rootFSMount := filepath.Join(runtimeRoot, "rootfs")
	cgroupParent := filepath.Join(cfg.CgroupRoot, name)
	cgroupUserParent := filepath.Join(cgroupParent, "user")
	cgroupRuntimeParent := filepath.Join(cgroupParent, "runtime")
	containerID := "wisp-" + name

	updates := map[string]string{
		"WISP_NAME":             name,
		"REMOTE_BACKEND":        cfg.RemoteBackend,
		"COS_WORKSPACE":         RemoteWorkspaceName(name),
		"STATE_ROOT":            stateRoot,
		"ACTIVE_ROOT":           filepath.Join(stateRoot, "active"),
		"ACTIVE_IMG":            filepath.Join(stateRoot, "active", "root-upper.img"),
		"CHECKPOINTS_ROOT":      filepath.Join(stateRoot, "checkpoints"),
		"POLICY_ROOT":           filepath.Join(stateRoot, "policy"),
		"RUNTIME_ROOT":          runtimeRoot,
		"ROOTFS_MOUNT":          rootFSMount,
		"UPPER_IMAGE_MOUNT":     filepath.Join(runtimeRoot, "root-upper-rw"),
		"ACTIVE_VIEW_MOUNT":     filepath.Join(rootFSMount, ".wisp", "checkpoints", "active"),
		"LOOP_DEVICE_FILE":      filepath.Join(runtimeRoot, "loop-device"),
		"PID_FILE":              filepath.Join(runtimeRoot, "enter.pid"),
		"TEMP_ROOT":             tempRoot,
		"TMP_ROOT":              filepath.Join(tempRoot, "tmp"),
		"DOCKER_ROOT":           filepath.Join(tempRoot, "var-lib-docker"),
		"LOG_ROOT":              filepath.Join(tempRoot, "logs"),
		"ENV_SOCKET_HOST_PATH":  filepath.Join(runtimeRoot, "api.sock"),
		"CRUN_STATE_ROOT":       filepath.Join(runtimeRoot, ".crun"),
		"CRUN_BUNDLE_ROOT":      filepath.Join(runtimeRoot, "bundle"),
		"CRUN_BUNDLE_ROOTFS":    filepath.Join(runtimeRoot, "bundle", "rootfs"),
		"CONTAINER_ID":          containerID,
		"CGROUP_PARENT":         cgroupParent,
		"CGROUP_USER_PARENT":    cgroupUserParent,
		"CGROUP_RUNTIME_PARENT": cgroupRuntimeParent,
		"CGROUP_USER_CONTAINER": filepath.Join(cgroupUserParent, containerID),
	}
	if cfg.SMHEnabled {
		updates["SMH_ENABLED"] = "true"
	}
	if cfg.SMHLibraryID != "" {
		updates["SMH_LIBRARY_ID"] = cfg.SMHLibraryID
	}
	if cfg.SMHAccessDomain != "" {
		updates["SMH_ACCESS_DOMAIN"] = cfg.SMHAccessDomain
	}
	if cfg.SMHSpaceID != "" {
		updates["SMH_SPACE_ID"] = cfg.SMHSpaceID
	}
	if cfg.LegacyRuntimeRoot != "" {
		updates["LEGACY_RUNTIME_ROOT"] = filepath.Join(filepath.Dir(cfg.LegacyRuntimeRoot), name)
	}

	for _, key := range []string{
		"WISP_NAME",
		"REMOTE_BACKEND",
		"SMH_ENABLED",
		"SMH_LIBRARY_ID",
		"SMH_ACCESS_DOMAIN",
		"SMH_SPACE_ID",
		"COS_WORKSPACE",
		"STATE_ROOT",
		"ACTIVE_ROOT",
		"ACTIVE_IMG",
		"CHECKPOINTS_ROOT",
		"POLICY_ROOT",
		"RUNTIME_ROOT",
		"ROOTFS_MOUNT",
		"UPPER_IMAGE_MOUNT",
		"ACTIVE_VIEW_MOUNT",
		"LOOP_DEVICE_FILE",
		"PID_FILE",
		"TEMP_ROOT",
		"TMP_ROOT",
		"DOCKER_ROOT",
		"LOG_ROOT",
		"ENV_SOCKET_HOST_PATH",
		"CRUN_STATE_ROOT",
		"CRUN_BUNDLE_ROOT",
		"CRUN_BUNDLE_ROOTFS",
		"CONTAINER_ID",
		"CGROUP_PARENT",
		"CGROUP_USER_PARENT",
		"CGROUP_RUNTIME_PARENT",
		"CGROUP_USER_CONTAINER",
		"LEGACY_RUNTIME_ROOT",
	} {
		value, ok := updates[key]
		if !ok {
			continue
		}
		if err := SetContainerEnvValue(path, name, key, value); err != nil {
			return err
		}
	}
	return nil
}

func RemoteWorkspaceName(name string) string {
	raw := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	lastHyphen := false
	for _, r := range raw {
		allowed := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if allowed {
			b.WriteRune(r)
			lastHyphen = false
			continue
		}
		if !lastHyphen {
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "wisp"
	}
	for len(out) < 3 {
		out += "-x"
	}
	if len(out) <= 63 {
		return out
	}
	sum := sha1.Sum([]byte(raw))
	suffix := hex.EncodeToString(sum[:])[:10]
	prefix := strings.Trim(out[:52], "-")
	if prefix == "" {
		prefix = "wisp"
	}
	return prefix + "-" + suffix
}

func SetContainerEnvValue(basePath, name, key, value string) error {
	overlayPath := ContainerOverlayPath(basePath, name)
	values, err := parseOptionalJSONNetFile(overlayPath)
	if err != nil {
		return err
	}
	values[key] = value
	return writeJSONNetFile(overlayPath, values)
}

func RemoveContainerOverlay(basePath, name string) error {
	overlayPath := ContainerOverlayPath(basePath, name)
	if err := os.Remove(overlayPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove overlay %s: %w", overlayPath, err)
	}
	containerDir := filepath.Dir(overlayPath)
	if err := os.Remove(containerDir); err != nil && !os.IsNotExist(err) && !errorsIsNotEmpty(err) {
		return fmt.Errorf("remove overlay dir %s: %w", containerDir, err)
	}
	return nil
}

func ListContainerNames(basePath string) ([]string, error) {
	dir := ContainerConfigDir(basePath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read container config dir %s: %w", dir, err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, entry.Name(), "overlay.jsonnet")); err == nil {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func writeJSONNetFile(path string, values map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir config dir for %s: %w", path, err)
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.WriteString("{\n")
	for i, key := range keys {
		comma := ","
		if i == len(keys)-1 {
			comma = ""
		}
		fmt.Fprintf(&b, "  %q: %q%s\n", key, values[key], comma)
	}
	b.WriteString("}\n")

	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return fmt.Errorf("write jsonnet config %s: %w", path, err)
	}
	return nil
}

func errorsIsNotEmpty(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "directory not empty") || strings.Contains(msg, "not empty")
}

func mergeConfigMaps(base map[string]string, overlay map[string]string) map[string]string {
	merged := map[string]string{}
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range overlay {
		if v == "" {
			continue
		}
		merged[k] = v
	}
	return merged
}

func normalizeRemoteBackend(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "cos":
		return "cos"
	case "smh":
		return "smh"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func mergeEnv(fileEnv map[string]string, processEnv []string) map[string]string {
	merged := map[string]string{}
	for _, entry := range processEnv {
		k, v, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(k) == "" || v == "" {
			continue
		}
		merged[k] = v
	}
	for k, v := range fileEnv {
		if v == "" {
			continue
		}
		merged[k] = v
	}
	return merged
}

func get(env map[string]string, key, fallback string) string {
	if value, ok := env[key]; ok && value != "" {
		return value
	}
	return fallback
}

func getInt(env map[string]string, key string, fallback int) int {
	v, err := strconv.Atoi(get(env, key, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	return v
}

func getInt64(env map[string]string, key string, fallback int64) int64 {
	v, err := strconv.ParseInt(get(env, key, strconv.FormatInt(fallback, 10)), 10, 64)
	if err != nil {
		return fallback
	}
	return v
}

func getBool(env map[string]string, key string, fallback bool) bool {
	v := strings.TrimSpace(strings.ToLower(get(env, key, "")))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	case "":
		return fallback
	default:
		return fallback
	}
}
