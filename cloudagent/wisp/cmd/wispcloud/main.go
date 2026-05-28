package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"wisp/pkg/wispcloud"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "wispcloud: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return usage()
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "create":
		return create(ctx, os.Args[2:])
	case "info":
		return info(os.Args[2:])
	case "exec":
		return execCommand(ctx, os.Args[2:])
	case "stop":
		return stopRuntime(ctx, os.Args[2:])
	case "delete":
		return deleteEnvironment(ctx, os.Args[2:])
	default:
		return usage()
	}
}

func usage() error {
	fmt.Fprintln(os.Stderr, `usage:
  wispcloud create [--workspace-id <id>] [--template <id>] [--package-url <url>] [--root-upper-size 5G]
  wispcloud info --workspace-id <id>
  wispcloud exec --workspace-id <id> -- <command>
  wispcloud stop --workspace-id <id>
  wispcloud delete --workspace-id <id>

State is stored under WISPCLOUD_STATE_DIR, or ~/.wispcloud/environments.`)
	return errors.New("invalid command")
}

func create(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("create", flag.ContinueOnError)
	workspaceID := fs.String("workspace-id", "", "existing SMH workspace/space id to reuse")
	templateID := fs.String("template", firstEnv("GATEWAY_AGS_TEMPLATE", "INNER_SANDBOX_TEMPLATE", "E2B_TEMPLATE"), "AGS template id")
	packageURL := fs.String("package-url", firstEnv("WISP_SDK_PACKAGE_URL", "WISP_FAST_PACKAGE_URL", "WISP_PACKAGE_URL"), "Wisp release package URL")
	rootUpperSize := fs.String("root-upper-size", "5G", "root upper image size")
	jfsPrefix := fs.String("jfs-prefix", "workspace-wisp-sdk", "JuiceFS prefix")
	timeout := fs.Int("timeout-seconds", 900, "sandbox timeout seconds")
	if err := fs.Parse(args); err != nil {
		return err
	}
	sdk, err := newSDK()
	if err != nil {
		return err
	}
	env, err := sdk.Create(ctx, wispcloud.WispEnvironmentOptions{
		WorkspaceID:           *workspaceID,
		TemplateID:            *templateID,
		PackageURL:            *packageURL,
		JFSPrefix:             *jfsPrefix,
		RootUpperSize:         *rootUpperSize,
		SandboxTimeoutSeconds: *timeout,
		Metadata:              map[string]string{"purpose": "wispcloud-cli"},
	})
	if err != nil {
		return err
	}
	if err := saveState(env.State()); err != nil {
		return err
	}
	return printJSON(env.Info())
}

func info(args []string) error {
	fs := flag.NewFlagSet("info", flag.ContinueOnError)
	workspaceID := fs.String("workspace-id", "", "workspace id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	state, err := loadState(*workspaceID)
	if err != nil {
		return err
	}
	return printJSON(state)
}

func execCommand(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("exec", flag.ContinueOnError)
	workspaceID := fs.String("workspace-id", "", "workspace id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) > 0 && rest[0] == "--" {
		rest = rest[1:]
	}
	if len(rest) == 0 {
		return errors.New("exec requires a command after --")
	}
	env, err := loadAttachedEnvironment(*workspaceID)
	if err != nil {
		return err
	}
	out, err := env.ExecShell(ctx, strings.Join(rest, " "))
	if err != nil {
		return err
	}
	fmt.Print(out.Stdout)
	if out.Stderr != "" {
		fmt.Fprint(os.Stderr, out.Stderr)
	}
	if out.ExitCode != 0 {
		return fmt.Errorf("command exited with code %d", out.ExitCode)
	}
	return nil
}

func stopRuntime(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	workspaceID := fs.String("workspace-id", "", "workspace id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	env, err := loadAttachedEnvironment(*workspaceID)
	if err != nil {
		return err
	}
	out, err := env.Stop(ctx)
	if err != nil {
		return err
	}
	fmt.Print(out.Stdout)
	if out.Stderr != "" {
		fmt.Fprint(os.Stderr, out.Stderr)
	}
	return nil
}

func deleteEnvironment(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("delete", flag.ContinueOnError)
	workspaceID := fs.String("workspace-id", "", "workspace id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	env, err := loadAttachedEnvironment(*workspaceID)
	if err != nil {
		return err
	}
	if err := env.Delete(ctx); err != nil {
		return err
	}
	return os.Remove(statePath(env.Workspace()))
}

func newSDK() (*wispcloud.WispEnvironmentSDK, error) {
	ags, err := wispcloud.NewAGSClient(wispcloud.AGSClientConfig{
		APIKey:         firstEnv("GATEWAY_AGS_API_KEY", "E2B_API_KEY"),
		Domain:         firstEnv("GATEWAY_AGS_DOMAIN", "E2B_DOMAIN"),
		APIURL:         firstEnv("GATEWAY_AGS_API_URL", "E2B_API_URL"),
		RequestTimeout: envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 5*time.Minute),
	})
	if err != nil {
		return nil, err
	}
	smh, err := wispcloud.NewSMHClient(wispcloud.SMHClientConfig{})
	if err != nil {
		return nil, err
	}
	return wispcloud.NewWispEnvironmentSDK(wispcloud.WispEnvironmentSDKConfig{AGSClient: ags, SMHClient: smh})
}

func loadAttachedEnvironment(workspaceID string) (*wispcloud.WispEnvironment, error) {
	state, err := loadState(workspaceID)
	if err != nil {
		return nil, err
	}
	sdk, err := newSDK()
	if err != nil {
		return nil, err
	}
	return sdk.Attach(state), nil
}

func saveState(state wispcloud.WispEnvironmentState) error {
	if strings.TrimSpace(state.WorkspaceID) == "" {
		return errors.New("state missing workspace id")
	}
	if err := os.MkdirAll(stateDir(), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(statePath(state.WorkspaceID), raw, 0o600)
}

func loadState(workspaceID string) (wispcloud.WispEnvironmentState, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return wispcloud.WispEnvironmentState{}, errors.New("workspace id is required")
	}
	raw, err := os.ReadFile(statePath(workspaceID))
	if err != nil {
		return wispcloud.WispEnvironmentState{}, err
	}
	var state wispcloud.WispEnvironmentState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wispcloud.WispEnvironmentState{}, err
	}
	return state, nil
}

func statePath(workspaceID string) string {
	name := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, workspaceID)
	return filepath.Join(stateDir(), name+".json")
}

func stateDir() string {
	if dir := strings.TrimSpace(os.Getenv("WISPCLOUD_STATE_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return filepath.Join(os.TempDir(), "wispcloud", "environments")
	}
	return filepath.Join(home, ".wispcloud", "environments")
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func envDurationSeconds(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var seconds int
	if _, err := fmt.Sscanf(value, "%d", &seconds); err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}
