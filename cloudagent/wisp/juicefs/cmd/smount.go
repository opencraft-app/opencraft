package cmd

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/benbjohnson/litestream"
	_ "github.com/benbjohnson/litestream/s3"
	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/superfly/ltx"
	"github.com/urfave/cli/v2"
)

const (
	defaultSMountSyncInterval     = "3s"
	defaultSMountBarrierTimeout   = "60s"
	defaultSMountRuntimeMode      = "full"
	defaultSMountSnapshotInterval = "1m"
)

type localRootPaths struct {
	metaBase  string
	mountBase string
	cacheDir  string
	logPath   string
}

func deriveLocalRootPaths(root, workspace string) (localRootPaths, error) {
	if strings.TrimSpace(root) == "" {
		return localRootPaths{}, fmt.Errorf("local root is empty")
	}
	if strings.TrimSpace(workspace) == "" {
		return localRootPaths{}, fmt.Errorf("workspace is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return localRootPaths{}, fmt.Errorf("abs local root: %w", err)
	}
	workspaceRoot := filepath.Join(abs, workspace)
	return localRootPaths{
		metaBase:  filepath.Join(workspaceRoot, "meta"),
		mountBase: filepath.Join(workspaceRoot, "mnt"),
		cacheDir:  filepath.Join(workspaceRoot, "cache"),
		logPath:   filepath.Join(workspaceRoot, "log", "juicefs.log"),
	}, nil
}

func applyLocalRootDefaults(c *cli.Context, workspace string, includeMount bool) error {
	root := strings.TrimSpace(c.String("local-root"))
	if root == "" {
		return nil
	}
	paths, err := deriveLocalRootPaths(root, workspace)
	if err != nil {
		return err
	}
	if !c.IsSet("meta-base") {
		if err := c.Set("meta-base", paths.metaBase); err != nil {
			return err
		}
	}
	if includeMount && !c.IsSet("mount-base") {
		if err := c.Set("mount-base", paths.mountBase); err != nil {
			return err
		}
	}
	if includeMount && !c.IsSet("cache-dir") {
		if err := c.Set("cache-dir", paths.cacheDir); err != nil {
			return err
		}
	}
	if includeMount && !c.IsSet("log") {
		if err := c.Set("log", paths.logPath); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(paths.metaBase, 0o755); err != nil {
		return fmt.Errorf("create local meta base: %w", err)
	}
	if includeMount {
		for _, dir := range []string{paths.mountBase, paths.cacheDir, filepath.Dir(paths.logPath)} {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return fmt.Errorf("create local root path %s: %w", dir, err)
			}
		}
	}
	return nil
}

func cmdSMount() *cli.Command {
	return &cli.Command{
		Name:      "smount",
		Action:    smount,
		Category:  "SERVICE",
		Usage:     "Mount a workspace-backed volume with templated S3-compatible metadata and data paths",
		ArgsUsage: "WORKSPACE",
		Description: `
Mount a JuiceFS volume using a single workspace name. The command derives:

- local SQLite writable-VFS working file
- S3-compatible replica path for metadata
- S3-compatible data prefix
- default mountpoint

This is intended for the writable-VFS + COS workflow where most arguments are
templated and differ only by workspace.
`,
		Flags: expandFlags(
			mountFlags(),
			clientFlags(1.0),
			shareInfoFlags(),
			[]cli.Flag{
				&cli.StringFlag{
					Name:  "mountpoint",
					Usage: "mountpoint to use; default is --mount-base/<workspace>",
				},
				&cli.StringFlag{
					Name:  "mount-base",
					Value: "/tmp/jfs-mounts",
					Usage: "base directory used to derive the default mountpoint",
				},
				&cli.StringFlag{
					Name:  "meta-base",
					Value: "/tmp/jfs-smount-meta",
					Usage: "base directory for the local SQLite writable-VFS working database",
				},
				&cli.StringFlag{
					Name:  "local-root",
					Usage: "local root prefix; when set, default meta-base, mount-base, cache-dir, and log path are derived under <local-root>/<workspace>/",
				},
				&cli.StringFlag{
					Name:  "workspace-prefix",
					Value: "workspace",
					Usage: "S3-compatible prefix root used for metadata replica and data path under the workspace",
				},
				&cli.StringFlag{
					Name:  "sync-interval",
					Value: defaultSMountSyncInterval,
					Usage: "litestream writable-VFS sync interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "bootstrap-sync-interval",
					Usage: "litestream writable-VFS sync interval used only while formatting an empty workspace before the long-lived mount starts",
				},
				&cli.StringFlag{
					Name:  "barrier-timeout",
					Value: defaultSMountBarrierTimeout,
					Usage: "litestream writable-VFS barrier timeout encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "runtime-maintenance",
					Value: defaultSMountRuntimeMode,
					Usage: "litestream runtime maintenance mode encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "snapshot-interval",
					Value: defaultSMountSnapshotInterval,
					Usage: "litestream snapshot interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "mount-timeout",
					Value: "300",
					Usage: "mount readiness timeout in seconds, exported as JFS_MOUNT_TIMEOUT for the mount process",
				},
				&cli.BoolFlag{
					Name:  "managed",
					Usage: "skip stage-0 metadata/storage fail-fast checks because an external supervisor handles readiness and recovery",
				},
			},
		),
	}
}

func cmdAssertMount() *cli.Command {
	return &cli.Command{
		Name:      "assertmount",
		Action:    assertmount,
		Category:  "SERVICE",
		Usage:     "Format a workspace-backed volume only when needed, then mount it",
		ArgsUsage: "WORKSPACE",
		Description: `
Ensure a workspace-backed JuiceFS volume exists and is mounted. The command
checks the remote Litestream replica first: if the replica is empty, it formats
the metadata; otherwise it mounts the existing metadata directly.
`,
		Flags: expandFlags(
			mountFlags(),
			clientFlags(1.0),
			shareInfoFlags(),
			formatCredentialFlags(),
			formatFlags(),
			formatManagementFlags(),
			[]cli.Flag{
				&cli.StringFlag{
					Name:  "mountpoint",
					Usage: "mountpoint to use; default is --mount-base/<workspace>",
				},
				&cli.StringFlag{
					Name:  "mount-base",
					Value: "/tmp/jfs-mounts",
					Usage: "base directory used to derive the default mountpoint",
				},
				&cli.StringFlag{
					Name:  "meta-base",
					Value: "/tmp/jfs-smount-meta",
					Usage: "base directory for the local SQLite writable-VFS working database",
				},
				&cli.StringFlag{
					Name:  "local-root",
					Usage: "local root prefix; when set, default meta-base, mount-base, cache-dir, and log path are derived under <local-root>/<workspace>/",
				},
				&cli.StringFlag{
					Name:  "workspace-prefix",
					Value: "workspace",
					Usage: "S3-compatible prefix root used for metadata replica and data path under the workspace",
				},
				&cli.StringFlag{
					Name:  "sync-interval",
					Value: defaultSMountSyncInterval,
					Usage: "litestream writable-VFS sync interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "bootstrap-sync-interval",
					Usage: "litestream writable-VFS sync interval used only while formatting an empty workspace before the long-lived mount starts",
				},
				&cli.StringFlag{
					Name:  "barrier-timeout",
					Value: defaultSMountBarrierTimeout,
					Usage: "litestream writable-VFS barrier timeout encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "runtime-maintenance",
					Value: defaultSMountRuntimeMode,
					Usage: "litestream runtime maintenance mode encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "snapshot-interval",
					Value: defaultSMountSnapshotInterval,
					Usage: "litestream snapshot interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "mount-timeout",
					Value: "300",
					Usage: "mount readiness timeout in seconds, exported as JFS_MOUNT_TIMEOUT for the mount process",
				},
				&cli.BoolFlag{
					Name:  "managed",
					Usage: "skip stage-0 metadata/storage fail-fast checks because an external supervisor handles readiness and recovery",
				},
				&cli.StringFlag{
					Name:  "volume-name",
					Usage: "override the JuiceFS volume name; default is the workspace",
				},
			},
		),
	}
}

func formatCredentialFlags() []cli.Flag {
	return addCategories("DATA STORAGE", []cli.Flag{
		&cli.StringFlag{
			Name:  "access-key",
			Usage: "access key for object storage (env ACCESS_KEY)",
		},
		&cli.StringFlag{
			Name:  "secret-key",
			Usage: "secret key for object storage (env SECRET_KEY)",
		},
		&cli.StringFlag{
			Name:  "session-token",
			Usage: "session token for object storage",
		},
	})
}

func smount(c *cli.Context) error {
	setup(c, 1)
	workspace, err := sWorkspaceArg(c)
	if err != nil {
		return err
	}
	if err := applyLocalRootDefaults(c, workspace, true); err != nil {
		return err
	}

	backend := resolveRemoteBackend()
	addr, mp, bucketURL, err := buildSMountTarget(c, workspace)
	if err != nil {
		return err
	}
	removePassword(addr)

	logger.Infof("smount workspace=%s", workspace)
	logger.Infof("smount meta=%s", addr)
	logger.Infof("smount data bucket=%s", bucketURL)
	logger.Infof("smount mountpoint=%s", mp)
	logger.Infof("smount mount-timeout=%ss", c.String("mount-timeout"))

	if timeout := strings.TrimSpace(c.String("mount-timeout")); timeout != "" {
		if err := os.Setenv("JFS_MOUNT_TIMEOUT", timeout); err != nil {
			return fmt.Errorf("set JFS_MOUNT_TIMEOUT: %w", err)
		}
	}

	return mountWithTarget(c, addr, mp, func(f *meta.Format) {
		applyBackendFormatDefaults(c, backend, bucketURL, f)
	})
}

func assertmount(c *cli.Context) error {
	setup(c, 1)
	workspace, err := sWorkspaceArg(c)
	if err != nil {
		return err
	}
	if err := applyLocalRootDefaults(c, workspace, true); err != nil {
		return err
	}

	backend := resolveRemoteBackend()
	addr, mp, bucketURL, err := buildSMountTarget(c, workspace)
	if err != nil {
		return err
	}
	daemonStage := getDaemonStage()
	shouldBootstrap := assertMountShouldBootstrap(daemonStage, os.Getenv("JFS_SUPERVISOR"))
	hasLTX := true
	if shouldBootstrap {
		replicaURL, err := litestreamReplicaURLFromSQLiteAddr(addr)
		if err != nil {
			return err
		}
		replicaStart := time.Now()
		hasLTX, err = replicaHasLTXFiles(c.Context, replicaURL)
		if err != nil {
			return err
		}
		logger.Infof("assertmount_detail step=replica_has_ltx done initialized=%t duration=%s", hasLTX, time.Since(replicaStart))
		if !hasLTX {
			formatStart := time.Now()
			formatAddr := markSQLiteAssumeEmpty(addr)
			if bootstrapSyncInterval := strings.TrimSpace(c.String("bootstrap-sync-interval")); bootstrapSyncInterval != "" {
				formatAddr = setSQLiteLitestreamSyncInterval(formatAddr, bootstrapSyncInterval)
			}
			if err := formatSMountTarget(c, workspace, formatAddr, bucketURL); err != nil {
				return err
			}
			logger.Infof("assertmount_detail step=format done duration=%s", time.Since(formatStart))
		}
	} else {
		logger.Infof("assertmount_detail step=replica_has_ltx skipped daemon_stage=%d supervisor=%t", daemonStage, os.Getenv("JFS_SUPERVISOR") != "")
	}

	removePassword(addr)
	logger.Infof("assertmount workspace=%s", workspace)
	logger.Infof("assertmount initialized=%t", hasLTX)
	logger.Infof("assertmount meta=%s", addr)
	logger.Infof("assertmount data bucket=%s", bucketURL)
	logger.Infof("assertmount mountpoint=%s", mp)
	logger.Infof("assertmount mount-timeout=%ss", c.String("mount-timeout"))

	if timeout := strings.TrimSpace(c.String("mount-timeout")); timeout != "" {
		if err := os.Setenv("JFS_MOUNT_TIMEOUT", timeout); err != nil {
			return fmt.Errorf("set JFS_MOUNT_TIMEOUT: %w", err)
		}
	}
	mountStart := time.Now()
	err = mountWithTarget(c, addr, mp, func(f *meta.Format) {
		applyBackendFormatDefaults(c, backend, bucketURL, f)
	})
	logger.Infof("assertmount_detail step=mount done duration=%s err=%v", time.Since(mountStart), err)
	return err
}

func assertMountShouldBootstrap(daemonStage int, supervisor string) bool {
	return daemonStage == 0 && strings.TrimSpace(supervisor) == ""
}

func sWorkspaceArg(c *cli.Context) (string, error) {
	workspace := strings.TrimSpace(c.Args().Get(0))
	if workspace == "" {
		return "", fmt.Errorf("workspace is required")
	}
	if strings.Contains(workspace, "/") {
		return "", fmt.Errorf("workspace must not contain '/'")
	}
	return workspace, nil
}

func formatSMountTarget(c *cli.Context, workspace, addr, bucketURL string) error {
	addr = disableSQLiteHydration(addr)
	backend := resolveRemoteBackend()
	volumeName := strings.TrimSpace(c.String("volume-name"))
	if volumeName == "" {
		volumeName = workspace
	}
	validName := regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$`)
	if !validName.MatchString(volumeName) {
		return fmt.Errorf("invalid volume name %q, only lowercase letters, numbers and '-' are allowed and length should be 3 to 63", volumeName)
	}
	if err := applyBackendStorageFlagDefaults(c, backend, bucketURL); err != nil {
		return err
	}
	removePassword(addr)
	logger.Infof("sformat workspace=%s", workspace)
	logger.Infof("sformat meta=%s", addr)
	logger.Infof("sformat data bucket=%s", bucketURL)
	logger.Infof("sformat volume=%s", volumeName)
	return formatWithTarget(c, addr, volumeName)
}

func litestreamReplicaURLFromSQLiteAddr(addr string) (string, error) {
	u, err := url.Parse(addr)
	if err != nil {
		return "", fmt.Errorf("parse meta URL: %w", err)
	}
	replicaURL := strings.TrimSpace(u.Query().Get("litestream_replica_url"))
	if replicaURL == "" {
		return "", fmt.Errorf("meta URL does not include litestream_replica_url")
	}
	return replicaURL, nil
}

func markSQLiteAssumeEmpty(addr string) string {
	return updateSQLiteLitestreamQuery(addr, func(q url.Values) {
		q.Set("litestream_assume_empty", "true")
	})
}

func setSQLiteLitestreamSyncInterval(addr, interval string) string {
	interval = strings.TrimSpace(interval)
	if interval == "" {
		return addr
	}
	return updateSQLiteLitestreamQuery(addr, func(q url.Values) {
		q.Set("litestream_sync_interval", interval)
	})
}

func updateSQLiteLitestreamQuery(addr string, update func(url.Values)) string {
	base, queryStr, ok := strings.Cut(addr, "?")
	if !ok {
		return addr
	}
	q, err := url.ParseQuery(queryStr)
	if err != nil {
		return addr
	}
	update(q)
	return base + "?" + q.Encode()
}

func replicaHasLTXFiles(ctx context.Context, replicaURL string) (bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	client, err := litestream.NewReplicaClientFromURL(replicaURL)
	if err != nil {
		return false, fmt.Errorf("open litestream replica: %w", err)
	}
	if err := client.Init(ctx); err != nil {
		return false, fmt.Errorf("init litestream replica: %w", err)
	}
	for level := 0; level <= litestream.SnapshotLevel; level++ {
		itr, err := client.LTXFiles(ctx, level, 0, false)
		if err != nil {
			return false, fmt.Errorf("list litestream replica level %d: %w", level, err)
		}
		hasNext, err := fileIteratorHasNext(itr)
		if err != nil {
			return false, fmt.Errorf("iterate litestream replica level %d: %w", level, err)
		}
		if hasNext {
			return true, nil
		}
	}
	return false, nil
}

func fileIteratorHasNext(itr ltx.FileIterator) (bool, error) {
	hasNext := itr.Next()
	iterErr := itr.Err()
	closeErr := itr.Close()
	if iterErr != nil {
		return false, iterErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	return hasNext, nil
}

func applyBackendStorageFlagDefaults(c *cli.Context, backend, bucketURL string) error {
	switch backend {
	case "smh":
		if !c.IsSet("storage") {
			if err := c.Set("storage", "smh"); err != nil {
				return err
			}
		}
		if !c.IsSet("bucket") {
			if err := c.Set("bucket", bucketURL); err != nil {
				return err
			}
		}
	default:
		if !c.IsSet("storage") {
			if err := c.Set("storage", "s3"); err != nil {
				return err
			}
		}
		if !c.IsSet("bucket") {
			if err := c.Set("bucket", bucketURL); err != nil {
				return err
			}
		}
	}
	return nil
}

func applyBackendFormatDefaults(c *cli.Context, backend, bucketURL string, f *meta.Format) {
	switch backend {
	case "smh":
		if !c.IsSet("storage") {
			f.Storage = "smh"
		}
		if !c.IsSet("bucket") {
			f.Bucket = bucketURL
		}
	default:
		if !c.IsSet("storage") {
			f.Storage = "s3"
		}
		if !c.IsSet("bucket") {
			f.Bucket = bucketURL
		}
	}
}

func buildSMountTarget(c *cli.Context, workspace string) (addr string, mountpoint string, bucketURL string, err error) {
	metaBase := strings.TrimSpace(c.String("meta-base"))
	mountBase := strings.TrimSpace(c.String("mount-base"))
	workspacePrefix := strings.Trim(strings.TrimSpace(c.String("workspace-prefix")), "/")
	if metaBase == "" {
		metaBase = "/tmp/jfs-smount-meta"
	}
	if mountBase == "" {
		mountBase = "/tmp/jfs-mounts"
	}
	if workspacePrefix == "" {
		workspacePrefix = "workspace"
	}
	workspaceScopedLocalRoot := strings.TrimSpace(c.String("local-root")) != ""

	localMetaDir := metaBase
	if !workspaceScopedLocalRoot {
		localMetaDir = filepath.Join(metaBase, workspace)
	}
	if err = os.MkdirAll(localMetaDir, 0o755); err != nil {
		return "", "", "", fmt.Errorf("create local meta dir: %w", err)
	}
	localMetaPath := filepath.Join(localMetaDir, "meta.db")

	mountpoint = strings.TrimSpace(c.String("mountpoint"))
	if mountpoint == "" {
		mountpoint = mountBase
		if !workspaceScopedLocalRoot {
			mountpoint = filepath.Join(mountBase, workspace)
		}
	}

	configuredMetaURL := expandWorkspaceTemplate(strings.TrimSpace(os.Getenv("JFS_META_URL")), workspacePrefix, workspace)
	configuredBucketURL := expandWorkspaceTemplate(strings.TrimSpace(os.Getenv("JFS_BUCKET_URL")), workspacePrefix, workspace)
	if configuredMetaURL != "" {
		addr = configuredMetaURL
	} else {
		replicaURL, bucket, err := buildSMountRemoteTargets(resolveRemoteBackend(), workspacePrefix, workspace)
		if err != nil {
			return "", "", "", err
		}
		bucketURL = bucket

		q := url.Values{}
		q.Set("litestream_write", "true")
		q.Set("litestream_replica_url", replicaURL)
		q.Set("litestream_sync_interval", c.String("sync-interval"))
		q.Set("litestream_barrier_timeout", c.String("barrier-timeout"))
		q.Set("litestream_runtime_maintenance", c.String("runtime-maintenance"))
		q.Set("litestream_snapshot_interval", c.String("snapshot-interval"))
		q.Set("litestream_hydration", "true")
		addr = "sqlite3://" + localMetaPath + "?" + q.Encode()
	}
	if configuredBucketURL != "" {
		bucketURL = configuredBucketURL
	}
	return addr, mountpoint, bucketURL, nil
}

func expandWorkspaceTemplate(value, workspacePrefix, workspace string) string {
	if value == "" {
		return ""
	}
	value = strings.ReplaceAll(value, "{workspace}", workspace)
	value = strings.ReplaceAll(value, "{workspace_prefix}", workspacePrefix)
	return value
}

func resolveRemoteBackend() string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("REMOTE_BACKEND"))) {
	case "", "cos":
		return "cos"
	case "smh":
		return "smh"
	default:
		return strings.ToLower(strings.TrimSpace(os.Getenv("REMOTE_BACKEND")))
	}
}

func buildSMountRemoteTargets(backend, prefixRoot, workspace string) (replicaURL string, bucketURL string, err error) {
	if backend == "smh" {
		return buildSMHRemoteTargets(prefixRoot, workspace)
	}
	bucket := os.Getenv("COS_BUCKET")
	region := os.Getenv("COS_REGION")
	endpoint := os.Getenv("COS_ENDPOINT")
	if bucket == "" || region == "" || endpoint == "" {
		return "", "", fmt.Errorf("smount requires COS_BUCKET, COS_REGION, and COS_ENDPOINT for the S3-compatible backend")
	}

	replica := &url.URL{
		Scheme: "s3",
		Host:   bucket,
		Path:   "/" + strings.Trim(prefixRoot+"/"+workspace+"/meta.db", "/"),
	}
	rq := replica.Query()
	rq.Set("endpoint", endpoint)
	rq.Set("region", region)
	rq.Set("force-path-style", "false")
	rq.Set("sign-payload", "true")
	replica.RawQuery = rq.Encode()

	bq := url.Values{}
	bq.Set("prefix", strings.Trim(prefixRoot+"/"+workspace+"/data", "/"))
	bq.Set("force-path-style", "false")
	bucketURL = fmt.Sprintf("https://%s.cos.%s.myqcloud.com?%s", bucket, region, bq.Encode())
	return replica.String(), bucketURL, nil
}

func buildSMHRemoteTargets(prefixRoot, workspace string) (replicaURL string, bucketURL string, err error) {
	replicaURL = firstNonEmpty(os.Getenv("SMH_META_REPLICA_URL"), os.Getenv("LITESTREAM_REPLICA_URL"))
	accessDomain := strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN"))
	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	spaceID := strings.TrimSpace(os.Getenv("SMH_SPACE_ID"))
	if accessDomain == "" || libraryID == "" || spaceID == "" {
		return "", "", fmt.Errorf("smh backend requires SMH_ACCESS_DOMAIN, SMH_LIBRARY_ID, and SMH_SPACE_ID")
	}
	if !strings.Contains(accessDomain, "://") {
		accessDomain = "https://" + accessDomain
	}
	u, err := url.Parse(accessDomain)
	if err != nil {
		return "", "", fmt.Errorf("parse SMH_ACCESS_DOMAIN: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Host == "" {
		return "", "", fmt.Errorf("parse SMH_ACCESS_DOMAIN: host is required")
	}
	endpoint := *u
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	if replicaURL == "" {
		ru := &url.URL{
			Scheme: "smh",
			Host:   u.Host,
			Path:   "/" + strings.Trim(prefixRoot+"/"+workspace+"/meta.db", "/"),
		}
		rq := ru.Query()
		rq.Set("endpoint", endpoint.String())
		rq.Set("library_id", libraryID)
		rq.Set("layout", "flat")
		rq.Set("space_id", spaceID)
		if permanent := strings.TrimSpace(os.Getenv("SMH_PERMANENT_DELETE")); permanent != "" {
			rq.Set("permanent", permanent)
		}
		ru.RawQuery = rq.Encode()
		replicaURL = ru.String()
	}
	q := u.Query()
	q.Set("library_id", libraryID)
	q.Set("space_id", spaceID)
	q.Set("prefix", strings.Trim(prefixRoot+"/"+workspace+"/data", "/"))
	if permanent := strings.TrimSpace(os.Getenv("SMH_PERMANENT_DELETE")); permanent != "" {
		q.Set("permanent", permanent)
	}
	u.RawQuery = q.Encode()
	return replicaURL, u.String(), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
