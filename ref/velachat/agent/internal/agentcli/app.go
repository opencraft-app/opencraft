package agentcli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"velachat/agent/internal/agentapi"
	"velachat/agent/internal/common"
)

type Options struct {
	Client *agentapi.Client
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

type App struct {
	dependencies Dependencies
	client       *agentapi.Client
	stdin        io.Reader
	stdout       io.Writer
	stderr       io.Writer
}

func New(options Options) *App {
	return NewWithDependencies(Dependencies{
		ClientProvider: func(context.Context) (*agentapi.Client, error) {
			if options.Client == nil {
				return nil, errors.New("Agent API client is unavailable")
			}
			return options.Client, nil
		},
		Stdin:       options.Stdin,
		Stdout:      options.Stdout,
		Stderr:      options.Stderr,
		Environment: EnvironmentFromLookup(os.Getenv),
	})
}

func NewFromEnvironment(stdout io.Writer, stderr io.Writer) (*App, error) {
	return NewFromEnvironmentWithVersion(stdout, stderr, ""), nil
}

func NewFromEnvironmentWithVersion(
	stdout io.Writer,
	stderr io.Writer,
	version string,
) *App {
	environment := EnvironmentFromLookup(os.Getenv)
	return NewWithDependencies(Dependencies{
		ClientProvider: func(context.Context) (*agentapi.Client, error) {
			proxyURL := environment.First(
				"VELA_AGENT_PROXY_URL",
				"VELA_AGENT_PROXY_URL",
			)
			tokenFile := environment.First(
				"VELA_AGENT_PROXY_TOKEN_FILE",
				"VELA_AGENT_PROXY_TOKEN_FILE",
			)
			if proxyURL == "" || tokenFile == "" {
				return nil, errors.New("Agent proxy environment is missing")
			}
			return agentapi.New(agentapi.ClientOptions{
				BaseURL:   proxyURL,
				TokenFile: tokenFile,
			})
		},
		Stdin:       os.Stdin,
		Stdout:      stdout,
		Stderr:      stderr,
		Environment: environment,
		Version:     version,
	})
}

func (a *App) runResolved(
	ctx context.Context,
	commandPath string,
	operation agentapi.Operation,
	args []string,
) int {
	switch operation {
	case localAuthWhoami:
		return a.runAuthWhoami(args)
	case localUserInfo:
		return a.runUserInfo(ctx, args)
	}
	if a.client == nil {
		_, _ = fmt.Fprintln(a.stderr, "Agent API client is unavailable")
		return 1
	}
	switch commandPath {
	case "server info":
		return a.runServerInfo(ctx, args)
	case "inbox check":
		return a.runInboxCheck(ctx, args)
	case "message check":
		return a.runMessageCheck(ctx, args)
	case "message read":
		return a.runMessageRead(ctx, args)
	case "message search":
		return a.runMessageSearch(ctx, args)
	case "message resolve":
		return a.runMessageResolve(ctx, args)
	case "message react":
		return a.runMessageReact(ctx, args)
	case "attachment upload":
		return a.uploadAttachment(ctx, args)
	case "message send":
		return a.runMessageSend(ctx, args)
	case "attachment view":
		return a.downloadAttachment(ctx, args)
	case "channel members":
		return a.runChannelMembers(ctx, args)
	case "channel info":
		return a.runChannelInfo(ctx, args)
	case "task list", "task claim", "task update":
		return a.runTaskCommand(
			ctx,
			commandPath,
			operation,
			args,
		)
	case "reminder schedule", "reminder list", "reminder cancel",
		"reminder snooze", "reminder update", "reminder log":
		return a.runReminderCommand(
			ctx,
			commandPath,
			operation,
			args,
		)
	default:
		_, _ = fmt.Fprintf(a.stderr, "unsupported Agent command %q\n", commandPath)
		return 2
	}
}

type observedArgs struct {
	positionals []string
	values      map[string][]string
	booleans    map[string]bool
}

func (a *App) runAuthWhoami(args []string) int {
	if len(args) > 0 {
		_, _ = fmt.Fprintf(a.stderr, "unexpected argument %q\n", args[0])
		return 2
	}
	agentID := strings.TrimSpace(os.Getenv("VELA_AGENT_ID"))
	proxyURL := strings.TrimSpace(os.Getenv("VELA_AGENT_PROXY_URL"))
	serverID := strings.TrimSpace(os.Getenv("VELA_SERVER_ID"))
	tokenFile := strings.TrimSpace(os.Getenv("VELA_AGENT_PROXY_TOKEN_FILE"))
	tokenLiteral := strings.TrimSpace(os.Getenv("VELA_AGENT_PROXY_TOKEN"))
	if agentID == "" || proxyURL == "" || tokenFile == "" && tokenLiteral == "" {
		_, _ = fmt.Fprintln(a.stderr, "managed Agent context is incomplete")
		return 1
	}
	var projectedServerID any
	if serverID != "" {
		projectedServerID = serverID
	}
	secretSource := "agent-proxy-token-env"
	if tokenFile != "" {
		secretSource = "agent-proxy-token-file"
	}
	data, err := common.Marshal(map[string]any{
		"ok": true,
		"data": map[string]any{
			"agentId":      agentID,
			"serverUrl":    proxyURL,
			"serverId":     projectedServerID,
			"clientMode":   "managed-runner",
			"secretSource": secretSource,
		},
	})
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(a.stdout, string(data))
	return 0
}

func noOptionRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	return agentapi.Request{
		Path:  make(map[string]string),
		Query: make(url.Values),
	}, nil
}

