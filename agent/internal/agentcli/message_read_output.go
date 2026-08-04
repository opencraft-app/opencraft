package agentcli

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"velachat/agent/internal/agentapi"
)

const (
	searchPreviewBefore   = 80
	searchPreviewAfter    = 120
	searchPreviewFallback = searchPreviewBefore + searchPreviewAfter
)

var (
	threadReplyTargetPattern = regexp.MustCompile(
		`^(?:#[^:]+|dm:@[^:]+):[0-9a-fA-F]{8}$`,
	)
	searchTokenPattern = regexp.MustCompile(`"([^"]+)"|\S+`)
	searchTagPattern   = regexp.MustCompile(
		`(?i)</?(?:result|preview|match)\b[^>]*>|<omit\s*/>`,
	)
	dmReferencePattern   = regexp.MustCompile(`\bdm:@([A-Za-z0-9][A-Za-z0-9_-]*)`)
	taskReferencePattern = regexp.MustCompile(`\btask #([0-9]+)\b`)
	userReferencePattern = regexp.MustCompile(
		"(^|[\\n\\s(\\[{\"'`;])@([A-Za-z0-9][A-Za-z0-9_-]*)",
	)
	channelReferencePattern = regexp.MustCompile(
		"(^|[\\n\\s(\\[{\"'`;])#([A-Za-z][A-Za-z0-9_-]*)",
	)
)

type historyResponse struct {
	Messages            []agentMessage `json:"messages"`
	HasMore             bool           `json:"has_more"`
	HasOlder            bool           `json:"has_older"`
	HasNewer            bool           `json:"has_newer"`
	LastReadSequence    *float64       `json:"last_read_seq"`
	HistoryLimited      bool           `json:"historyLimited"`
	HistoryLimitMessage string         `json:"historyLimitMessage"`
}

type historyFormatOptions struct {
	Before string
	After  string
	Around string
}

type searchResponse struct {
	Results []searchResult `json:"results"`
	HasMore bool           `json:"hasMore"`
}

type searchResult struct {
	ID                    string  `json:"id"`
	Sequence              float64 `json:"seq"`
	ChannelID             string  `json:"channelId"`
	ThreadID              *string `json:"threadId"`
	ParentMessageID       *string `json:"parentMessageId"`
	ParentMessageContent  *string `json:"parentMessageContent"`
	ParentChannelID       string  `json:"parentChannelId"`
	ParentChannelName     string  `json:"parentChannelName"`
	ParentChannelType     string  `json:"parentChannelType"`
	ParentChannelArchived *string `json:"parentChannelArchivedAt"`
	SenderID              string  `json:"senderId"`
	SenderType            string  `json:"senderType"`
	SenderName            string  `json:"senderName"`
	ChannelName           string  `json:"channelName"`
	ChannelType           string  `json:"channelType"`
	ChannelArchived       *string `json:"channelArchivedAt"`
	Content               string  `json:"content"`
	Snippet               string  `json:"snippet"`
	CreatedAt             string  `json:"createdAt"`
}

type resolveResponse struct {
	Message agentMessage `json:"message"`
}

func (a *App) runMessageRead(ctx context.Context, args []string) int {
	request, err := messageReadRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result historyResponse
	if err := a.client.Call(
		ctx,
		agentapi.HistoryRead,
		request,
		&result,
	); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	target := request.Query.Get("channel")
	_, _ = fmt.Fprintln(a.stdout, formatHistory(
		target,
		result,
		historyFormatOptions{
			Before: request.Query.Get("before"),
			After:  request.Query.Get("after"),
			Around: request.Query.Get("around"),
		},
	))
	var maxSequence float64
	for _, message := range result.Messages {
		if message.Sequence != nil &&
			!math.IsNaN(*message.Sequence) &&
			!math.IsInf(*message.Sequence, 0) &&
			*message.Sequence > maxSequence {
			maxSequence = *message.Sequence
		}
	}
	if maxSequence > 0 {
		recordConsumedSequenceUpdates(map[string]float64{
			target: maxSequence,
		})
	}
	return 0
}

func (a *App) runMessageSearch(ctx context.Context, args []string) int {
	request, err := messageSearchRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result searchResponse
	if err := a.client.Call(
		ctx,
		agentapi.MessageSearch,
		request,
		&result,
	); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(
		a.stdout,
		formatSearchResults(request.Query.Get("q"), result),
	)
	return 0
}

