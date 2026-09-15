package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"hypernode/internal/modelgateway"
	"hypernode/internal/policy"
	"hypernode/internal/server"
	"hypernode/internal/store"
	"hypernode/internal/telemetry"
	workspacev2 "hypernode/internal/workspaces"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "serve":
		if err := serve(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "events":
		events(os.Args[2:])
	case "workspace":
		workspaceCommand(os.Args[2:])
	case "workspace-agent":
		if err := workspaceAgent(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "workspace-stdio":
		if err := workspaceStdio(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: hypernode <serve|events|workspace|workspace-agent|workspace-stdio> [options]")
	os.Exit(2)
}

// workspaceStdio is the portable path used when HyperNode connects to a
// regular OpenSSH server. Managed workspace agents intercept the equivalent
// reserved exec request and enter the same policy.RunWorkspaceStdio worker
// without spawning this process.
func workspaceStdio(args []string) error {
	flags := flag.NewFlagSet("workspace-stdio", flag.ExitOnError)
	root := flags.String("root", "/workspace", "workspace root exposed by the stdio protocol")
	protocol := flags.String("protocol", "hypernode-fs@v1", "workspace stdio protocol version")
	flags.Parse(args)
	return policy.RunWorkspaceStdio(*root, *protocol, os.Stdin, os.Stdout)
}

// workspaceAgent exposes one container view through the same policy-owned
// vSSH implementation as the outer node. It deliberately has no Thread,
// account, or model semantics: it is only an attachable execution capability.
func workspaceAgent(args []string) error {
	flags := flag.NewFlagSet("workspace-agent", flag.ExitOnError)
	listen := flags.String("listen", "0.0.0.0:2222", "private workspace-agent listen address")
	root := flags.String("root", "/workspace", "workspace root visible to commands")
	policyPath := flags.String("policy", "/opt/hypernode/workspace-agent.js", "workspace-agent policy bundle")
	dbPath := flags.String("db", "/tmp/hypernode-workspace-agent.sqlite", "ephemeral audit database")
	flags.Parse(args)
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	engine, err := policy.NewWithStoreConfig(*policyPath, "", st, policy.RuntimeConfig{
		AuthenticationMode: "debug",
		LocalhostRoot:      *root,
		UsersRoot:          "/tmp/hypernode-workspace-users",
		WorkspaceAgent:     true,
	})
	if err != nil {
		return err
	}
	defer engine.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv, err := server.NewRaw(*listen, st, engine)
	if err != nil {
		return err
	}
	log.Printf("hypernode workspace agent listening on %s (root=%s)", *listen, *root)
	return srv.Serve(ctx)
}

type serviceResult struct {
	name string
	err  error
}

// runServices keeps shared dependencies alive until every listener and all of
// its connection workers have observed cancellation. Returning after only the
// first listener exits lets serve() close SQLite while the other listener is
// still flushing its final policy/audit events.
func runServices(stop context.CancelFunc, services map[string]func() error) error {
	results := make(chan serviceResult, len(services))
	for name, run := range services {
		name, run := name, run
		go func() { results <- serviceResult{name: name, err: run()} }()
	}
	var firstError error
	for completed := 0; completed < len(services); completed++ {
		result := <-results
		if completed == 0 {
			// The first service exit owns shutdown. Other services must finish
			// before the policy host and durable store are closed.
			stop()
		}
		if result.err != nil && firstError == nil {
			firstError = fmt.Errorf("%s: %w", result.name, result.err)
		}
	}
	return firstError
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := flags.String("listen", "0.0.0.0:9988", "SSH listen address")
	dbPath := flags.String("db", ".runtime/hypernode.sqlite", "durable SQLite event store")
	policyPath := flags.String("policy", "policy/default.js", "Goja policy script")
	hostKey := flags.String("host-key", ".runtime/ssh_host_ed25519", "legacy SSH host key seed imported only when the database has no node identity")
	allowNone := flags.Bool("allow-none", true, "allow SSH none authentication through the JS policy")
	sshStack := flags.String("ssh-stack", "go", "SSH protocol stack: go or vssh")
	authMode := flags.String("auth-mode", "debug", "authentication mode: debug or bootstrap")
	defaultHome, err := os.UserHomeDir()
	if err != nil {
		log.Fatal(err)
	}
	localhostRoot := flags.String("localhost-root", defaultHome, "host directory mounted at virtual /localhost")
	codexExecutable := flags.String("codex-bin", "codex", "Codex executable used by the local app-server bridge")
	usersRoot := flags.String("users-root", ".runtime/users", "per-user Hypernode home directory root")
	userProcessCredentials := flags.Bool("user-process-credentials", false, "run per-user Codex processes with allocated UID/GID")
	workspaceRuntime := flags.String("workspace-runtime", "runc", "workspace runtime (runc only)")
	workspaceImage := flags.String("workspace-image", "/data/data.img", "sparse Btrfs workspace image")
	workspaceImageSizeTB := flags.Int64("workspace-image-size-tb", 16, "logical sparse workspace image size in decimal TB")
	workspaceMount := flags.String("workspace-mount", "/data/hypernode/.runtime/workspace", "host mountpoint for the Btrfs workspace")
	dockerExecutable := flags.String("docker-bin", "docker", "Docker client executable")
	workspaceContainerImage := flags.String("workspace-container-image", "hypernode/workspace:ubuntu-24.04", "Workspace v2 rootfs template image")
	workspaceDockerfile := flags.String("workspace-dockerfile", "deploy/workspace/Dockerfile", "Workspace v2 rootfs template Dockerfile")
	runcExecutable := flags.String("runc-bin", "runc", "runc executable used by the local workspace driver")
	workspaceUIDBase := flags.Int("workspace-uid-base", 100000, "host UID/GID base for the workspace user namespace")
	workspaceRuntimeRoot := flags.String("workspace-runtime-root", "/run/hypernode-workspaces", "ephemeral runc bundle root")
	modelGatewayBaseURL := flags.String("model-gateway-base-url", "http://hypernode.internal:9988", "gateway URL visible inside workspace containers")
	policyReleaseDir := flags.String("policy-release-dir", "policy/releases", "trusted hot-upgrade release directory")
	policyHotPoll := flags.Duration("policy-hot-poll", time.Second, "hot-upgrade manifest polling interval")
	flags.Parse(args)
	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve hypernode executable: %w", err)
	}
	executablePath, err = filepath.EvalSymlinks(executablePath)
	if err != nil {
		return fmt.Errorf("resolve hypernode executable symlinks: %w", err)
	}
	absolutePolicyPath, err := filepath.Abs(*policyPath)
	if err != nil {
		return fmt.Errorf("resolve policy path: %w", err)
	}
	workspaceAgentPolicy := filepath.Join(filepath.Dir(absolutePolicyPath), "workspace-agent.js")
	if *authMode != "debug" && *authMode != "bootstrap" {
		return fmt.Errorf("invalid --auth-mode %q: expected debug or bootstrap", *authMode)
	}
	if *sshStack != "go" && *sshStack != "vssh" {
		return fmt.Errorf("invalid --ssh-stack %q: expected go or vssh", *sshStack)
	}
	if *workspaceRuntime != "runc" {
		return fmt.Errorf("invalid --workspace-runtime %q: only runc is supported", *workspaceRuntime)
	}
	telemetryManager, err := telemetry.Setup(context.Background(), "hypernode")
	if err != nil {
		return err
	}
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if shutdownErr := telemetryManager.Shutdown(shutdownContext); shutdownErr != nil {
			log.Printf("hypernode telemetry shutdown: %v", shutdownErr)
		}
	}()
	if telemetryManager.Enabled() {
		log.Printf("hypernode OpenTelemetry tracing enabled (exporter=otlp/http)")
	}

	password := os.Getenv("HYPERNODE_PASSWORD")
	if password == "" && !*allowNone {
		return fmt.Errorf("HYPERNODE_PASSWORD must be set; refusing to expose an unauthenticated SSH server")
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	providerRegistry := modelgateway.NewRegistry()
	var workspaceManager *workspacev2.Manager
	workspaceDriver := ""
	if *workspaceRuntime == "runc" {
		stack, stackErr := newWorkspaceV2Stack(workspaceV2Options{
			ImagePath: *workspaceImage, ImageSizeBytes: *workspaceImageSizeTB * 1_000_000_000_000,
			MountPath: *workspaceMount, ContainerImage: *workspaceContainerImage,
			DockerfilePath: *workspaceDockerfile, DockerBinary: *dockerExecutable,
			RuncBinary: *runcExecutable, UIDBase: *workspaceUIDBase, UsersRoot: *usersRoot,
			RuntimeRoot: *workspaceRuntimeRoot,
			AgentBinary: executablePath, AgentPolicy: workspaceAgentPolicy, WithRuntime: true,
		})
		if stackErr != nil {
			return stackErr
		}
		defer func() {
			if closeErr := stack.Close(); closeErr != nil {
				log.Printf("workspace runtime shutdown: %v", closeErr)
			}
		}()
		if stackErr = workspacev2.RequirePreparedVolume(context.Background(), stack.Volume); stackErr != nil {
			return stackErr
		}
		if !stack.Driver.TemplatePrepared(context.Background()) {
			return fmt.Errorf("workspace system template is not prepared; run workspace prepare-v2")
		}
		workspaceManager = stack.Manager
		workspaceDriver = workspacev2.LocalBtrfsDriverName
	}
	engine, err := policy.NewWithStoreConfig(*policyPath, password, st, policy.RuntimeConfig{
		AuthenticationMode:     *authMode,
		LocalhostRoot:          *localhostRoot,
		CodexExecutable:        *codexExecutable,
		UsersRoot:              *usersRoot,
		EnforceUserCredentials: *userProcessCredentials,
		WorkspaceManager:       workspaceManager,
		WorkspaceDriver:        workspaceDriver,
		ModelGateway:           providerRegistry,
		ModelGatewayBaseURL:    *modelGatewayBaseURL,
		Telemetry:              telemetryManager,
	})
	if err != nil {
		return err
	}
	defer engine.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("hypernode ingress listening on %s (protocols=ssh,http,websocket,model-gateway stack=%s, db=%s, policy=%s, auth-mode=%s, localhost-root=%s)", *listen, *sshStack, *dbPath, *policyPath, *authMode, *localhostRoot)
	hotUpgradeWatcher := &policy.HotUpgradeWatcher{
		Directory: *policyReleaseDir,
		Interval:  *policyHotPoll,
		Engine:    engine,
	}
	var serveSSH func() error
	if *sshStack == "vssh" {
		srv, rawErr := server.NewRaw(*listen, st, engine)
		if rawErr != nil {
			return rawErr
		}
		serveSSH = func() error { return srv.Serve(ctx) }
	} else {
		srv, sshErr := server.New(server.Options{
			Listen: *listen, HostKey: *hostKey, Store: st, Policy: engine, AllowNone: *allowNone,
		})
		if sshErr != nil {
			return sshErr
		}
		serveSSH = func() error { return srv.Serve(ctx) }
	}
	return runServices(stop, map[string]func() error{
		"ssh server":     serveSSH,
		"policy watcher": func() error { return hotUpgradeWatcher.Run(ctx) },
	})
}

func workspaceCommand(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: hypernode workspace <prepare-v2|status-v2> [options]")
		os.Exit(2)
	}
	action := args[0]
	if action == "prepare-v2" || action == "status-v2" {
		if err := workspaceV2Command(action, args[1:]); err != nil {
			log.Fatal(err)
		}
		return
	}
	fmt.Fprintln(os.Stderr, "usage: hypernode workspace <prepare-v2|status-v2> [options]")
	os.Exit(2)
}

func events(args []string) {
	flags := flag.NewFlagSet("events", flag.ExitOnError)
	dbPath := flags.String("db", ".runtime/hypernode.sqlite", "durable SQLite event store")
	limit := flags.Int("limit", 100, "maximum rows")
	connection := flags.String("connection", "", "optional connection id")
	flags.Parse(args)
	path, _ := filepath.Abs(*dbPath)
	st, err := store.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()
	rows, err := st.Events(*connection, *limit)
	if err != nil {
		log.Fatal(err)
	}
	for _, row := range rows {
		fmt.Printf("%d\t%s\t%s\t%s\t%s\n", row.ID, row.At, row.ConnectionID, row.Type, row.Payload)
	}
}