func (a *App) runServerInfo(ctx context.Context, args []string) int {
	_, err := noOptionRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var inventory map[string]any
	if err := a.client.Call(
		ctx,
		agentapi.ServerInfo,
		agentapi.Request{Path: make(map[string]string), Query: make(url.Values)},
		&inventory,
	); err != nil {
		return a.writeAgentAPICommandError(err, "INFO_FAILED", false)
	}
	text, err := formatVelaServerDirectory(inventory)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprint(a.stdout, text)
	return 0
}

func (a *App) runUserInfo(ctx context.Context, args []string) int {
	if a.client == nil {
		_, _ = fmt.Fprintln(a.stderr, "Agent API client is unavailable")
		return 1
	}
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	if err := parsed.allow(); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	if len(parsed.positionals) != 1 {
		_, _ = fmt.Fprintln(a.stderr, "user info requires exactly one name")
		return 2
	}
	name := strings.TrimPrefix(strings.TrimSpace(parsed.positionals[0]), "@")
	if name == "" {
		_, _ = fmt.Fprintln(a.stderr, "user name is required")
		return 2
	}
	var inventory serverInventoryView
	if err := a.client.Call(
		ctx,
		agentapi.ServerInfo,
		agentapi.Request{Path: make(map[string]string), Query: make(url.Values)},
		&inventory,
	); err != nil {
		return a.writeAgentAPICommandError(err, "INFO_FAILED", false)
	}
	kind := ""
	var user *channelMember
	for _, candidate := range inventory.Agents {
		if strings.EqualFold(candidate.Name, name) {
			candidate := candidate
			kind, user = "agent", &candidate
			break
		}
	}
	if user == nil {
		for _, candidate := range inventory.Humans {
			if strings.EqualFold(candidate.Name, name) {
				candidate := candidate
				kind, user = "human", &candidate
				break
			}
		}
	}
	if user == nil {
		return a.writeCommandError(
			"User not found or not visible: @"+name,
			"NOT_FOUND",
			"Run `vela server info` to inspect visible users.",
		)
	}
	text := formatVelaUserInfo(kind, *user)
	_, _ = fmt.Fprint(a.stdout, text)
	return 0
}

func (a *App) writeResult(result map[string]any) int {
	data, err := common.Marshal(result)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(a.stdout, string(data))
	return 0
}

func channelMembersRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) != 1 || strings.TrimSpace(parsed.positionals[0]) == "" {
		return agentapi.Request{}, errors.New("channel members requires one target")
	}
	query := make(url.Values)
	query.Set("channel", parsed.positionals[0])
	return agentapi.Request{Path: make(map[string]string), Query: query}, nil
}

func channelInfoRequest(args []string) (agentapi.Request, error) {
	_, _, err := parseChannelInfoTarget(args)
	if err != nil {
		return agentapi.Request{}, err
	}
	return agentapi.Request{Path: make(map[string]string), Query: make(url.Values)}, nil
}

func parseChannelInfoTarget(args []string) (string, string, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return "", "", err
	}
	if err := parsed.allow(); err != nil {
		return "", "", err
	}
	if len(parsed.positionals) != 1 {
		return "", "", errors.New("channel info requires one target")
	}
	target := strings.TrimSpace(parsed.positionals[0])
	if !strings.HasPrefix(target, "#") {
		target = "#" + target
	}
	target, err = regularChannelTarget(target)
	if err != nil {
		return "", "", err
	}
	return target, strings.TrimPrefix(target, "#"), nil
}

