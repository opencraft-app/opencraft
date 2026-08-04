package runtimeprompt

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
)

const responseTargetHint = "Reply in the channel or create/reply in a thread as appropriate; " +
	"use each message's `target` and `msg` fields to choose the exact target."

const persistentMessageDeliveryText = "New inbox updates may be delivered to you automatically " +
	"while your process stays alive."

const persistentBusyDeliveryNote = "\n\nNote: While you are busy, the daemon may write batched " +
	"content-free inbox updates into your active turn. Finish your current step, then check " +
	"the inbox or read messages at a natural breakpoint."

type PersistentPlanner struct {
	runtimeID string
}

func NewPersistentPlanner(runtimeID string) PersistentPlanner {
	return PersistentPlanner{runtimeID: strings.TrimSpace(runtimeID)}
}

func (planner PersistentPlanner) PlanLaunch(
	input runtimeapi.LaunchInput,
) (runtimeapi.LaunchPlan, error) {
	if planner.runtimeID == "" || input.Runtime != planner.runtimeID {
		return runtimeapi.LaunchPlan{}, errors.New(
			"persistent launch planner received the wrong Runtime",
		)
	}
	if strings.TrimSpace(input.AgentID) == "" {
		return runtimeapi.LaunchPlan{}, errors.New(
			"persistent launch planner requires an Agent identity",
		)
	}
	standing, err := ComposeStandingPrompt(input.AgentID, "")
	if err != nil {
		return runtimeapi.LaunchPlan{}, err
	}

	resumeMessages := cloneRawMessages(input.ResumeMessages)
	consumed := 0
	if len(input.WakeMessage) == 0 &&
		strings.TrimSpace(input.ResumePrompt) == "" &&
		len(resumeMessages) == 0 &&
		input.SessionID != "" &&
		len(input.BufferedMessages) > 0 {
		resumeMessages = rawBufferedMessages(input.BufferedMessages)
		consumed = len(input.BufferedMessages)
	}

	prompt := persistentStartPrompt(input, resumeMessages)
	var rebindDelivery *runtimeapi.Delivery
	var postStartDelivery *runtimeapi.Delivery
	if len(input.WakeMessage) > 0 {
		if !input.WakeMessageTransient && len(input.BufferedMessages) > 0 {
			rawMessages := make(
				[]json.RawMessage,
				0,
				1+len(input.BufferedMessages),
			)
			rawMessages = append(
				rawMessages,
				append(json.RawMessage(nil), input.WakeMessage...),
			)
			rawMessages = append(
				rawMessages,
				rawBufferedMessages(input.BufferedMessages)...,
			)
			prompt = durableWakePromptBatch(rawMessages)
		}
		rebindDelivery = &runtimeapi.Delivery{
			Text:      prompt,
			Transient: input.WakeMessageTransient,
		}
		messages := make(
			[]runtimeapi.BufferedLaunchMessage,
			0,
			1+len(input.BufferedMessages),
		)
		if !input.WakeMessageTransient {
			messages = append(messages, runtimeapi.BufferedLaunchMessage{
				Raw: append(json.RawMessage(nil), input.WakeMessage...),
			})
		}
		messages = append(
			messages,
			cloneBufferedMessages(input.BufferedMessages)...,
		)
		if len(messages) > 0 {
			delivery := bufferedRuntimeDelivery(messages)
			postStartDelivery = &delivery
		}
		consumed = len(input.BufferedMessages)
	}

	return runtimeapi.LaunchPlan{
		Prompt:                   prompt,
		StandingPrompt:           standing,
		RebindDelivery:           rebindDelivery,
		PostStartDelivery:        postStartDelivery,
		ConsumedBufferedMessages: consumed,
	}, nil
}

