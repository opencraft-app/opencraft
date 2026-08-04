package agentcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const (
	localAuthWhoami agentapi.Operation = "local.auth.whoami"
	localUserInfo   agentapi.Operation = "local.user.info"
)

type ClientProvider func(context.Context) (*agentapi.Client, error)

type Environment struct {
	lookup func(string) string
}

func EnvironmentFromLookup(lookup func(string) string) Environment {
	if lookup == nil {
		lookup = func(string) string { return "" }
	}
	return Environment{lookup: lookup}
}

func (e Environment) Get(name string) string {
	if e.lookup == nil {
		return ""
	}
	return e.lookup(name)
}

func (e Environment) First(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(e.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

type Dependencies struct {
	ClientProvider ClientProvider
	Stdin          io.Reader
	Stdout         io.Writer
	Stderr         io.Writer
	Environment    Environment
	Version        string
}

type ExitClass int

const (
	ExitExecution ExitClass = 1
	ExitUsage     ExitClass = 2
)

type CommandError struct {
	Class               ExitClass
	Code                string
	Message             string
	SuggestedNextAction string
	Layer               string
	CorrelationID       string
	Cause               error
}

func (e *CommandError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return "command failed"
}

func (e *CommandError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func NewWithDependencies(dependencies Dependencies) *App {
	if dependencies.Stdin == nil {
		dependencies.Stdin = strings.NewReader("")
	}
	if dependencies.Stdout == nil {
		dependencies.Stdout = io.Discard
	}
	if dependencies.Stderr == nil {
		dependencies.Stderr = io.Discard
	}
	if dependencies.ClientProvider == nil {
		dependencies.ClientProvider = func(context.Context) (*agentapi.Client, error) {
			return nil, errors.New("Agent API client is unavailable")
		}
	}
	if dependencies.Environment.lookup == nil {
		dependencies.Environment = EnvironmentFromLookup(nil)
	}
	return &App{
		dependencies: dependencies,
		stdin:        dependencies.Stdin,
		stdout:       dependencies.Stdout,
		stderr:       dependencies.Stderr,
	}
}

func NewRootCommand(dependencies Dependencies) *cobra.Command {
	return NewWithDependencies(dependencies).newRootCommand()
}

func (a *App) Run(ctx context.Context, args []string) int {
	root := a.newRootCommand()
	root.SetArgs(args)
	resolved, err := root.ExecuteContextC(ctx)
	if err == nil {
		return 0
	}
	return a.renderCommandError(resolved, err)
}

func (a *App) renderCommandError(command *cobra.Command, err error) int {
	class := ExitUsage
	var commandError *CommandError
	if errors.As(err, &commandError) {
		class = commandError.Class
	}
	message := strings.TrimSpace(err.Error())
	if commandError != nil && strings.TrimSpace(commandError.Message) != "" {
		message = strings.TrimSpace(commandError.Message)
	}
	if strings.HasPrefix(message, "Error:") {
		_, _ = fmt.Fprintln(a.stderr, message)
	} else {
		_, _ = fmt.Fprintln(a.stderr, "Error:", message)
	}
	if class == ExitUsage {
		helpPath := "raft"
		if command != nil && command.CommandPath() != "" {
			helpPath = command.CommandPath()
		}
		_, _ = fmt.Fprintf(a.stderr, "Run %q for usage.\n", helpPath+" --help")
	}
	return int(class)
}

func (a *App) newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "raft",
		Short:         "Work from a managed Agent runtime",
		Version:       a.dependencies.Version,
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		RunE:          showCommandHelp,
	}
	root.CompletionOptions.DisableDefaultCmd = true
	root.SetIn(a.stdin)
	root.SetOut(a.stdout)
	root.SetErr(a.stderr)
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return usageError(err)
	})
	root.AddCommand(a.buildVelaCommands()...)
	return root
}

func (a *App) buildVelaCommands() []*cobra.Command {
	return []*cobra.Command{
		a.buildAuthCommands(),
		a.buildVelaChannelCommands(),
		a.buildVelaServerCommands(),
		a.buildUserCommands(),
		a.buildInboxCommands(),
		a.buildVelaMessageCommands(),
		a.buildVelaAttachmentCommands(),
		a.buildVelaTaskCommands(),
		a.buildReminderCommands(),
	}
}