func regularChannelTarget(raw string) (string, error) {
	target := strings.TrimSpace(raw)
	if !strings.HasPrefix(target, "#") || len(target) < 2 || strings.Contains(target, ":") {
		return "", errors.New("channel target must look like #channel")
	}
	return target, nil
}

func (a *App) runChannelMembers(ctx context.Context, args []string) int {
	request, err := channelMembersRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result map[string]any
	if err := a.client.Call(
		ctx,
		agentapi.ChannelMembers,
		request,
		&result,
	); err != nil {
		return a.writeAgentAPICommandError(err, "MEMBERS_FAILED", false)
	}
	text, err := formatChannelMembersResult(result)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprint(a.stdout, text)
	return 0
}

func (a *App) runChannelInfo(ctx context.Context, args []string) int {
	target, channelName, err := parseChannelInfoTarget(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var serverInfo channelServerInfo
	if err := a.client.Call(
		ctx,
		agentapi.ServerInfo,
		agentapi.Request{Path: make(map[string]string), Query: make(url.Values)},
		&serverInfo,
	); err != nil {
		return a.writeAgentAPICommandError(err, "INFO_FAILED", false)
	}
	var found *channelView
	for index := range serverInfo.Channels {
		if serverInfo.Channels[index].Name == channelName {
			found = &serverInfo.Channels[index]
			break
		}
	}
	if found == nil {
		return a.writeCommandError(
			"Channel not found or not visible: "+target,
			"NOT_FOUND",
			"Run `vela server info` to inspect visible channels, or ask a channel member to add you if this is private.",
		)
	}

	var memberCounts *channelMemberCounts
	var members channelMembersView
	membersErr := a.client.Call(
		ctx,
		agentapi.ChannelMembers,
		agentapi.Request{
			Path:  make(map[string]string),
			Query: url.Values{"channel": []string{"#" + channelName}},
		},
		&members,
	)
	if membersErr == nil {
		memberCounts = &channelMemberCounts{
			Agents: len(members.Agents),
			Humans: len(members.Humans),
		}
	}
	_, _ = fmt.Fprint(a.stdout, formatChannelInfo(*found, memberCounts))
	return 0
}

func (a *App) runReminderCommand(
	ctx context.Context,
	commandPath string,
	operation agentapi.Operation,
	args []string,
) int {
	var request agentapi.Request
	var err error
	switch commandPath {
	case "reminder schedule":
		request, err = reminderScheduleRequest(args)
	case "reminder list":
		request, err = reminderListRequest(args)
	case "reminder cancel", "reminder log":
		request, err = reminderIDRequest(args)
	case "reminder snooze":
		request, err = reminderSnoozeRequest(args)
	case "reminder update":
		request, err = reminderUpdateRequest(args)
	}
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	reminderID := request.Path["reminderId"]
	if reminderID != "" && len(reminderID) < 32 {
		query := make(url.Values)
		if commandPath == "reminder update" || commandPath == "reminder log" {
			query.Set("all", "true")
		} else {
			query.Set("status", "scheduled,fired")
		}
		var list struct {
			Reminders []struct {
				ID         string `json:"id"`
				ReminderID string `json:"reminderId"`
			} `json:"reminders"`
		}
		if err := a.client.Call(
			ctx,
			agentapi.ReminderList,
			agentapi.Request{
				Path:  make(map[string]string),
				Query: query,
			},
			&list,
		); err != nil {
			return a.writeAgentAPICommandError(
				err,
				reminderCommandErrorCode(commandPath),
				false,
			)
		}
		matches := make([]string, 0, 1)
		for _, reminder := range list.Reminders {
			candidate := reminder.ReminderID
			if strings.HasPrefix(candidate, reminderID) {
				matches = append(matches, candidate)
			}
		}
		if len(matches) == 0 {
			scope := "reminder"
			if commandPath != "reminder update" &&
				commandPath != "reminder log" {
				scope = "scheduled/fired reminder"
			}
			return a.writeCommandError(
				"No "+scope+" matches id prefix '"+reminderID+"'.",
				"NOT_FOUND",
				"",
			)
		}
		if len(matches) > 1 {
			return a.writeCommandError(
				fmt.Sprintf(
					"Ambiguous id prefix '%s' matches %d reminders; pass a longer id.",
					reminderID,
					len(matches),
				),
				"AMBIGUOUS",
				"",
			)
		}
		request.Path["reminderId"] = matches[0]
	}
	var result map[string]any
	if err := a.client.Call(ctx, operation, request, &result); err != nil {
		return a.writeAgentAPICommandError(
			err,
			reminderCommandErrorCode(commandPath),
			false,
		)
	}
	text, err := formatReminderCommandResult(commandPath, result)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(a.stdout, text)
	return 0
}

func reminderCommandErrorCode(commandPath string) string {
	return map[string]string{
		"reminder schedule": "SCHEDULE_FAILED",
		"reminder list":     "LIST_FAILED",
		"reminder cancel":   "CANCEL_FAILED",
		"reminder snooze":   "SNOOZE_FAILED",
		"reminder update":   "UPDATE_FAILED",
		"reminder log":      "LOG_FAILED",
	}[commandPath]
}

func reminderScheduleRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--title",
		"--delay-seconds",
		"--fire-at",
		"--repeat",
		"--tz",
		"--channel",
		"--message-id",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	title := strings.TrimSpace(parsed.last("--title"))
	if title == "" {
		return agentapi.Request{}, errors.New("--title is required")
	}
	delayRaw := strings.TrimSpace(parsed.last("--delay-seconds"))
	fireAt := strings.TrimSpace(parsed.last("--fire-at"))
	if (delayRaw == "") == (fireAt == "") {
		return agentapi.Request{}, errors.New("provide exactly one of --delay-seconds or --fire-at")
	}
	messageID := strings.TrimSpace(parsed.last("--message-id"))
	if messageID == "" {
		return agentapi.Request{}, errors.New("--message-id is required")
	}
	body := map[string]any{
		"title": title,
		"msgId": messageID,
	}
	if delayRaw != "" {
		delay, err := positiveFloat("--delay-seconds", delayRaw)
		if err != nil {
			return agentapi.Request{}, err
		}
		body["delaySeconds"] = delay
	} else {
		body["fireAt"] = fireAt
	}
	for flag, key := range map[string]string{
		"--repeat":  "repeat",
		"--tz":      "tz",
		"--channel": "channel",
	} {
		if value := parsed.last(flag); value != "" {
			body[key] = value
		}
	}
	return bodyRequest(body), nil
}

func reminderListRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, map[string]bool{"--all": true})
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--all", "--status"); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	status := strings.TrimSpace(parsed.last("--status"))
	if status == "" {
		status = "scheduled,fired"
	}
	for _, value := range strings.Split(status, ",") {
		switch strings.TrimSpace(value) {
		case "scheduled", "fired", "canceled":
		default:
			return agentapi.Request{}, fmt.Errorf("invalid reminder status %q", value)
		}
	}
	query := make(url.Values)
	if parsed.booleans["--all"] && parsed.last("--status") == "" {
		query.Set("all", "true")
	} else {
		query.Set("status", status)
	}
	return agentapi.Request{Path: make(map[string]string), Query: query}, nil
}

func reminderIDRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--id"); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	reminderID := strings.TrimSpace(parsed.last("--id"))
	if reminderID == "" {
		return agentapi.Request{}, errors.New("--id is required")
	}
	return agentapi.Request{
		Path:  map[string]string{"reminderId": reminderID},
		Query: make(url.Values),
	}, nil
}

func reminderSnoozeRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--id", "--by"); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	reminderID := strings.TrimSpace(parsed.last("--id"))
	if reminderID == "" {
		return agentapi.Request{}, errors.New("--id is required")
	}
	delay, err := durationSeconds("--by", parsed.last("--by"))
	if err != nil {
		return agentapi.Request{}, err
	}
	request := bodyRequest(map[string]any{"delaySeconds": delay})
	request.Path["reminderId"] = reminderID
	return request, nil
}

func reminderUpdateRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--id",
		"--fire-at",
		"--in",
		"--cadence",
		"--title",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	reminderID := strings.TrimSpace(parsed.last("--id"))
	if reminderID == "" {
		return agentapi.Request{}, errors.New("--id is required")
	}
	mutations := 0
	for _, flag := range []string{"--fire-at", "--in", "--cadence", "--title"} {
		if _, present := parsed.values[flag]; present {
			mutations++
		}
	}
	if mutations != 1 {
		return agentapi.Request{}, errors.New(
			"pass exactly one of --fire-at, --in, --cadence, or --title",
		)
	}
	body := make(map[string]any)
	if fireAt, present := parsed.values["--fire-at"]; present {
		body["fireAt"] = fireAt[len(fireAt)-1]
	}
	if relative, present := parsed.values["--in"]; present {
		delay, err := durationSeconds("--in", relative[len(relative)-1])
		if err != nil {
			return agentapi.Request{}, err
		}
		body["delaySeconds"] = delay
	}
	if cadence, present := parsed.values["--cadence"]; present {
		body["repeat"] = cadence[len(cadence)-1]
		if zone := time.Now().Location().String(); zone != "Local" {
			body["tz"] = zone
		}
	}
	if titles, present := parsed.values["--title"]; present {
		body["title"] = titles[len(titles)-1]
	}
	request := bodyRequest(body)
	request.Path["reminderId"] = reminderID
	return request, nil
}

func positiveFloat(flag string, raw string) (float64, error) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive number; got %s", flag, raw)
	}
	return value, nil
}

func durationSeconds(flag string, raw string) (float64, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasSuffix(raw, "d") {
		days, err := positiveFloat(flag, strings.TrimSuffix(raw, "d"))
		if err != nil {
			return 0, err
		}
		return days * 24 * 60 * 60, nil
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration like 30m, 2h, or 1d", flag)
	}
	return duration.Seconds(), nil
}

func taskListRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--target", "--status"); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	target, err := parsed.target()
	if err != nil {
		return agentapi.Request{}, err
	}
	query := make(url.Values)
	query.Set("channel", target)
	if status := parsed.last("--status"); status != "" {
		if !validTaskListStatus(status) {
			return agentapi.Request{}, fmt.Errorf("invalid task status %q", status)
		}
		query.Set("status", status)
	}
	return agentapi.Request{Path: make(map[string]string), Query: query}, nil
}

func (a *App) downloadAttachment(ctx context.Context, args []string) int {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	if err := parsed.allow("--id", "--output"); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	if len(parsed.positionals) > 1 {
		_, _ = fmt.Fprintln(a.stderr, fmt.Errorf("unexpected argument %q", parsed.positionals[1]))
		return 2
	}
	attachmentID := strings.TrimSpace(parsed.last("--id"))
	if len(parsed.positionals) == 1 {
		if attachmentID != "" && attachmentID != parsed.positionals[0] {
			_, _ = fmt.Fprintln(a.stderr, "positional attachment ID and --id must match")
			return 2
		}
		attachmentID = parsed.positionals[0]
	}
	outputPath := strings.TrimSpace(parsed.last("--output"))
	if attachmentID == "" || outputPath == "" {
		_, _ = fmt.Fprintln(a.stderr, "attachment view requires an ID and --output")
		return 2
	}
	outputDirectory := filepath.Dir(outputPath)
	temporary, err := os.CreateTemp(
		outputDirectory,
		"."+filepath.Base(outputPath)+".download-*",
	)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	if err := a.client.Call(ctx, agentapi.AttachmentDownload, agentapi.Request{
		Path:  map[string]string{"attachmentId": attachmentID},
		Query: make(url.Values),
	}, temporary); err != nil {
		cleanup()
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	if err := os.Rename(temporaryPath, outputPath); err != nil {
		_ = os.Remove(temporaryPath)
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintf(a.stdout, "Downloaded to: %s\n", outputPath)
	return 0
}

func taskClaimRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--target",
		"--number",
		"--message-id",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	target, err := parsed.target()
	if err != nil {
		return agentapi.Request{}, err
	}
	numbers, err := positiveInts("--number", parsed.values["--number"])
	if err != nil {
		return agentapi.Request{}, err
	}
	messageIDs := parsed.values["--message-id"]
	if len(numbers) == 0 && len(messageIDs) == 0 {
		return agentapi.Request{}, errors.New("provide at least one --number or --message-id")
	}
	body := map[string]any{"channel": target}
	if len(numbers) > 0 {
		body["task_numbers"] = numbers
	}
	if len(messageIDs) > 0 {
		body["message_ids"] = append([]string(nil), messageIDs...)
	}
	return bodyRequest(body), nil
}

func taskUpdateRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--target", "--number", "--status"); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	target, err := parsed.target()
	if err != nil {
		return agentapi.Request{}, err
	}
	numbers, err := positiveInts("--number", parsed.values["--number"])
	if err != nil {
		return agentapi.Request{}, err
	}
	if len(numbers) != 1 {
		return agentapi.Request{}, errors.New("--number is required exactly once")
	}
	status := parsed.last("--status")
	if !validTaskStatus(status) {
		return agentapi.Request{}, fmt.Errorf("invalid task status %q", status)
	}
	return bodyRequest(map[string]any{
		"channel":     target,
		"task_number": numbers[0],
		"status":      status,
	}), nil
}