func persistentStartPrompt(
	input runtimeapi.LaunchInput,
	resumeMessages []json.RawMessage,
) string {
	if strings.TrimSpace(input.ResumePrompt) != "" && input.SessionID != "" {
		return input.ResumePrompt + persistentBusyDeliveryNote
	}
	if len(input.WakeMessage) > 0 {
		if input.WakeMessageTransient {
			return transientWakePrompt(input.WakeMessage)
		}
		return durableWakePrompt(input.WakeMessage)
	}
	if input.SessionID != "" && len(resumeMessages) > 0 {
		return concreteResumePrompt(resumeMessages)
	}
	if input.SessionID != "" {
		if prompt, ok := unreadResumePrompt(input.UnreadSummary); ok {
			return prompt
		}
		return "No new messages while you were away. Nothing to do — just stop. " +
			persistentMessageDeliveryText + persistentBusyDeliveryNote
	}
	return "Start."
}

func bufferedRuntimeDelivery(
	messages []runtimeapi.BufferedLaunchMessage,
) runtimeapi.Delivery {
	rawMessages := make([]json.RawMessage, 0, len(messages))
	allTransient := len(messages) > 0
	for _, message := range messages {
		rawMessages = append(
			rawMessages,
			append(json.RawMessage(nil), message.Raw...),
		)
		allTransient = allTransient && message.Transient
	}
	return runtimeapi.Delivery{
		Text:      durableWakePromptBatch(rawMessages),
		Mode:      "idle",
		Transient: allTransient,
	}
}

func cloneBufferedMessages(
	messages []runtimeapi.BufferedLaunchMessage,
) []runtimeapi.BufferedLaunchMessage {
	cloned := make([]runtimeapi.BufferedLaunchMessage, 0, len(messages))
	for _, message := range messages {
		cloned = append(cloned, runtimeapi.BufferedLaunchMessage{
			Raw:       append(json.RawMessage(nil), message.Raw...),
			Transient: message.Transient,
		})
	}
	return cloned
}

func rawBufferedMessages(
	messages []runtimeapi.BufferedLaunchMessage,
) []json.RawMessage {
	raw := make([]json.RawMessage, 0, len(messages))
	for _, message := range messages {
		raw = append(raw, append(json.RawMessage(nil), message.Raw...))
	}
	return raw
}

func cloneRawMessages(messages []json.RawMessage) []json.RawMessage {
	cloned := make([]json.RawMessage, 0, len(messages))
	for _, message := range messages {
		cloned = append(cloned, append(json.RawMessage(nil), message...))
	}
	return cloned
}

func transientWakePrompt(raw json.RawMessage) string {
	message := formatWakeMessage(raw)
	if message == "" {
		message = deliveryText(raw)
	}
	return "System notice received:\n\n" + message +
		"\n\nRespond as appropriate. Complete all your work before stopping.\n" +
		responseTargetHint
}

func durableWakePrompt(raw json.RawMessage) string {
	return durableWakePromptBatch([]json.RawMessage{raw})
}

type inboxPromptMessage struct {
	messageID     string
	senderName    string
	sequence      int64
	flags         []string
	attentionHint json.RawMessage
}

type inboxPromptRow struct {
	target   string
	messages []inboxPromptMessage
}