func (a *App) buildVelaChannelCommands() *cobra.Command {
	family := familyCommand("channel", "Inspect visible channels")
	family.AddCommand(
		a.leafCommand("info <target>", "Show a channel", "channel info", agentapi.ServerInfo, cobra.ExactArgs(1)),
		a.leafCommand("members <target>", "List channel members", "channel members", agentapi.ChannelMembers, cobra.ExactArgs(1)),
	)
	return family
}

func (a *App) buildVelaServerCommands() *cobra.Command {
	family := familyCommand("server", "Inspect the current server")
	family.AddCommand(a.leafCommand(
		"info",
		"Show the authorized Server directory",
		"server info",
		agentapi.ServerInfo,
		cobra.NoArgs,
	))
	return family
}

func (a *App) buildVelaMessageCommands() *cobra.Command {
	family := familyCommand("message", "Read and send Tencent IM messages")

	send := a.leafCommand("send", "Send a message", "message send", agentapi.MessageSend, cobra.NoArgs)
	addStringFlag(send, "target", "Channel, thread, or DM destination")
	addStringFlag(send, "text", "Message body; stdin is used when omitted")
	addStringArrayFlag(send, "attachment-id", "Uploaded attachment ID")
	addBoolFlag(send, "json", "Print JSON")
	requireFlag(send, "target")

	check := a.leafCommand("check", "Check message activity", "message check", agentapi.Events, cobra.NoArgs)

	read := a.leafCommand("read", "Read messages", "message read", agentapi.HistoryRead, cobra.NoArgs)
	addStringFlag(read, "target", "Message target")
	addStringFlag(read, "after", "Read after message ID or sequence")
	addStringFlag(read, "around", "Read around message ID")
	addIntFlag(read, "limit", "Maximum messages")
	requireFlag(read, "target")

	search := a.leafCommand("search", "Search messages", "message search", agentapi.MessageSearch, cobra.NoArgs)
	addStringFlag(search, "query", "Search query")
	addStringFlag(search, "target", "Optional message target")
	addIntFlag(search, "limit", "Maximum messages")
	addIntFlag(search, "offset", "Result offset")
	requireFlag(search, "query")

	resolve := a.leafCommand("resolve <id>", "Resolve a message", "message resolve", agentapi.MessageResolve, cobra.ExactArgs(1))

	react := a.leafCommand("react", "Add or remove a reaction", "message react", agentapi.MessageReactionAdd, cobra.NoArgs)
	addStringFlag(react, "message-id", "Message ID")
	addStringFlag(react, "emoji", "Emoji")
	addBoolFlag(react, "remove", "Remove the reaction")
	requireFlag(react, "message-id", "emoji")

	family.AddCommand(send, check, read, search, resolve, react)
	return family
}

func (a *App) buildVelaTaskCommands() *cobra.Command {
	family := familyCommand("task", "Work with tasks assigned to this Agent")
	list := a.leafCommand("list", "List assigned tasks", "task list", agentapi.TaskList, cobra.NoArgs)
	addStringFlag(list, "status", "Task status")
	claim := a.leafCommand("claim", "Claim an assigned task", "task claim", agentapi.TaskClaim, cobra.NoArgs)
	addIntSliceFlag(claim, "number", "Task number")
	requireFlag(claim, "number")
	update := a.leafCommand("update", "Update an assigned task", "task update", agentapi.TaskUpdateStatus, cobra.NoArgs)
	addIntFlag(update, "number", "Task number")
	addStringFlag(update, "status", "New task status")
	requireFlag(update, "number", "status")
	family.AddCommand(list, claim, update)
	return family
}

