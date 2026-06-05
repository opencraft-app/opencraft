package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"wisp/internal/config"
	iruntime "wisp/internal/runtime"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "wispenv: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		return usage()
	}
	socketPath := defaultEnvSocketPath()
	switch args[0] {
	case "info":
		var out map[string]any
		if err := iruntime.CallUnixJSON(context.Background(), socketPath, "GET", "/info", nil, &out); err != nil {
			return err
		}
		return printJSON(out)
	case "checkpoint":
		return checkpoint(socketPath, args[1:])
	default:
		return usage()
	}
}

func usage() error {
	fmt.Fprintln(os.Stderr, `usage:
  wispenv info
  wispenv checkpoint list
  wispenv checkpoint get <id>
  wispenv checkpoint create <id>
  wispenv checkpoint restore <id>
  wispenv checkpoint delete <id>`)
	return errors.New("invalid command")
}

func checkpoint(socketPath string, args []string) error {
	if len(args) == 0 {
		return usage()
	}
	ctx := context.Background()
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return usage()
		}
		var out map[string]any
		if err := iruntime.CallUnixJSON(ctx, socketPath, "GET", "/checkpoints", nil, &out); err != nil {
			return err
		}
		return printJSON(out)
	case "get":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return usage()
		}
		var out map[string]any
		if err := iruntime.CallUnixJSON(ctx, socketPath, "GET", "/checkpoints/"+args[1], nil, &out); err != nil {
			return err
		}
		return printJSON(out)
	case "create":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return usage()
		}
		var out map[string]any
		if err := iruntime.CallUnixJSON(ctx, socketPath, "POST", "/checkpoints", map[string]any{"checkpoint": args[1]}, &out); err != nil {
			return err
		}
		return printJSON(out)
	case "restore":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return usage()
		}
		var out map[string]any
		if err := iruntime.CallUnixJSON(ctx, socketPath, "POST", "/checkpoints/"+args[1]+"/restore", nil, &out); err != nil {
			return err
		}
		return printJSON(out)
	case "delete":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return usage()
		}
		var out map[string]any
		if err := iruntime.CallUnixJSON(ctx, socketPath, "DELETE", "/checkpoints/"+args[1], nil, &out); err != nil {
			return err
		}
		return printJSON(out)
	default:
		return usage()
	}
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func defaultEnvSocketPath() string {
	if path := strings.TrimSpace(os.Getenv("ENV_SOCKET_PATH")); path != "" {
		return path
	}
	if cfg, err := config.Load(config.DefaultConfigPath()); err == nil && strings.TrimSpace(cfg.EnvSocketPath) != "" {
		return cfg.EnvSocketPath
	}
	return "/.wisp/api.sock"
}
