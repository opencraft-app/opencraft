package agentcli

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
)

const (
	maxMessageDrainRounds = 50

	nonMemberMentionGuidance = "[Raft notice: You were notified as a non-member, " +
		"so you cannot reply in that channel. If no reply is needed, no action is " +
		"required. Otherwise, DM the person who mentioned you or join the channel " +
		"to participate.]"
)

type messageCheckResponse struct {
	Events           []agentMessage `json:"events"`
	LastSeenMessage  *string        `json:"last_seen_msgId"`
	LastSeenSequence *float64       `json:"last_seen_seq"`
	ReplyTarget      *string        `json:"reply_target"`
	PendingNotices   []string       `json:"pending_notice_ids"`
	WakeReason       *string        `json:"wake_reason"`
	HasMore          bool           `json:"has_more"`
}

type agentMessage struct {
	Sequence               *float64          `json:"seq"`
	ID                     string            `json:"id"`
	MessageID              string            `json:"message_id"`
	Timestamp              string            `json:"timestamp"`
	CreatedAt              string            `json:"createdAt"`
	SenderType             string            `json:"sender_type"`
	SenderTypeCamel        string            `json:"senderType"`
	SenderName             string            `json:"sender_name"`
	SenderNameCamel        string            `json:"senderName"`
	SenderDescription      *string           `json:"sender_description"`
	SenderDescriptionCamel *string           `json:"senderDescription"`
	ChannelType            string            `json:"channel_type"`
	ChannelName            string            `json:"channel_name"`
	ParentChannelType      string            `json:"parent_channel_type"`
	ParentChannelName      string            `json:"parent_channel_name"`
	Content                string            `json:"content"`
	Attachments            []agentAttachment `json:"attachments"`
	TaskStatus             *string           `json:"task_status"`
	TaskStatusCamel        *string           `json:"taskStatus"`
	TaskNumber             *float64          `json:"task_number"`
	TaskNumberCamel        *float64          `json:"taskNumber"`
	TaskAssigneeID         *string           `json:"task_assignee_id"`
	TaskAssigneeIDCamel    *string           `json:"taskAssigneeId"`
	TaskAssigneeName       *string           `json:"task_assignee_name"`
	TaskAssigneeNameCamel  *string           `json:"taskAssigneeName"`
	ThreadID               *string           `json:"threadId"`
	ReplyCount             *int              `json:"replyCount"`
	NonMemberMention       bool              `json:"non_member_mention"`
	ThirdPartyEvent        *thirdPartyEvent  `json:"third_party_event"`
}

type agentAttachment struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
}

type thirdPartyEvent struct {
	ID          string            `json:"id"`
	Kind        string            `json:"kind"`
	PayloadHash string            `json:"payload_hash"`
	ClientID    string            `json:"client_id"`
	ClientName  string            `json:"client_name"`
	Source      *thirdPartySource `json:"source"`
	Payload     json.RawMessage   `json:"payload"`
}

type thirdPartySource struct {
	Resource          string `json:"resource"`
	AccessTokenIDHash string `json:"access_token_id_hash"`
}

type inboxCheckResponse struct {
	Rows []inboxTargetRow `json:"rows"`
}

type inboxTargetRow struct {
	Target           string         `json:"target"`
	PendingCount     int            `json:"pendingCount"`
	FirstPendingID   string         `json:"firstPendingMsgId"`
	LatestMessageID  string         `json:"latestMsgId"`
	LatestSenderName string         `json:"latestSenderName"`
	Flags            []string       `json:"flags"`
	AttentionHint    *attentionHint `json:"attentionHint"`
}

type attentionHint struct {
	Schema           string               `json:"schema,omitempty"`
	Trigger          string               `json:"trigger,omitempty"`
	Scope            string               `json:"scope,omitempty"`
	SuggestedCommand string               `json:"suggested_command,omitempty"`
	Copy             string               `json:"copy,omitempty"`
	CopyVersion      string               `json:"copy_version,omitempty"`
	EpochMillis      *int64               `json:"epoch_ms,omitempty"`
	Thresholds       *attentionThresholds `json:"thresholds,omitempty"`
}

