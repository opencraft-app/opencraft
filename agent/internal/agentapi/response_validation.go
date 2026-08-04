package agentapi

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

// ResponseValidationError identifies a successful HTTP response whose minimum
// Vela wire shape is invalid. Unknown fields remain forward compatible.
type ResponseValidationError struct {
	Operation Operation
	Field     string
	Problem   string
}

func (e *ResponseValidationError) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("Agent API %s response is invalid: %s", e.Operation, e.Problem)
	}
	return fmt.Sprintf(
		"Agent API %s response field %q is invalid: %s",
		e.Operation,
		e.Field,
		e.Problem,
	)
}

func validateObservedResponse(operation Operation, data []byte) error {
	var object map[string]json.RawMessage
	if err := common.Unmarshal(data, &object); err != nil || object == nil {
		return invalidResponse(operation, "", "expected a JSON object")
	}

	switch operation {
	case Events:
		return requireArray(operation, object, "events")
	case HistoryRead:
		return validateAll(
			requireArray(operation, object, "messages"),
			requireBool(operation, object, "has_more"),
			requireBool(operation, object, "has_older"),
			requireBool(operation, object, "has_newer"),
		)
	case MessageSend:
		state, err := requireString(operation, object, "state")
		if err != nil {
			return err
		}
		if state != "sent" {
			return invalidResponse(operation, "state", `expected "sent"`)
		}
		return validateAll(
			requireTrue(operation, object, "ok"),
			requireNonemptyString(operation, object, "messageId"),
		)
	case MessageResolve:
		return requireObject(operation, object, "message")
	case MessageSearch:
		return validateAll(
			requireArray(operation, object, "results"),
			requireBool(operation, object, "hasMore"),
		)
	case MessageReactionAdd, MessageReactionRemove:
		return nil
	case ChannelMembers:
		return validateAll(
			requireObject(operation, object, "channel"),
			requireArray(operation, object, "agents"),
			requireArray(operation, object, "humans"),
		)
	case ChannelResolve:
		return requireNonemptyString(operation, object, "channelId")
	case ServerInfo:
		if err := validateAll(
			requireObject(operation, object, "runtimeContext"),
			requireArray(operation, object, "channels"),
			requireArray(operation, object, "agents"),
			requireArray(operation, object, "humans"),
		); err != nil {
			return err
		}
		var runtimeContext map[string]json.RawMessage
		if err := common.Unmarshal(object["runtimeContext"], &runtimeContext); err != nil {
			return invalidResponse(operation, "runtimeContext", "expected an object")
		}
		return validateAll(
			requireNonemptyString(operation, runtimeContext, "agentId"),
			requireNonemptyString(operation, runtimeContext, "serverId"),
		)
	case TaskClaim:
		return requireArray(operation, object, "results")
	case TaskList:
		return requireArray(operation, object, "tasks")
	case TaskUpdateStatus:
		return requireTrue(operation, object, "ok")
	case ReminderList:
		return requireArray(operation, object, "reminders")
	case ReminderCreate, ReminderCancel, ReminderSnooze, ReminderUpdate:
		return requireObject(operation, object, "reminder")
	case ReminderLog:
		return requireArray(operation, object, "events")
	case AttachmentUpload:
		return validateAll(
			requireNonemptyString(operation, object, "id"),
			requireStringOnly(operation, object, "filename"),
			requireNumber(operation, object, "sizeBytes"),
		)
	case InboxCheck:
		if _, exists := object["rows"]; !exists {
			return nil
		}
		return requireArray(operation, object, "rows")
	default:
		return invalidResponse(operation, "", "operation has no Vela response contract")
	}
}

func validateAll(errors ...error) error {
	for _, err := range errors {
		if err != nil {
			return err
		}
	}
	return nil
}

func requireString(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) (string, error) {
	raw, exists := object[field]
	if !exists {
		return "", invalidResponse(operation, field, "is required")
	}
	var value string
	if err := common.Unmarshal(raw, &value); err != nil {
		return "", invalidResponse(operation, field, "expected a string")
	}
	return value, nil
}

func requireStringOnly(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	_, err := requireString(operation, object, field)
	return err
}

func requireNonemptyString(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	value, err := requireString(operation, object, field)
	if err != nil {
		return err
	}
	if strings.TrimSpace(value) == "" {
		return invalidResponse(operation, field, "must not be empty")
	}
	return nil
}

func requireBool(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	var value bool
	return requireDecoded(operation, object, field, &value, "expected a boolean")
}

func requireTrue(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	var value bool
	if err := requireDecoded(operation, object, field, &value, "expected true"); err != nil {
		return err
	}
	if !value {
		return invalidResponse(operation, field, "expected true")
	}
	return nil
}

func requireNumber(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	var value json.Number
	return requireDecoded(operation, object, field, &value, "expected a number")
}

func requireArray(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	var value []json.RawMessage
	return requireDecoded(operation, object, field, &value, "expected an array")
}

func requireObject(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
) error {
	var value map[string]json.RawMessage
	if err := requireDecoded(operation, object, field, &value, "expected an object"); err != nil {
		return err
	}
	if value == nil {
		return invalidResponse(operation, field, "expected an object")
	}
	return nil
}

func requireDecoded(
	operation Operation,
	object map[string]json.RawMessage,
	field string,
	destination any,
	problem string,
) error {
	raw, exists := object[field]
	if !exists {
		return invalidResponse(operation, field, "is required")
	}
	if err := common.Unmarshal(raw, destination); err != nil {
		return invalidResponse(operation, field, problem)
	}
	return nil
}

func invalidResponse(operation Operation, field string, problem string) error {
	return &ResponseValidationError{Operation: operation, Field: field, Problem: problem}
}