func positiveInts(flag string, values []string) ([]int, error) {
	result := make([]int, 0, len(values))
	for _, raw := range values {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			return nil, fmt.Errorf("%s must be a positive integer; got %s", flag, raw)
		}
		result = append(result, value)
	}
	return result, nil
}

func validTaskListStatus(status string) bool {
	return status == "all" || validTaskStatus(status)
}

func validTaskStatus(status string) bool {
	switch status {
	case "todo", "in_progress", "in_review", "done", "closed":
		return true
	default:
		return false
	}
}

func bodyRequest(body map[string]any) agentapi.Request {
	return agentapi.Request{
		Path:  make(map[string]string),
		Query: make(url.Values),
		Body:  body,
	}
}

func messageSendRequest(args []string, stdin io.Reader) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, map[string]bool{"--json": true})
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--target",
		"--text",
		"--attachment-id",
		"--json",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf(
			"unexpected argument %q",
			parsed.positionals[0],
		)
	}
	target := strings.TrimSpace(parsed.last("--target"))
	if target == "" {
		return agentapi.Request{}, errors.New(
			"--target is required; use vela message send --target <target> --text <message>",
		)
	}
	content := parsed.last("--text")
	if content == "" && stdin != nil {
		data, readErr := io.ReadAll(stdin)
		if readErr != nil {
			return agentapi.Request{}, readErr
		}
		content = string(data)
	}
	if strings.TrimSpace(content) == "" {
		return agentapi.Request{}, errors.New("message content is required on stdin")
	}
	body := map[string]any{
		"target":  target,
		"content": content,
	}
	if attachments := parsed.values["--attachment-id"]; len(attachments) > 0 {
		body["attachmentIds"] = append([]string(nil), attachments...)
	}
	return agentapi.Request{
		Path:  make(map[string]string),
		Query: make(url.Values),
		Body:  body,
	}, nil
}

func (a *App) runMessageSend(ctx context.Context, args []string) int {
	request, err := messageSendRequest(args, a.stdin)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	body, ok := request.Body.(map[string]any)
	if !ok {
		_, _ = fmt.Fprintln(a.stderr, "message request body is unavailable")
		return 1
	}
	target, _ := body["target"].(string)
	var resultPayload map[string]any
	if err := a.client.Call(
		ctx,
		agentapi.MessageSend,
		agentapi.Request{Body: body},
		&resultPayload,
	); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	resultData, err := common.Marshal(resultPayload)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	var result messageSendResponse
	if err := common.Unmarshal(resultData, &result); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	if messageSendJSONRequested(args) {
		if exitCode := a.writeResult(resultPayload); exitCode != 0 {
			return exitCode
		}
	} else {
		_, _ = fmt.Fprint(a.stdout, formatSentMessage(target, result))
	}
	return 0
}

func messageSendJSONRequested(args []string) bool {
	for _, arg := range args {
		if arg == "--json" {
			return true
		}
	}
	return false
}

func messageReadRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--target",
		"--before",
		"--after",
		"--around",
		"--limit",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	target, err := parsed.target()
	if err != nil {
		return agentapi.Request{}, err
	}
	query := make(url.Values)
	query.Set("channel", target)
	copyQueryValues(query, parsed, map[string]string{
		"--before": "before",
		"--after":  "after",
		"--around": "around",
		"--limit":  "limit",
	})
	return agentapi.Request{Path: make(map[string]string), Query: query}, nil
}

func messageSearchRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow(
		"--query",
		"--target",
		"--sender",
		"--sort",
		"--before",
		"--after",
		"--limit",
		"--offset",
	); err != nil {
		return agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	query := make(url.Values)
	if value := parsed.last("--query"); value != "" {
		query.Set("q", value)
	}
	target := parsed.last("--target")
	if target != "" {
		query.Set("channel", target)
	}
	copyQueryValues(query, parsed, map[string]string{
		"--sender": "sender",
		"--sort":   "sort",
		"--before": "before",
		"--after":  "after",
		"--limit":  "limit",
		"--offset": "offset",
	})
	return agentapi.Request{Path: make(map[string]string), Query: query}, nil
}

