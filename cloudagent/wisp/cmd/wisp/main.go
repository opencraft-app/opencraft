package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"wisp/internal/config"
	iruntime "wisp/internal/runtime"
	"wisp/internal/telemetry"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "wisp: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		return usage()
	}

	switch args[0] {
	case "daemon":
		if len(args) < 2 || args[1] != "run" {
			return usage()
		}
		fs := flag.NewFlagSet("daemon run", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		configPath := fs.String("config", config.DefaultConfigPath(), "path to config.jsonnet")
		if err := fs.Parse(args[2:]); err != nil {
			return err
		}
		cfg, err := config.Load(*configPath)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		shutdownTelemetry, err := telemetry.InitStdout(ctx, "wisp-spserver", os.Stdout)
		if err != nil {
			return err
		}
		defer func() { _ = shutdownTelemetry(context.Background()) }()
		return iruntime.NewDaemon(iruntime.New(cfg)).Serve(ctx)
	}

	cfg, err := config.Load(config.DefaultConfigPath())
	if err != nil {
		return err
	}

	switch args[0] {
	case "ls":
		return callAndPrint(cfg, "GET", "/v1/runtime/containers", nil)
	case "status":
		return status(cfg, args[1:])
	case "bootstrap":
		return bootstrap(cfg, args[1:])
	case "workspace":
		return workspace(cfg, args[1:])
	case "create":
		return create(cfg, args[1:])
	case "start":
		return start(cfg, args[1:])
	case "enter":
		return enter(cfg, args[1:])
	case "stop":
		return stop(cfg, args[1:])
	case "destroy":
		return destroy(cfg, args[1:])
	default:
		return usage()
	}
}

func workspace(cfg config.Config, args []string) error {
	if len(args) != 2 || args[0] != "use" {
		return usage()
	}
	configPath := cfg.ConfigFile
	if configPath == "" {
		configPath = config.DefaultConfigPath()
	}
	if err := config.SetWorkspaceLayout(configPath, cfg, args[1]); err != nil {
		return err
	}
	updated, err := config.LoadContainer(configPath, args[1])
	if err != nil {
		return err
	}
	out := map[string]any{
		"ok":                true,
		"message":           "workspace updated",
		"name":              updated.WispName,
		"overlay_config":    updated.OverlayConfigFile,
		"cos_workspace":     updated.COSWorkspace,
		"state_root":        updated.StateRoot,
		"runtime_root":      updated.RuntimeRoot,
		"temp_root":         updated.TempRoot,
		"lower_system":      updated.LowerSystem,
		"lower_system_base": updated.LowerSystemBase,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func bootstrap(cfg config.Config, args []string) error {
	name, err := optionalNameArg(args)
	if err != nil {
		return err
	}
	return callAndPrint(cfg, "POST", "/v1/runtime/bootstrap", runtimeBody(name))
}

func create(cfg config.Config, args []string) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return errors.New("create requires a container name")
	}
	return callAndPrint(cfg, "POST", "/v1/runtime/create", runtimeBody(args[0]))
}

func start(cfg config.Config, args []string) error {
	name, err := optionalNameArg(args)
	if err != nil {
		return err
	}
	return callAndPrint(cfg, "POST", "/v1/runtime/start", runtimeBody(name))
}

func stop(cfg config.Config, args []string) error {
	name, err := optionalNameArg(args)
	if err != nil {
		return err
	}
	return callAndPrint(cfg, "POST", "/v1/runtime/stop", runtimeBody(name))
}

func destroy(cfg config.Config, args []string) error {
	if len(args) != 1 || args[0] == "" {
		return errors.New("destroy requires a container name")
	}
	return callAndPrint(cfg, "POST", "/v1/runtime/destroy", runtimeBody(args[0]))
}

func status(cfg config.Config, args []string) error {
	name, err := optionalNameArg(args)
	if err != nil {
		return err
	}
	path := "/v1/runtime/status"
	if name != "" {
		path += "?name=" + url.QueryEscape(name)
	}
	return callAndPrint(cfg, "GET", path, nil)
}