func durableWakePromptBatch(rawMessages []json.RawMessage) string {
	buckets := make(map[string][]inboxPromptMessage)
	for _, raw := range rawMessages {
		var message struct {
			MessageID         string          `json:"message_id"`
			ID                string          `json:"id"`
			Sequence          float64         `json:"seq"`
			ChannelType       string          `json:"channel_type"`
			ChannelName       string          `json:"channel_name"`
			ParentChannelName string          `json:"parent_channel_name"`
			ParentChannelType string          `json:"parent_channel_type"`
			Target            string          `json:"target"`
			SenderName        string          `json:"sender_name"`
			LegacySenderName  string          `json:"senderName"`
			TaskNumber        json.RawMessage `json:"task_number"`
			TaskStatus        json.RawMessage `json:"task_status"`
			Mentioned         bool            `json:"mentioned"`
			NonMemberMention  bool            `json:"non_member_mention"`
			AttentionHint     json.RawMessage `json:"attention_hint"`
		}
		if common.Unmarshal(raw, &message) != nil {
			continue
		}
		target := strings.TrimSpace(message.Target)
		if target == "" {
			target = inboxPromptTarget(
				message.ChannelType,
				message.ChannelName,
				message.ParentChannelName,
				message.ParentChannelType,
			)
		}
		if target == "" {
			continue
		}
		messageID := strings.TrimSpace(message.MessageID)
		if messageID == "" {
			messageID = strings.TrimSpace(message.ID)
		}
		senderName := message.SenderName
		if senderName == "" {
			senderName = message.LegacySenderName
		}
		sequence := int64(0)
		if message.Sequence > 0 {
			sequence = int64(message.Sequence)
		}
		flags := make([]string, 0, 5)
		if message.ChannelType == "thread" {
			flags = append(flags, "thread")
		}
		if message.ChannelType == "dm" {
			flags = append(flags, "dm")
		}
		if rawJSONTruthy(message.TaskNumber) || rawJSONTruthy(message.TaskStatus) {
			flags = append(flags, "task")
		}
		if message.Mentioned {
			flags = append(flags, "mention")
		}
		if message.NonMemberMention {
			flags = append(flags, "non_member_mention")
		}
		buckets[target] = append(buckets[target], inboxPromptMessage{
			messageID:     messageID,
			senderName:    senderName,
			sequence:      sequence,
			flags:         flags,
			attentionHint: append(json.RawMessage(nil), message.AttentionHint...),
		})
	}

	rows := make([]inboxPromptRow, 0, len(buckets))
	for target, messages := range buckets {
		sort.SliceStable(messages, func(left int, right int) bool {
			if messages[left].sequence != messages[right].sequence {
				return messages[left].sequence < messages[right].sequence
			}
			return messages[left].messageID < messages[right].messageID
		})
		rows = append(rows, inboxPromptRow{target: target, messages: messages})
	}
	sort.SliceStable(rows, func(left int, right int) bool {
		leftSequence := rows[left].messages[len(rows[left].messages)-1].sequence
		rightSequence := rows[right].messages[len(rows[right].messages)-1].sequence
		if leftSequence != rightSequence {
			return leftSequence > rightSequence
		}
		return rows[left].target < rows[right].target
	})

	total := len(rawMessages)
	header := fmt.Sprintf(
		"Inbox update: %d unread message%s total; %s changed target%s",
		total,
		pluralSuffix(total),
		changedTargetCount(len(rows)),
		pluralSuffix(len(rows)),
	)
	lines := []string{"[Vela inbox notice:", header}
	for _, row := range rows {
		first := row.messages[0]
		latest := row.messages[len(row.messages)-1]
		details := []string{
			fmt.Sprintf(
				"pending: %d message%s",
				len(row.messages),
				pluralSuffix(len(row.messages)),
			),
		}
		if first.messageID != "" {
			details = append(
				details,
				"first msg="+first.messageID,
			)
		}
		if latest.senderName != "" {
			details = append(details, "latest sender @"+latest.senderName)
		}
		if latest.messageID != "" {
			details = append(
				details,
				"latest msg="+latest.messageID,
			)
		}
		flagSet := make(map[string]struct{})
		for _, message := range row.messages {
			for _, flag := range message.flags {
				flagSet[flag] = struct{}{}
			}
		}
		flags := make([]string, 0, len(flagSet))
		for flag := range flagSet {
			flags = append(flags, flag)
		}
		sort.Strings(flags)
		for _, flag := range flags {
			details = append(details, formatInboxPromptFlag(flag))
		}
		for index := len(row.messages) - 1; index >= 0; index-- {
			hint := formatInboxAttentionHint(row.messages[index].attentionHint)
			if hint != "" {
				details = append(details, "attention_hint="+hint)
				break
			}
		}
		lines = append(lines, row.target+"  "+strings.Join(details, " · "))
		if latest.messageID != "" {
			lines = append(lines, fmt.Sprintf(
				"read: `vela message read --target %q --around %q`",
				row.target,
				latest.messageID,
			))
		}
	}
	lines = append(lines, "]")
	return strings.Join(lines, "\n")
}

const nonMemberMentionReplyGuidance = "[Vela notice: You were notified as a " +
	"non-member, so you cannot reply in that channel. If no reply is needed, " +
	"no action is required. Otherwise, DM the person who mentioned you or join " +
	"the channel to participate.]"