func messageResolveRequest(args []string) (agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return agentapi.Request{}, err
	}
	if err := parsed.allow("--id"); err != nil {
		return agentapi.Request{}, err
	}
	messageID := parsed.last("--id")
	if len(parsed.positionals) > 1 {
		return agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[1])
	}
	if len(parsed.positionals) == 1 {
		if messageID != "" && messageID != parsed.positionals[0] {
			return agentapi.Request{}, errors.New("positional message ID and --id must match")
		}
		messageID = parsed.positionals[0]
	}
	if strings.TrimSpace(messageID) == "" {
		return agentapi.Request{}, errors.New("<id> is required")
	}
	return agentapi.Request{
		Path:  map[string]string{"msgId": messageID},
		Query: make(url.Values),
	}, nil
}

func messageReactionRequest(
	args []string,
) (agentapi.Operation, agentapi.Request, error) {
	parsed, err := parseObservedArgs(args, map[string]bool{"--remove": true})
	if err != nil {
		return "", agentapi.Request{}, err
	}
	if err := parsed.allow("--message-id", "--emoji", "--remove"); err != nil {
		return "", agentapi.Request{}, err
	}
	if len(parsed.positionals) > 0 {
		return "", agentapi.Request{}, fmt.Errorf("unexpected argument %q", parsed.positionals[0])
	}
	messageID := strings.TrimSpace(parsed.last("--message-id"))
	emoji := strings.TrimSpace(parsed.last("--emoji"))
	if messageID == "" {
		return "", agentapi.Request{}, errors.New("--message-id is required")
	}
	if emoji == "" {
		return "", agentapi.Request{}, errors.New("--emoji is required")
	}
	operation := agentapi.MessageReactionAdd
	if parsed.booleans["--remove"] {
		operation = agentapi.MessageReactionRemove
	}
	return operation, agentapi.Request{
		Path:  map[string]string{"msgId": messageID},
		Query: make(url.Values),
		Body:  map[string]string{"emoji": emoji},
	}, nil
}

func parseObservedArgs(args []string, booleanFlags map[string]bool) (observedArgs, error) {
	result := observedArgs{
		values:   make(map[string][]string),
		booleans: make(map[string]bool),
	}
	for index := 0; index < len(args); index++ {
		token := args[index]
		if !strings.HasPrefix(token, "--") {
			result.positionals = append(result.positionals, token)
			continue
		}
		if booleanFlags[token] {
			result.booleans[token] = true
			continue
		}
		if index+1 >= len(args) {
			return observedArgs{}, fmt.Errorf("%s requires a value", token)
		}
		index++
		result.values[token] = append(result.values[token], args[index])
	}
	return result, nil
}

func (a observedArgs) last(flag string) string {
	values := a.values[flag]
	if len(values) == 0 {
		return ""
	}
	return values[len(values)-1]
}

func (a observedArgs) allow(flags ...string) error {
	allowed := make(map[string]struct{}, len(flags))
	for _, flag := range flags {
		allowed[flag] = struct{}{}
	}
	for flag := range a.values {
		if _, ok := allowed[flag]; !ok {
			return fmt.Errorf("unknown option %q", flag)
		}
	}
	for flag := range a.booleans {
		if _, ok := allowed[flag]; !ok {
			return fmt.Errorf("unknown option %q", flag)
		}
	}
	return nil
}

func (a observedArgs) target() (string, error) {
	target := strings.TrimSpace(a.last("--target"))
	if target == "" {
		return "", errors.New("--target is required")
	}
	return target, nil
}

func copyQueryValues(query url.Values, args observedArgs, mapping map[string]string) {
	for flag, key := range mapping {
		if value := args.last(flag); value != "" {
			query.Set(key, value)
		}
	}
}