func (a *App) runMessageResolve(ctx context.Context, args []string) int {
	request, err := messageResolveRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result resolveResponse
	if err := a.client.Call(
		ctx,
		agentapi.MessageResolve,
		request,
		&result,
	); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	_, _ = fmt.Fprintln(a.stdout, formatMessages([]agentMessage{
		result.Message,
	}))
	return 0
}

func (a *App) runMessageReact(ctx context.Context, args []string) int {
	operation, request, err := messageReactionRequest(args)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var result map[string]any
	if err := a.client.Call(ctx, operation, request, &result); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	verb := "added to"
	if operation == agentapi.MessageReactionRemove {
		verb = "removed from"
	}
	messageID := request.Path["msgId"]
	emoji, _ := request.Body.(map[string]string)["emoji"]
	_, _ = fmt.Fprintf(
		a.stdout,
		"Reaction %s %s message %s.\n",
		emoji,
		verb,
		shortID(messageID),
	)
	return 0
}

func formatHistory(
	target string,
	data historyResponse,
	options historyFormatOptions,
) string {
	if len(data.Messages) == 0 {
		return "No messages in this channel."
	}
	count := len(data.Messages)
	minSequence := historyBoundary(data.Messages, 0)
	maxSequence := historyBoundary(data.Messages, count-1)
	rangeText := minSequence
	if minSequence != maxSequence {
		rangeText += "-" + maxSequence
	}
	lines := []string{fmt.Sprintf(
		"Read window: %d returned, seq %s, oldest to newest. %s %s",
		count,
		rangeText,
		historyCursorText("Older", data.HasOlder, "before", minSequence),
		historyCursorText("Newer", data.HasNewer, "after", maxSequence),
	)}
	if options.Around != "" {
		lines = append(lines, "Around: "+options.Around+".")
	}
	if data.HistoryLimited {
		message := data.HistoryLimitMessage
		if message == "" {
			message = "Message history is limited on this plan."
		}
		lines = append(lines, message)
	}
	if data.LastReadSequence != nil &&
		*data.LastReadSequence > 0 &&
		options.After == "" &&
		options.Before == "" &&
		options.Around == "" {
		sequence := numberText(*data.LastReadSequence)
		lines = append(lines, fmt.Sprintf(
			"Server unread cursor before this read: seq %s. "+
				"Use vela message read --target \"%s\" --after %s "+
				"to browse newer messages.",
			sequence,
			target,
			sequence,
		))
	}
	formatted := make([]string, 0, count)
	for index, message := range data.Messages {
		formatted = append(
			formatted,
			formatHistoryMessage(target, message, index, count),
		)
	}
	return strings.Join(lines, "\n") + "\n\n" +
		strings.Join(formatted, "\n") + "\n\n" +
		fmt.Sprintf("End of window: %d/%d shown.", count, count)
}

func historyBoundary(messages []agentMessage, index int) string {
	if index < 0 || index >= len(messages) ||
		messages[index].Sequence == nil ||
		math.IsNaN(*messages[index].Sequence) ||
		math.IsInf(*messages[index].Sequence, 0) {
		return "-"
	}
	return numberText(*messages[index].Sequence)
}

func historyCursorText(
	label string,
	exists bool,
	flag string,
	anchor string,
) string {
	if exists {
		return fmt.Sprintf("%s exist: --%s %s.", label, flag, anchor)
	}
	return "No " + strings.ToLower(label) + "."
}