func formatInboxPromptFlag(flag string) string {
	switch flag {
	case "mention":
		return "you were mentioned"
	case "non_member_mention":
		return nonMemberMentionReplyGuidance
	default:
		return flag
	}
}

func formatInboxAttentionHint(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var hint struct {
		Schema           string          `json:"schema"`
		Trigger          string          `json:"trigger"`
		Scope            string          `json:"scope"`
		SuggestedCommand string          `json:"suggested_command"`
		Copy             string          `json:"copy"`
		CopyVersion      string          `json:"copy_version"`
		EpochMS          int64           `json:"epoch_ms"`
		Thresholds       json.RawMessage `json:"thresholds"`
	}
	if common.Unmarshal(raw, &hint) != nil || len(hint.Thresholds) == 0 {
		return ""
	}
	projected, err := common.Marshal(struct {
		Schema           string          `json:"schema"`
		Trigger          string          `json:"trigger"`
		Scope            string          `json:"scope"`
		SuggestedCommand string          `json:"suggested_command"`
		Copy             string          `json:"copy"`
		CopyVersion      string          `json:"copy_version"`
		EpochMS          int64           `json:"epoch_ms"`
		Thresholds       json.RawMessage `json:"thresholds"`
	}{
		Schema:           hint.Schema,
		Trigger:          hint.Trigger,
		Scope:            hint.Scope,
		SuggestedCommand: hint.SuggestedCommand,
		Copy:             hint.Copy,
		CopyVersion:      hint.CopyVersion,
		EpochMS:          hint.EpochMS,
		Thresholds:       hint.Thresholds,
	})
	if err != nil {
		return ""
	}
	return restoreJSONStringifyCharacters(projected)
}

func restoreJSONStringifyCharacters(encoded []byte) string {
	var rendered strings.Builder
	rendered.Grow(len(encoded))
	for index := 0; index < len(encoded); {
		if encoded[index] != '\\' {
			rendered.WriteByte(encoded[index])
			index++
			continue
		}
		runStart := index
		for index < len(encoded) && encoded[index] == '\\' {
			index++
		}
		slashCount := index - runStart
		if slashCount%2 == 1 && index+5 <= len(encoded) && encoded[index] == 'u' {
			var replacement string
			switch string(encoded[index : index+5]) {
			case "u0026":
				replacement = "&"
			case "u003c":
				replacement = "<"
			case "u003e":
				replacement = ">"
			case "u2028":
				replacement = "\u2028"
			case "u2029":
				replacement = "\u2029"
			}
			if replacement != "" {
				rendered.Write(encoded[runStart : index-1])
				rendered.WriteString(replacement)
				index += 5
				continue
			}
		}
		rendered.Write(encoded[runStart:index])
	}
	return rendered.String()
}

func rawJSONTruthy(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value any
	if common.Unmarshal(raw, &value) != nil {
		return false
	}
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	default:
		return true
	}
}

func inboxPromptTarget(
	channelType string,
	channelName string,
	parentChannelName string,
	parentChannelType string,
) string {
	switch channelType {
	case "thread":
		if channelName == "" || parentChannelName == "" {
			return ""
		}
	case "dm":
		if channelName == "" {
			return ""
		}
	default:
		if channelName == "" {
			return ""
		}
	}
	return wakeMessageTarget(
		channelType,
		channelName,
		parentChannelName,
		parentChannelType,
	)
}

