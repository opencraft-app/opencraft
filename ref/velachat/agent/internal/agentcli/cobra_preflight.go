package agentcli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"velachat/agent/internal/agentapi"
)

type managedInput struct {
	reader io.Reader
	replay bool
	data   []byte
}

func prepareManagedInput(path string, args []string, source io.Reader) (managedInput, error) {
	if !managedCommandConsumesStdin(path, args) {
		return managedInput{reader: source}, nil
	}
	data, err := io.ReadAll(source)
	if err != nil {
		return managedInput{}, err
	}
	return managedInput{
		reader: bytes.NewReader(data),
		replay: true,
		data:   data,
	}, nil
}

func managedCommandConsumesStdin(path string, args []string) bool {
	if path == "message send" {
		return !argumentFlagPresent(args, "--text")
	}
	return false
}

func argumentFlagPresent(args []string, name string) bool {
	for _, argument := range args {
		if argument == name {
			return true
		}
	}
	return false
}

func (input managedInput) executionReader() io.Reader {
	if input.replay {
		return bytes.NewReader(input.data)
	}
	return input.reader
}

func preflightManagedCommand(
	path string,
	operation agentapi.Operation,
	args []string,
	stdin io.Reader,
) error {
	var err error
	switch path {
	case "auth whoami":
		return nil
	case "channel info":
		_, err = channelInfoRequest(args)
	case "channel members":
		_, err = channelMembersRequest(args)
	case "server info":
		_, err = noOptionRequest(args)
	case "user info":
		err = preflightUserInfo(args)
	case "inbox check", "message check":
		_, err = noOptionRequest(args)
	case "message send":
		_, err = messageSendRequest(args, stdin)
	case "message read":
		_, err = messageReadRequest(args)
	case "message search":
		_, err = messageSearchRequest(args)
	case "message resolve":
		_, err = messageResolveRequest(args)
	case "message react":
		_, _, err = messageReactionRequest(args)
	case "attachment upload":
		err = preflightAttachmentUpload(args)
	case "attachment view":
		err = preflightAttachmentView(args)
	case "task list":
		_, err = taskListRequest(args)
	case "task claim":
		_, err = taskClaimRequest(args)
	case "task update":
		_, err = taskUpdateRequest(args)
	case "reminder schedule":
		_, err = reminderScheduleRequest(args)
	case "reminder list":
		_, err = reminderListRequest(args)
	case "reminder cancel", "reminder log":
		_, err = reminderIDRequest(args)
	case "reminder snooze":
		_, err = reminderSnoozeRequest(args)
	case "reminder update":
		_, err = reminderUpdateRequest(args)
	default:
		err = fmt.Errorf("managed command %q has no preflight", path)
	}
	return err
}

func preflightUserInfo(args []string) error {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return err
	}
	if err := parsed.allow(); err != nil {
		return err
	}
	if len(parsed.positionals) != 1 {
		return errors.New("user info requires exactly one name")
	}
	if strings.TrimSpace(strings.TrimPrefix(parsed.positionals[0], "@")) == "" {
		return errors.New("user name is required")
	}
	return nil
}

func preflightAttachmentUpload(args []string) error {
	options, err := parseAttachmentUploadArgs(args)
	if err != nil {
		return err
	}
	info, err := os.Stat(options.path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("attachment path must be a regular file")
	}
	if info.Size() == 0 {
		return errors.New("attachment path is empty")
	}
	if info.Size() > 50*1024*1024 {
		return errors.New("attachment path exceeds 50 MiB")
	}
	return nil
}

func preflightAttachmentView(args []string) error {
	parsed, err := parseObservedArgs(args, nil)
	if err != nil {
		return err
	}
	if err := parsed.allow("--id", "--output"); err != nil {
		return err
	}
	if len(parsed.positionals) > 1 {
		return fmt.Errorf("unexpected argument %q", parsed.positionals[1])
	}
	attachmentID := strings.TrimSpace(parsed.last("--id"))
	if len(parsed.positionals) == 1 {
		if attachmentID != "" && attachmentID != parsed.positionals[0] {
			return errors.New("positional attachment ID and --id must match")
		}
		attachmentID = parsed.positionals[0]
	}
	if attachmentID == "" || strings.TrimSpace(parsed.last("--output")) == "" {
		return errors.New("attachment view requires an ID and --output")
	}
	return nil
}