func (a *App) buildVelaAttachmentCommands() *cobra.Command {
	family := familyCommand("attachment", "Upload and inspect attachments")
	upload := a.leafCommand("upload", "Upload an attachment", "attachment upload", agentapi.AttachmentUpload, cobra.NoArgs)
	addStringFlag(upload, "path", "Local file path")
	addStringFlag(upload, "target", "Destination target")
	addStringFlag(upload, "mime-type", "Override MIME type")
	requireFlag(upload, "path", "target")
	view := a.leafCommand("view [attachment-id]", "Download an attachment", "attachment view", agentapi.AttachmentDownload, cobra.MaximumNArgs(1))
	addStringFlag(view, "id", "Attachment ID")
	addStringFlag(view, "output", "Destination file")
	requireFlag(view, "output")
	family.AddCommand(upload, view)
	return family
}

func showCommandHelp(command *cobra.Command, _ []string) error {
	return command.Help()
}

func usageError(err error) error {
	if err == nil {
		return nil
	}
	return &CommandError{
		Class:   ExitUsage,
		Message: err.Error(),
		Cause:   err,
	}
}

func executionError(err error) error {
	if err == nil {
		return nil
	}
	return &CommandError{
		Class:   ExitExecution,
		Message: err.Error(),
		Cause:   err,
	}
}

func familyCommand(use string, short string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.NoArgs,
		RunE:  showCommandHelp,
	}
}

func (a *App) leafCommand(
	use string,
	short string,
	path string,
	operation agentapi.Operation,
	argsValidator cobra.PositionalArgs,
) *cobra.Command {
	command := &cobra.Command{
		Use:   use,
		Short: short,
		Args: func(command *cobra.Command, args []string) error {
			if err := argsValidator(command, args); err != nil {
				return usageError(err)
			}
			return nil
		},
	}
	command.RunE = func(command *cobra.Command, args []string) error {
		commandArgs, err := commandArguments(command, args)
		if err != nil {
			return usageError(err)
		}
		return a.executeManaged(command.Context(), path, operation, commandArgs)
	}
	return command
}

func commandArguments(command *cobra.Command, positionals []string) ([]string, error) {
	result := append([]string(nil), positionals...)
	var visitErr error
	command.Flags().Visit(func(flag *pflag.Flag) {
		if visitErr != nil || flag.Name == "help" {
			return
		}
		switch flag.Value.Type() {
		case "bool":
			value, err := command.Flags().GetBool(flag.Name)
			if err != nil {
				visitErr = err
				return
			}
			if value {
				result = append(result, "--"+flag.Name)
			}
		case "stringArray":
			values, err := command.Flags().GetStringArray(flag.Name)
			if err != nil {
				visitErr = err
				return
			}
			for _, value := range values {
				result = append(result, "--"+flag.Name, value)
			}
		case "intSlice":
			values, err := command.Flags().GetIntSlice(flag.Name)
			if err != nil {
				visitErr = err
				return
			}
			for _, value := range values {
				result = append(
					result,
					"--"+flag.Name,
					strconv.Itoa(value),
				)
			}
		default:
			result = append(result, "--"+flag.Name, flag.Value.String())
		}
	})
	return result, visitErr
}

func (a *App) executeManaged(
	ctx context.Context,
	path string,
	operation agentapi.Operation,
	args []string,
) error {
	if path == "task list" || path == "task claim" || path == "task update" {
		args = append(append([]string(nil), args...), "--target", "#server")
	}
	invocation := *a
	var captured bytes.Buffer
	invocation.stderr = &captured

	input, err := prepareManagedInput(path, args, a.stdin)
	if err != nil {
		return executionError(err)
	}
	if err := preflightManagedCommand(
		path,
		operation,
		args,
		input.reader,
	); err != nil {
		return usageError(err)
	}
	invocation.stdin = input.executionReader()

	needsClient := path != "auth whoami"
	if needsClient {
		client, err := a.dependencies.ClientProvider(ctx)
		if err != nil {
			return executionError(err)
		}
		invocation.client = client
	}
	exitCode := invocation.runResolved(ctx, path, operation, args)
	if exitCode == 0 {
		return nil
	}
	message := strings.TrimSpace(captured.String())
	if message == "" {
		message = "command failed"
	}
	class := ExitExecution
	if exitCode == int(ExitUsage) {
		class = ExitUsage
	}
	return &CommandError{Class: class, Message: message}
}