type attentionThresholds struct {
	UpperK       *int `json:"K,omitempty"`
	LowerK       *int `json:"k,omitempty"`
	WindowMillis int  `json:"window_ms"`
	N            *int `json:"n,omitempty"`
}

type consumedSequenceState struct {
	Targets map[string]float64 `json:"targets"`
}

func (a *App) runMessageCheck(ctx context.Context, args []string) int {
	if _, err := noOptionRequest(args); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}

	messages := make([]agentMessage, 0)
	hasMore := false
	drainComplete := false
	for round := 0; round < maxMessageDrainRounds; round++ {
		var page messageCheckResponse
		err := a.client.Call(ctx, agentapi.Events, agentapi.Request{
			Path: make(map[string]string),
			Query: url.Values{
				"since": []string{"latest"},
			},
		}, &page)
		if err != nil {
			if len(messages) == 0 {
				_, _ = fmt.Fprintln(a.stderr, err)
				return 1
			}
			hasMore = true
			break
		}
		messages = append(messages, page.Events...)
		hasMore = page.HasMore
		drainComplete = !hasMore && len(messages) > 0
		if hasMore && len(page.Events) > 0 {
			continue
		}
		break
	}

	sortMessages(messages)
	output := formatMessages(messages)
	switch {
	case hasMore:
		output += "\nMore messages are pending. Run `raft message check` again.\n"
	case drainComplete:
		output += "\nNo more new messages.\n"
	default:
		output += "\n"
	}
	_, _ = fmt.Fprint(a.stdout, output)
	recordConsumedSequences(messages)
	return 0
}

func (a *App) runInboxCheck(ctx context.Context, args []string) int {
	if _, err := noOptionRequest(args); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result inboxCheckResponse
	if err := a.client.Call(
		ctx,
		agentapi.InboxCheck,
		agentapi.Request{
			Path:  make(map[string]string),
			Query: make(url.Values),
		},
		&result,
	); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(a.stdout, formatInboxSnapshot(result.Rows))
	return 0
}

func sortMessages(messages []agentMessage) {
	sort.SliceStable(messages, func(left int, right int) bool {
		return sortableSequence(messages[left].Sequence) <
			sortableSequence(messages[right].Sequence)
	})
}

func sortableSequence(sequence *float64) float64 {
	if sequence == nil ||
		*sequence <= 0 ||
		math.IsNaN(*sequence) ||
		math.IsInf(*sequence, 0) ||
		math.Trunc(*sequence) != *sequence {
		return math.MaxFloat64
	}
	return *sequence
}

func formatMessages(messages []agentMessage) string {
	if len(messages) == 0 {
		return "No new messages."
	}
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		lines = append(lines, formatMessage(message))
	}
	return strings.Join(lines, "\n")
}

func formatMessage(message agentMessage) string {
	if message.ThirdPartyEvent != nil {
		return formatThirdPartyMessage(message, *message.ThirdPartyEvent)
	}
	messageID := shortID(message.MessageID)
	if messageID == "" {
		messageID = "-"
	}
	senderType := message.SenderType
	content := message.Content
	return fmt.Sprintf(
		"[target=%s msg=%s time=%s type=%s] %s: %s%s%s%s",
		formatMessageTarget(message),
		messageID,
		formatLocalTime(message.Timestamp),
		senderType,
		formatSender(message),
		content,
		formatAttachmentSuffix(message.Attachments),
		formatTaskSuffix(message),
		formatReplyAffordance(message.NonMemberMention),
	)
}