func formatHistoryMessage(
	target string,
	message agentMessage,
	index int,
	total int,
) string {
	senderName := firstNonempty(message.SenderNameCamel, message.SenderName)
	if senderName == "" {
		senderName = "unknown"
	}
	senderDescription := firstStringPointer(
		message.SenderDescriptionCamel,
		message.SenderDescription,
	)
	messageID := firstNonempty(message.ID, message.MessageID)
	if messageID == "" {
		messageID = "-"
	}
	createdAt := firstNonempty(message.CreatedAt, message.Timestamp)
	senderType := firstNonempty(message.SenderTypeCamel, message.SenderType)
	header := []string{
		fmt.Sprintf("%d/%d", index+1, total),
		"seq=" + historyBoundary([]agentMessage{message}, 0),
		"msg=" + messageID,
		"time=" + formatLocalTime(createdAt),
	}
	if senderType != "" {
		header = append(header, "type="+senderType)
	}
	if message.ThreadID != nil && *message.ThreadID != "" {
		header = append(header, "threadId="+*message.ThreadID)
	}
	if message.ReplyCount != nil && *message.ReplyCount > 0 {
		header = append(
			header,
			"replyCount="+strconv.Itoa(*message.ReplyCount),
		)
	}
	if message.ThreadID != nil && *message.ThreadID != "" ||
		message.ReplyCount != nil && *message.ReplyCount > 0 {
		if replyTarget := buildHistoryReplyTarget(target, messageID); replyTarget != "" {
			header = append(header, "replyTarget="+replyTarget)
		}
	}
	handle := "@" + senderName
	if senderDescription != nil {
		handle += " — " + *senderDescription
	}
	return fmt.Sprintf(
		"[%s] %s: %s%s%s",
		strings.Join(header, " "),
		handle,
		message.Content,
		formatAttachmentSuffix(message.Attachments),
		formatHistoryTaskSuffix(message),
	)
}

func buildHistoryReplyTarget(target string, messageID string) string {
	if messageID == "" || threadReplyTargetPattern.MatchString(target) {
		return ""
	}
	return target + ":" + shortID(messageID)
}

func formatHistoryTaskSuffix(message agentMessage) string {
	if message.TaskStatusCamel == nil || *message.TaskStatusCamel == "" {
		return ""
	}
	number := "undefined"
	if message.TaskNumberCamel != nil {
		number = numberText(*message.TaskNumberCamel)
	}
	assigneeID := message.TaskAssigneeIDCamel
	assigneeName := firstStringPointer(
		message.TaskAssigneeNameCamel,
		message.TaskAssigneeName,
	)
	assignee := ""
	if assigneeID != nil && *assigneeID != "" {
		if assigneeName != nil && *assigneeName != "" {
			assignee = " assignee=@" + *assigneeName
		} else {
			assignee = " assignee=<unresolved>"
		}
	}
	return fmt.Sprintf(
		" [task #%s status=%s%s]",
		number,
		*message.TaskStatusCamel,
		assignee,
	)
}

func formatSearchResults(query string, data searchResponse) string {
	if len(data.Results) == 0 {
		return "No search results."
	}
	trimmedQuery := strings.TrimSpace(query)
	results := make([]string, 0, len(data.Results))
	for _, result := range data.Results {
		content := result.Content
		if content == "" {
			content = result.Snippet
		}
		sender := neutralizeReferences(result.SenderName)
		if sender == "" {
			sender = "unknown"
		}
		senderType := ""
		if result.SenderType != "" {
			senderType = " (" + result.SenderType + ")"
		}
		results = append(results, strings.Join([]string{
			`<result ref="msg:` + result.ID + `">`,
			"Source: " + renderSearchSource(result),
			"Sender: " + sender + senderType,
			"Time: " + formatLocalTime(result.CreatedAt),
			"",
			"<preview>",
			renderSearchPreview(content, trimmedQuery),
			"</preview>",
			"</result>",
		}, "\n"))
	}
	label := "results"
	if len(data.Results) == 1 {
		label = "result"
	}
	header := fmt.Sprintf(
		"Filtered message results (%d %s)",
		len(data.Results),
		label,
	)
	if trimmedQuery != "" {
		header = fmt.Sprintf(
			"Search results for: %q (%d %s)",
			trimmedQuery,
			len(data.Results),
			label,
		)
	}
	return header + "\n\n" +
		strings.Join(results, "\n\n") + "\n\n" +
		"If a result may be relevant but its preview is not enough, " +
		"read the surrounding context for that result before answering."
}

func renderSearchSource(result searchResult) string {
	switch result.ChannelType {
	case "thread":
		shortThreadID := strings.TrimPrefix(result.ChannelName, "thread-")
		if shortThreadID == result.ChannelName &&
			result.ThreadID != nil &&
			*result.ThreadID != "" {
			shortThreadID = shortID(*result.ThreadID)
		}
		parent := result.ParentChannelName
		if parent == "" {
			parent = "unknown"
		}
		if result.ParentChannelType == "dm" {
			return "dm:" + neutralizeReferences(parent) + ":" + shortThreadID
		}
		return "thread:" + neutralizeReferences(parent) + ":" + shortThreadID
	case "dm":
		name := result.ChannelName
		if name == "" {
			name = "unknown"
		}
		return "dm:" + neutralizeReferences(name)
	default:
		name := result.ChannelName
		if name == "" {
			name = "unknown"
		}
		return "channel:" + neutralizeReferences(name)
	}
}