func (a *App) uploadAttachment(ctx context.Context, args []string) int {
	options, err := parseAttachmentUploadArgs(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	info, err := os.Lstat(options.path)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	if info.Mode()&os.ModeSymlink != 0 {
		_, _ = fmt.Fprintln(a.stderr, "attachment path must not be a symbolic link")
		return 2
	}
	if !info.Mode().IsRegular() {
		_, _ = fmt.Fprintln(a.stderr, "attachment path must be a regular file")
		return 2
	}
	if info.Size() == 0 {
		_, _ = fmt.Fprintln(a.stderr, "attachment path is empty")
		return 2
	}
	if info.Size() > 50*1024*1024 {
		_, _ = fmt.Fprintln(a.stderr, "attachment path exceeds 50 MiB")
		return 2
	}
	var resolved map[string]any
	if err := a.client.Call(ctx, agentapi.ChannelResolve, agentapi.Request{
		Body: map[string]string{"target": options.target},
	}, &resolved); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	channelID := resolvedChannelID(resolved)
	if channelID == "" {
		_, _ = fmt.Fprintln(a.stderr, "resolved channel response is missing channelId")
		return 1
	}
	file, err := os.Open(options.path)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	pipeReader, pipeWriter := io.Pipe()
	multipartWriter := multipart.NewWriter(pipeWriter)
	contentType := multipartWriter.FormDataContentType()
	producerResult := make(chan error, 1)
	go func() {
		defer file.Close()
		producerResult <- writeAttachmentMultipart(
			multipartWriter,
			pipeWriter,
			file,
			filepath.Base(options.path),
			channelID,
			options.target,
			options.mimeType,
		)
	}()

	var result attachmentUploadResponse
	callErr := a.client.Call(ctx, agentapi.AttachmentUpload, agentapi.Request{
		RawBody: pipeReader,
		Headers: http.Header{"Content-Type": []string{contentType}},
	}, &result)
	_ = pipeReader.Close()
	producerErr := <-producerResult
	if callErr != nil {
		_, _ = fmt.Fprintln(a.stderr, callErr)
		return 1
	}
	if producerErr != nil {
		_, _ = fmt.Fprintln(a.stderr, producerErr)
		return 1
	}
	_, _ = fmt.Fprintf(
		a.stdout,
		"File uploaded: %s (%.1fKB)\n"+
			"Attachment ID: %s\n\n"+
			"Use this ID with vela message send --attachment-id %s "+
			"to include it in a message.\n",
		result.Filename,
		result.SizeBytes/1024,
		result.ID,
		result.ID,
	)
	return 0
}

type attachmentUploadOptions struct {
	path     string
	target   string
	mimeType string
}

func parseAttachmentUploadArgs(args []string) (attachmentUploadOptions, error) {
	var options attachmentUploadOptions
	for index := 0; index < len(args); index++ {
		if index+1 >= len(args) {
			return attachmentUploadOptions{}, fmt.Errorf("%s requires a value", args[index])
		}
		value := args[index+1]
		index++
		switch args[index-1] {
		case "--path":
			options.path = value
		case "--target":
			options.target = value
		case "--mime-type":
			options.mimeType = value
		default:
			return attachmentUploadOptions{}, fmt.Errorf("unknown attachment upload option %q", args[index-1])
		}
	}
	if strings.TrimSpace(options.path) == "" || strings.TrimSpace(options.target) == "" {
		return attachmentUploadOptions{}, errors.New("attachment upload requires --path and --target")
	}
	return options, nil
}

func resolvedChannelID(result map[string]any) string {
	if channelID, _ := result["channelId"].(string); channelID != "" {
		return channelID
	}
	data, _ := result["data"].(map[string]any)
	channelID, _ := data["channelId"].(string)
	return channelID
}

func writeAttachmentMultipart(
	writer *multipart.Writer,
	pipe *io.PipeWriter,
	file io.Reader,
	filename string,
	channelID string,
	target string,
	explicitMIMEType string,
) error {
	mimeType := strings.TrimSpace(explicitMIMEType)
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(filename))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	headers := make(textproto.MIMEHeader)
	headers.Set(
		"Content-Disposition",
		fmt.Sprintf(
			`form-data; name="file"; filename="%s"`,
			escapeMultipartQuoted(filename),
		),
	)
	headers.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(headers)
	if err == nil {
		_, err = io.Copy(part, file)
	}
	if err == nil {
		err = writer.WriteField("channelId", channelID)
	}
	if err == nil {
		err = writer.WriteField("target", target)
	}
	if err == nil && explicitMIMEType != "" {
		err = writer.WriteField("mimeType", explicitMIMEType)
	}
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = pipe.CloseWithError(err)
		return err
	}
	return pipe.Close()
}

func escapeMultipartQuoted(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, `\"`).Replace(value)
}