func formatThirdPartyMessage(
	message agentMessage,
	event thirdPartyEvent,
) string {
	messageID := shortID(message.MessageID)
	if messageID == "" {
		messageID = shortID(event.ID)
	}
	sourceSuffix := ""
	if event.Source != nil && event.Source.Resource != "" {
		sourceSuffix = "; resource=" + event.Source.Resource
		if event.Source.AccessTokenIDHash != "" {
			sourceSuffix += "; access_token_id_hash=" +
				event.Source.AccessTokenIDHash
		}
	}
	provenance := "kind=" + event.Kind +
		"; payload_hash=" + event.PayloadHash +
		sourceSuffix
	output := fmt.Sprintf(
		"[target=agent-event:%s msg=%s time=%s type=third_party_app] @%s — %s: %s\n%s",
		shortID(event.ID),
		messageID,
		formatLocalTime(message.Timestamp),
		event.ClientID,
		event.ClientName,
		provenance,
		message.Content,
	)
	if len(event.Payload) > 0 && string(event.Payload) != "null" {
		output += "\npayload:\n" + string(event.Payload)
	}
	return output
}

func formatMessageTarget(message agentMessage) string {
	if message.ThirdPartyEvent != nil {
		return "agent-event:" + shortID(message.ThirdPartyEvent.ID)
	}
	if message.ChannelType == "thread" && message.ParentChannelName != "" {
		threadID := strings.TrimPrefix(message.ChannelName, "thread-")
		if message.ParentChannelType == "dm" {
			return "dm:@" + message.ParentChannelName + ":" + threadID
		}
		return "#" + message.ParentChannelName + ":" + threadID
	}
	if message.ChannelType == "dm" {
		return "dm:@" + message.ChannelName
	}
	return "#" + message.ChannelName
}

func formatSender(message agentMessage) string {
	name := message.SenderName
	if name == "" {
		name = "unknown"
	}
	if message.SenderDescription != nil {
		return "@" + name + " — " + *message.SenderDescription
	}
	return "@" + name
}

func formatAttachmentSuffix(attachments []agentAttachment) string {
	if len(attachments) == 0 {
		return ""
	}
	items := make([]string, 0, len(attachments))
	for _, attachment := range attachments {
		items = append(items, fmt.Sprintf(
			"%s (id:%s)",
			attachment.Filename,
			attachment.ID,
		))
	}
	return fmt.Sprintf(
		" [%d attachment%s: %s — use raft attachment view to download]",
		len(attachments),
		pluralSuffix(len(attachments)),
		strings.Join(items, ", "),
	)
}

func formatTaskSuffix(message agentMessage) string {
	if message.TaskStatus == nil || *message.TaskStatus == "" {
		return ""
	}
	number := "undefined"
	if message.TaskNumber != nil {
		number = strconv.FormatFloat(*message.TaskNumber, 'f', -1, 64)
	}
	assignee := ""
	if message.TaskAssigneeID != nil && *message.TaskAssigneeID != "" {
		if message.TaskAssigneeName != nil && *message.TaskAssigneeName != "" {
			assignee = " assignee=@" + *message.TaskAssigneeName
		} else {
			assignee = " assignee=<unresolved>"
		}
	}
	return fmt.Sprintf(
		" [task #%s status=%s%s]",
		number,
		*message.TaskStatus,
		assignee,
	)
}

func formatReplyAffordance(nonMemberMention bool) string {
	if !nonMemberMention {
		return ""
	}
	return "\n" + nonMemberMentionGuidance
}

func formatLocalTime(timestamp string) string {
	if timestamp == "" {
		return "-"
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return timestamp
	}
	return parsed.Local().Format("2006-01-02 15:04:05")
}

func formatInboxSnapshot(rows []inboxTargetRow) string {
	if len(rows) == 0 {
		return "Inbox: empty"
	}
	parts := []string{
		fmt.Sprintf(
			"Inbox: %d pending target%s",
			len(rows),
			pluralSuffix(len(rows)),
		),
		"",
	}
	for _, row := range rows {
		parts = append(parts, row.Target, formatInboxRow(row), "")
	}
	return strings.TrimRight(strings.Join(parts, "\n"), "\n")
}