type textRange struct {
	start int
	end   int
}

func renderSearchPreview(content string, query string) string {
	match, found := findSearchMatch(content, strings.TrimSpace(query))
	if found {
		match = expandMatchToReference(content, match)
	}
	start := 0
	end := min(len(content), searchPreviewFallback)
	if found {
		start = max(0, match.start-searchPreviewBefore)
		end = min(len(content), match.end+searchPreviewAfter)
	}
	start, end = trimPreview(content, start, end)
	leading := ""
	if start > 0 {
		leading = "<omit />"
	}
	trailing := ""
	if end < len(content) {
		trailing = "<omit />"
	}
	if !found || match.end <= start || match.start >= end {
		return leading + renderPreviewText(content[start:end]) + trailing
	}
	return leading +
		renderPreviewText(content[start:match.start]) +
		"<match>" +
		renderPreviewText(content[match.start:match.end]) +
		"</match>" +
		renderPreviewText(content[match.end:end]) +
		trailing
}

func findSearchMatch(content string, query string) (textRange, bool) {
	if query == "" {
		return textRange{}, false
	}
	lowerContent := strings.ToLower(content)
	if index := strings.Index(lowerContent, strings.ToLower(query)); index >= 0 {
		return textRange{start: index, end: index + len(query)}, true
	}
	for _, token := range searchTokenPattern.FindAllString(query, -1) {
		token = strings.Trim(strings.TrimSpace(token), `"`)
		if token == "" {
			continue
		}
		if index := strings.Index(lowerContent, strings.ToLower(token)); index >= 0 {
			return textRange{start: index, end: index + len(token)}, true
		}
	}
	return textRange{}, false
}

func expandMatchToReference(content string, match textRange) textRange {
	for _, reference := range referenceRanges(content) {
		if match.start < reference.end && match.end > reference.start {
			return textRange{
				start: min(match.start, reference.start),
				end:   max(match.end, reference.end),
			}
		}
	}
	return match
}

func referenceRanges(content string) []textRange {
	ranges := make([]textRange, 0)
	for _, pattern := range []*regexp.Regexp{
		dmReferencePattern,
		taskReferencePattern,
	} {
		for _, indexes := range pattern.FindAllStringIndex(content, -1) {
			ranges = append(ranges, textRange{start: indexes[0], end: indexes[1]})
		}
	}
	for _, pattern := range []*regexp.Regexp{
		userReferencePattern,
		channelReferencePattern,
	} {
		for _, indexes := range pattern.FindAllStringSubmatchIndex(content, -1) {
			start := indexes[0]
			if indexes[2] >= 0 {
				start += indexes[3] - indexes[2]
			}
			ranges = append(ranges, textRange{start: start, end: indexes[1]})
		}
	}
	return ranges
}

func trimPreview(content string, start int, end int) (int, int) {
	for start > 0 && start < len(content) && isPreviewWhitespace(content[start]) {
		start++
	}
	for end < len(content) && end > 0 && isPreviewWhitespace(content[end-1]) {
		end--
	}
	return max(0, min(start, len(content))), max(0, min(end, len(content)))
}

func isPreviewWhitespace(value byte) bool {
	switch value {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	default:
		return false
	}
}

func renderPreviewText(text string) string {
	text = searchTagPattern.ReplaceAllStringFunc(text, func(tag string) string {
		tag = strings.ReplaceAll(tag, "&", "&amp;")
		tag = strings.ReplaceAll(tag, "<", "&lt;")
		return strings.ReplaceAll(tag, ">", "&gt;")
	})
	return neutralizeReferences(text)
}

func neutralizeReferences(text string) string {
	text = dmReferencePattern.ReplaceAllString(text, "dm:user:$1")
	text = taskReferencePattern.ReplaceAllString(text, "task:$1")
	text = userReferencePattern.ReplaceAllString(text, "${1}user:$2")
	return channelReferencePattern.ReplaceAllString(text, "${1}channel:$2")
}

func numberText(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstStringPointer(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