func pluralSuffix(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func changedTargetCount(count int) string {
	if count == 0 {
		return "no"
	}
	return fmt.Sprintf("%d", count)
}

func concreteResumePrompt(messages []json.RawMessage) string {
	rendered := make([]string, 0, len(messages))
	for _, raw := range messages {
		if message := formatWakeMessage(raw); message != "" {
			rendered = append(rendered, message)
		}
	}
	if len(rendered) == 0 {
		return ""
	}
	header := "New messages received:"
	if len(rendered) == 1 {
		header = "New message received:"
	}
	return header + "\n\n" + strings.Join(rendered, "\n") +
		"\n\nRespond as appropriate. Complete all your work before stopping.\n" +
		responseTargetHint
}

func unreadResumePrompt(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var unread map[string]int64
	if common.Unmarshal(raw, &unread) != nil || len(unread) == 0 {
		return "", false
	}
	targets := make([]string, 0, len(unread))
	for target := range unread {
		targets = append(targets, target)
	}
	sort.Strings(targets)
	var lines []string
	for _, target := range targets {
		lines = append(lines, fmt.Sprintf("- %s: %d unread", target, unread[target]))
	}
	return "You have unread messages from while you were offline:\n" +
		strings.Join(lines, "\n") +
		"\n\nUse `vela message read` to catch up on the channels listed above, then stop. " +
		"Read each listed channel at most once unless a read fails. Do NOT call `vela message check` " +
		"in this mode. If the history reveals a direct request, assignment, @mention, review request, " +
		"or task clearly addressed to you, switch into active handling instead of stopping: reply using " +
		"`vela message send --target <exact target>` and claim the relevant task with `vela task claim` " +
		"before starting work. Otherwise, do NOT send any message in this mode. " +
		persistentMessageDeliveryText, true
}

func formatWakeMessage(raw json.RawMessage) string {
	var message struct {
		MessageID         string `json:"message_id"`
		ChannelType       string `json:"channel_type"`
		ChannelName       string `json:"channel_name"`
		ParentChannelName string `json:"parent_channel_name"`
		ParentChannelType string `json:"parent_channel_type"`
		Target            string `json:"target"`
		SenderName        string `json:"sender_name"`
		SenderDescription string `json:"sender_description"`
		SenderType        string `json:"sender_type"`
		Source            string `json:"source"`
		Content           string `json:"content"`
		Text              string `json:"text"`
		Timestamp         string `json:"timestamp"`
	}
	if common.Unmarshal(raw, &message) != nil {
		return ""
	}
	target := strings.TrimSpace(message.Target)
	if target == "" {
		target = wakeMessageTarget(
			message.ChannelType,
			message.ChannelName,
			message.ParentChannelName,
			message.ParentChannelType,
		)
	}
	messageID := "-"
	if message.MessageID != "" {
		messageID = message.MessageID
	}
	observedAt := "-"
	if message.Timestamp != "" {
		observedAt = formatWakeMessageTime(message.Timestamp)
	}
	sender := "@" + message.SenderName
	if message.SenderDescription != "" {
		sender += " — " + message.SenderDescription
	}
	senderType := strings.TrimSpace(message.SenderType)
	if senderType == "" {
		senderType = strings.TrimSpace(message.Source)
	}
	content := message.Content
	if strings.TrimSpace(content) == "" {
		content = message.Text
	}
	return fmt.Sprintf(
		"[target=%s msg=%s time=%s type=%s] %s: %s",
		target,
		messageID,
		observedAt,
		senderType,
		sender,
		content,
	)
}

func deliveryText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var message struct {
		Text    string `json:"text"`
		Content string `json:"content"`
		Body    struct {
			Text    string `json:"text"`
			Content string `json:"content"`
		} `json:"body"`
	}
	if common.Unmarshal(raw, &message) != nil {
		return ""
	}
	for _, candidate := range []string{
		message.Text,
		message.Content,
		message.Body.Text,
		message.Body.Content,
	} {
		if strings.TrimSpace(candidate) != "" {
			return candidate
		}
	}
	return ""
}

func wakeMessageTarget(
	channelType string,
	channelName string,
	parentChannelName string,
	parentChannelType string,
) string {
	switch channelType {
	case "thread":
		shortID := shortWakeMessageID(channelName)
		if parentChannelType == "dm" {
			return "dm:@" + parentChannelName + ":" + shortID
		}
		return "#" + parentChannelName + ":" + shortID
	case "dm":
		return "dm:@" + channelName
	default:
		return "#" + channelName
	}
}

func shortWakeMessageID(messageID string) string {
	if strings.HasPrefix(messageID, "thread-") {
		messageID = strings.TrimPrefix(messageID, "thread-")
	}
	if len(messageID) > 8 {
		return messageID[:8]
	}
	return messageID
}

func formatWakeMessageTime(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return parsed.In(time.Local).Format("2006-01-02 15:04:05")
}