func enter(cfg config.Config, args []string) error {
	name, err := optionalNameArg(args)
	if err != nil {
		return err
	}
	if name == "" {
		return iruntime.New(cfg).Enter(context.Background())
	}
	rtCfg, err := config.LoadContainer(cfg.ConfigFile, name)
	if err != nil {
		return err
	}
	return iruntime.New(rtCfg).Enter(context.Background())
}

func runtimeBody(name string) map[string]any {
	if name == "" {
		return map[string]any{}
	}
	return map[string]any{"name": name}
}

func optionalNameArg(args []string) (string, error) {
	switch len(args) {
	case 0:
		return "", nil
	case 1:
		return args[0], nil
	default:
		return "", usage()
	}
}

func callAndPrint(cfg config.Config, method, path string, body any) error {
	var out map[string]any
	if err := callWithAutoStart(cfg, method, path, body, &out); err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func callWithAutoStart(cfg config.Config, method, path string, body any, out any) error {
	err := iruntime.CallUnixJSON(context.Background(), cfg.AdminSocketPath, method, path, body, out)
	if err == nil {
		return nil
	}
	if isLocalDaemonUnavailable(err) {
		if startErr := ensureLocalDaemonRunning(cfg); startErr != nil {
			return fmt.Errorf("%w (auto-start daemon failed: %v)", err, startErr)
		}
		err = iruntime.CallUnixJSON(context.Background(), cfg.AdminSocketPath, method, path, body, out)
		if err == nil {
			return nil
		}
	}
	if shouldAutoBootstrap(err) && path != "/v1/runtime/bootstrap" {
		if bootErr := iruntime.CallUnixJSON(context.Background(), cfg.AdminSocketPath, "POST", "/v1/runtime/bootstrap", map[string]any{}, nil); bootErr != nil {
			return fmt.Errorf("%w (auto-bootstrap failed: %v)", err, bootErr)
		}
		return iruntime.CallUnixJSON(context.Background(), cfg.AdminSocketPath, method, path, body, out)
	}
	return err
}

func isLocalDaemonUnavailable(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "dial unix") &&
		(strings.Contains(msg, "connect: no such file or directory") ||
			strings.Contains(msg, "connect: connection refused"))
}

func shouldAutoBootstrap(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "bootstrap_required") ||
		strings.Contains(msg, "run bootstrap first") ||
		strings.Contains(msg, "not bootstrapped")
}

func ensureLocalDaemonRunning(cfg config.Config) error {
	wispPath, err := findSelfWisp()
	if err != nil {
		return err
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer devNull.Close()

	configPath := cfg.ConfigFile
	if strings.TrimSpace(configPath) == "" {
		configPath = config.DefaultConfigPath()
	}

	cmd := exec.Command(wispPath, "daemon", "run", "--config", configPath)
	cmd.Stdout = devNull
	cmd.Stderr = devNull
	cmd.Stdin = devNull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := cmd.Process.Release(); err != nil {
		return err
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var out map[string]any
		if err := iruntime.CallUnixJSON(context.Background(), cfg.AdminSocketPath, "GET", "/v1/runtime/status", nil, &out); err == nil {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for local daemon at %s", cfg.AdminSocketPath)
}

func findSelfWisp() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exeDir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(exeDir, "wisp"),
		filepath.Join(exeDir, "..", "dist", "wisp"),
		filepath.Join(exeDir, "spctl"),
		filepath.Join(exeDir, "..", "dist", "spctl"),
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not locate local wisp launcher near %s", exe)
}

func usage() error {
	fmt.Fprintln(os.Stderr, `usage:
  wisp daemon run [--config path]
  wisp ls
  wisp workspace use <name>
  wisp create <name>
  wisp status [name]
  wisp bootstrap [name]
  wisp start [name]
  wisp enter [name]
  wisp stop [name]
  wisp destroy <name>`)
	return errors.New("invalid command")
}