func addStringFlag(command *cobra.Command, name string, usage string) {
	command.Flags().String(name, "", usage)
}

func addBoolFlag(command *cobra.Command, name string, usage string) {
	command.Flags().Bool(name, false, usage)
}

func addStringArrayFlag(command *cobra.Command, name string, usage string) {
	command.Flags().StringArray(name, nil, usage)
}

func addIntFlag(command *cobra.Command, name string, usage string) {
	command.Flags().Int(name, 0, usage)
}

func addIntSliceFlag(command *cobra.Command, name string, usage string) {
	command.Flags().IntSlice(name, nil, usage)
}

func requireFlag(command *cobra.Command, names ...string) {
	for _, name := range names {
		if err := command.MarkFlagRequired(name); err != nil {
			panic(err)
		}
	}
}

func (a *App) buildAuthCommands() *cobra.Command {
	family := familyCommand("auth", "Inspect managed Agent authentication")
	family.AddCommand(a.leafCommand(
		"whoami",
		"Show the managed Agent identity",
		"auth whoami",
		localAuthWhoami,
		cobra.NoArgs,
	))
	return family
}

func (a *App) buildUserCommands() *cobra.Command {
	family := familyCommand("user", "Inspect server users")
	info := a.leafCommand("info <name>", "Show a visible user", "user info", localUserInfo, cobra.ExactArgs(1))
	family.AddCommand(info)
	return family
}

func (a *App) buildInboxCommands() *cobra.Command {
	family := familyCommand("inbox", "Inspect the Agent inbox")
	family.AddCommand(a.leafCommand("check", "Check the inbox", "inbox check", agentapi.InboxCheck, cobra.NoArgs))
	return family
}

func (a *App) buildReminderCommands() *cobra.Command {
	family := familyCommand("reminder", "Schedule and manage reminders")

	schedule := a.leafCommand("schedule", "Schedule a reminder", "reminder schedule", agentapi.ReminderCreate, cobra.NoArgs)
	addStringFlag(schedule, "title", "Reminder title")
	addIntFlag(schedule, "delay-seconds", "Delay in seconds")
	addStringFlag(schedule, "fire-at", "Absolute fire time")
	addStringFlag(schedule, "repeat", "Repeat cadence")
	addStringFlag(schedule, "tz", "Time zone")
	addStringFlag(schedule, "channel", "Receipt channel")
	addStringFlag(schedule, "message-id", "Related message ID")
	requireFlag(schedule, "title")

	list := a.leafCommand("list", "List reminders", "reminder list", agentapi.ReminderList, cobra.NoArgs)
	addBoolFlag(list, "all", "Include inactive reminders")
	addStringFlag(list, "status", "Reminder status")

	cancel := a.leafCommand("cancel", "Cancel a reminder", "reminder cancel", agentapi.ReminderCancel, cobra.NoArgs)
	addStringFlag(cancel, "id", "Reminder ID")
	requireFlag(cancel, "id")

	snooze := a.leafCommand("snooze", "Snooze a reminder", "reminder snooze", agentapi.ReminderSnooze, cobra.NoArgs)
	addStringFlag(snooze, "id", "Reminder ID")
	addStringFlag(snooze, "by", "Snooze duration")
	requireFlag(snooze, "id", "by")

	update := a.leafCommand("update", "Update a reminder", "reminder update", agentapi.ReminderUpdate, cobra.NoArgs)
	addStringFlag(update, "id", "Reminder ID")
	addStringFlag(update, "fire-at", "Absolute fire time")
	addStringFlag(update, "in", "Relative fire time")
	addStringFlag(update, "cadence", "Repeat cadence")
	addStringFlag(update, "title", "Reminder title")
	requireFlag(update, "id")

	log := a.leafCommand("log", "Show reminder delivery log", "reminder log", agentapi.ReminderLog, cobra.NoArgs)
	addStringFlag(log, "id", "Reminder ID")
	requireFlag(log, "id")

	family.AddCommand(schedule, list, cancel, snooze, update, log)
	return family
}