func formatInboxRow(row inboxTargetRow) string {
	parts := []string{fmt.Sprintf(
		"pending: %d message%s",
		row.PendingCount,
		pluralSuffix(row.PendingCount),
	)}
	if row.FirstPendingID != "" {
		parts = append(parts, "first msg="+row.FirstPendingID)
	}
	if row.LatestSenderName != "" {
		parts = append(parts, "latest sender @"+row.LatestSenderName)
	}
	if row.LatestMessageID != "" {
		parts = append(parts, "latest msg="+row.LatestMessageID)
	}
	for _, flag := range row.Flags {
		switch flag {
		case "mention":
			parts = append(parts, "you were mentioned")
		case "non_member_mention":
			parts = append(parts, nonMemberMentionGuidance)
		default:
			parts = append(parts, flag)
		}
	}
	if row.AttentionHint != nil {
		if encoded, err := common.Marshal(row.AttentionHint); err == nil {
			parts = append(parts, "attention_hint="+string(encoded))
		}
	}
	return strings.Join(parts, " · ")
}

func shortID(value string) string {
	parts := strings.Split(value, "-")
	if len(parts) == 3 && len(parts[0]) >= 10 && len(parts[1]) >= 10 &&
		len(parts[2]) >= 8 && decimalIDPart(parts[0]) &&
		decimalIDPart(parts[1]) && decimalIDPart(parts[2]) {
		// Tencent message IDs share a conversation prefix. Keeping only the first
		// eight bytes makes Thread references and confirmations ambiguous.
		return value
	}
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}

func decimalIDPart(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return value != ""
}

func pluralSuffix(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func recordConsumedSequences(messages []agentMessage) {
	updates := make(map[string]float64)
	for _, message := range messages {
		if message.Sequence == nil ||
			math.IsNaN(*message.Sequence) ||
			math.IsInf(*message.Sequence, 0) ||
			*message.Sequence <= 0 {
			continue
		}
		target := formatMessageTarget(message)
		if target != "" && *message.Sequence > updates[target] {
			updates[target] = *message.Sequence
		}
	}
	if len(updates) == 0 {
		return
	}
	recordConsumedSequenceUpdates(updates)
}

func recordConsumedSequenceUpdates(updates map[string]float64) {
	agentID := strings.TrimSpace(os.Getenv("SLOCK_AGENT_ID"))
	store, relativePath, ok := consumedSequenceStore(agentID)
	if !ok {
		return
	}
	var consumed consumedSequenceState
	if err := store.Read(relativePath, &consumed); err != nil &&
		!os.IsNotExist(err) {
		return
	}
	if consumed.Targets == nil {
		consumed.Targets = make(map[string]float64)
	}
	changed := false
	for target, sequence := range updates {
		if sequence > consumed.Targets[target] {
			consumed.Targets[target] = sequence
			changed = true
		}
	}
	if changed {
		_ = store.Write(relativePath, consumed)
	}
}

func consumedSequenceStore(agentID string) (*state.Store, string, bool) {
	if agentID == "" ||
		filepath.Base(agentID) != agentID ||
		agentID == "." ||
		agentID == ".." {
		return nil, "", false
	}
	root := strings.TrimSpace(os.Getenv("SLOCK_CLI_CONSUMED_SEQ_STATE_DIR"))
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(home) {
			return nil, "", false
		}
		root = state.DefaultRoot(home)
		return state.New(root), filepath.Join(
			"agents",
			agentID,
			"runtime",
			"slock-cli-consumed-seq.json",
		), true
	}
	return state.New(root), filepath.Join(
		"slock-cli-consumed-seq",
		agentID,
		"consumed-seqs.json",
	), true
}
