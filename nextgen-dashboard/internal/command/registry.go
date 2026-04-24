package command

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
)

type Mode string

const (
	ModeCommand Mode = "command"
	ModeShell   Mode = "shell"
)

type Result struct {
	Mode   Mode   `json:"mode"`
	Output string `json:"output"`
}

type Registry struct {
	provider data.Provider
}

func NewRegistry(provider data.Provider) *Registry {
	return &Registry{provider: provider}
}

func (r *Registry) Execute(ctx context.Context, line string) (Result, error) {
	args := strings.Fields(strings.TrimSpace(line))
	if len(args) == 0 {
		return Result{Mode: ModeCommand, Output: ""}, nil
	}

	jsonOutput := stripJSONFlag(&args)

	switch args[0] {
	case "help":
		return Result{Mode: ModeCommand, Output: helpText()}, nil
	case "shell":
		return Result{
			Mode:   ModeShell,
			Output: "Switching to shell mode. Type `exit` to return.\n",
		}, nil
	case "users":
		return r.executeUsers(ctx, args[1:], jsonOutput)
	case "subscriptions":
		return r.executeSubscriptions(ctx, args[1:], jsonOutput)
	case "sandboxes":
		return r.executeSandboxes(ctx, args[1:], jsonOutput)
	default:
		return Result{Mode: ModeCommand, Output: fmt.Sprintf("Unknown command: %s\n", args[0])}, nil
	}
}

func stripJSONFlag(args *[]string) bool {
	jsonOutput := false
	filtered := (*args)[:0]
	for _, arg := range *args {
		if arg == "--json" {
			jsonOutput = true
			continue
		}
		filtered = append(filtered, arg)
	}
	*args = filtered
	return jsonOutput
}

func (r *Registry) executeUsers(ctx context.Context, args []string, jsonOutput bool) (Result, error) {
	if len(args) == 0 {
		return Result{Mode: ModeCommand, Output: "Usage: users list|get <id>\n"}, nil
	}

	switch args[0] {
	case "list":
		users, err := r.provider.ListUsers(ctx)
		if err != nil {
			return Result{}, err
		}
		if jsonOutput {
			return jsonResult(users)
		}
		var buf bytes.Buffer
		tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tNAME\tEMAIL\tPHONE\tCREATED")
		for _, user := range users {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", user.ID, user.Name, emptyDash(user.Email), emptyDash(user.Phone), user.CreatedAt.Format(time.RFC3339))
		}
		_ = tw.Flush()
		return Result{Mode: ModeCommand, Output: buf.String()}, nil
	case "get":
		if len(args) < 2 {
			return Result{Mode: ModeCommand, Output: "Usage: users get <id>\n"}, nil
		}
		user, err := r.provider.GetUser(ctx, args[1])
		if err != nil {
			if err == sql.ErrNoRows {
				return Result{Mode: ModeCommand, Output: "User not found.\n"}, nil
			}
			return Result{}, err
		}
		if jsonOutput {
			return jsonResult(user)
		}
		return Result{Mode: ModeCommand, Output: fmt.Sprintf(
			"ID: %s\nName: %s\nEmail: %s\nPhone: %s\nInvite Required: %t\nCreated At: %s\n",
			user.ID,
			user.Name,
			emptyDash(user.Email),
			emptyDash(user.Phone),
			user.InviteRequired,
			user.CreatedAt.Format(time.RFC3339),
		)}, nil
	default:
		return Result{Mode: ModeCommand, Output: "Usage: users list|get <id>\n"}, nil
	}
}

func (r *Registry) executeSubscriptions(ctx context.Context, args []string, jsonOutput bool) (Result, error) {
	if len(args) == 0 || args[0] != "list" {
		return Result{Mode: ModeCommand, Output: "Usage: subscriptions list\n"}, nil
	}
	subscriptions, err := r.provider.ListSubscriptions(ctx)
	if err != nil {
		return Result{}, err
	}
	if jsonOutput {
		return jsonResult(subscriptions)
	}
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "USER ID\tTIER\tCONFIRMED")
	for _, subscription := range subscriptions {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", subscription.UserID, subscription.Tier, subscription.ConfirmedAt.Format(time.RFC3339))
	}
	_ = tw.Flush()
	return Result{Mode: ModeCommand, Output: buf.String()}, nil
}

func (r *Registry) executeSandboxes(ctx context.Context, args []string, jsonOutput bool) (Result, error) {
	if len(args) == 0 || args[0] != "list" {
		return Result{Mode: ModeCommand, Output: "Usage: sandboxes list\n"}, nil
	}
	sandboxes, err := r.provider.ListSandboxes(ctx)
	if err != nil {
		return Result{}, err
	}
	if jsonOutput {
		return jsonResult(sandboxes)
	}
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tPOOL\tINSTANCE\tCREATED")
	for _, sandbox := range sandboxes {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", sandbox.ID, sandbox.PoolID, sandbox.InstanceID, sandbox.CreatedAt.Format(time.RFC3339))
	}
	_ = tw.Flush()
	return Result{Mode: ModeCommand, Output: buf.String()}, nil
}

func jsonResult(value any) (Result, error) {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return Result{}, err
	}
	return Result{Mode: ModeCommand, Output: string(payload)}, nil
}

func emptyDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

func helpText() string {
	return strings.TrimSpace(`
Available commands:
  help
  users list [--json]
  users get <id> [--json]
  subscriptions list [--json]
  sandboxes list [--json]
  shell
`) + "\n"
}

