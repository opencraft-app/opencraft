package agentcli

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
)

type taskListResponse struct {
	Tasks []taskSummary `json:"tasks"`
}

type taskSummary struct {
	TaskNumber    *int    `json:"taskNumber"`
	Status        string  `json:"status"`
	Title         string  `json:"title"`
	ClaimedByID   *string `json:"claimedById"`
	ClaimedByName *string `json:"claimedByName"`
	CreatedByName *string `json:"createdByName"`
	MessageID     *string `json:"messageId"`
}

type taskClaimResponse struct {
	Results []taskClaimResult `json:"results"`
}

type taskClaimResult struct {
	TaskNumber *int   `json:"taskNumber"`
	MessageID  string `json:"messageId"`
	Success    bool   `json:"success"`
	Reason     string `json:"reason"`
}

func (a *App) runTaskCommand(
	ctx context.Context,
	commandPath string,
	operation agentapi.Operation,
	args []string,
) int {
	var request agentapi.Request
	var err error
	switch commandPath {
	case "task list":
		request, err = taskListRequest(args)
	case "task claim":
		request, err = taskClaimRequest(args)
	case "task update":
		request, err = taskUpdateRequest(args)
	default:
		err = fmt.Errorf("unsupported task command %q", commandPath)
	}
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 2
	}
	var payload map[string]any
	if err := a.client.Call(ctx, operation, request, &payload); err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	data, err := common.Marshal(payload)
	if err != nil {
		_, _ = fmt.Fprintln(a.stderr, err)
		return 1
	}
	target := taskTarget(request)

	switch commandPath {
	case "task list":
		var response taskListResponse
		if err := common.Unmarshal(data, &response); err != nil {
			_, _ = fmt.Fprintln(a.stderr, err)
			return 1
		}
		_, _ = fmt.Fprintln(
			a.stdout,
			formatTaskList(target, request.Query.Get("status"), response),
		)
	case "task claim":
		var response taskClaimResponse
		if err := common.Unmarshal(data, &response); err != nil {
			_, _ = fmt.Fprintln(a.stderr, err)
			return 1
		}
		_, _ = fmt.Fprintln(a.stdout, formatTaskClaim(target, response))
	case "task update":
		body, _ := request.Body.(map[string]any)
		status, _ := body["status"].(string)
		_, _ = fmt.Fprintf(
			a.stdout,
			"#%d moved to %s.\n",
			taskNumber(request),
			status,
		)
	}
	return 0
}

func formatTaskList(
	target string,
	statusFilter string,
	response taskListResponse,
) string {
	if len(response.Tasks) == 0 {
		status := ""
		if statusFilter != "" && statusFilter != "all" {
			status = " " + statusFilter
		}
		return fmt.Sprintf("No%s tasks in %s.", status, target)
	}
	lines := make([]string, 0, len(response.Tasks))
	for _, task := range response.Tasks {
		assignee := ""
		if task.ClaimedByID != nil && *task.ClaimedByID != "" {
			assignee = " → <unresolved>"
			if task.ClaimedByName != nil && *task.ClaimedByName != "" {
				assignee = " → @" + *task.ClaimedByName
			}
		}
		creator := ""
		if task.CreatedByName != nil && *task.CreatedByName != "" {
			creator = " (by @" + *task.CreatedByName + ")"
		}
		messageID := ""
		if task.MessageID != nil && *task.MessageID != "" {
			messageID = " msg=" + shortID(*task.MessageID)
		}
		lines = append(lines, fmt.Sprintf(
			"#%s [%s] %s%s%s%s",
			optionalTaskNumber(task.TaskNumber),
			task.Status,
			task.Title,
			assignee,
			creator,
			messageID,
		))
	}
	return fmt.Sprintf(
		"## Task Board for %s (%d tasks)\n\n%s",
		target,
		len(response.Tasks),
		strings.Join(lines, "\n"),
	)
}

func formatTaskClaim(target string, response taskClaimResponse) string {
	lines := make([]string, 0, len(response.Results))
	threadHints := make([]string, 0, len(response.Results))
	succeeded := 0
	for _, result := range response.Results {
		label := "msg:" + result.MessageID
		if result.TaskNumber != nil {
			label = "#" + strconv.Itoa(*result.TaskNumber)
		}
		if result.Success {
			succeeded++
			lines = append(lines, fmt.Sprintf(
				"%s (msg:%s): claimed",
				label,
				shortID(result.MessageID),
			))
			if result.TaskNumber != nil && result.MessageID != "" {
				threadHints = append(threadHints, fmt.Sprintf(
					"#%d → raft message send --target %q",
					*result.TaskNumber,
					canonicalTaskTarget(target)+":"+shortID(result.MessageID),
				))
			}
			continue
		}
		if result.Reason == "already claimed by you" {
			lines = append(lines, label+": already claimed by you.")
			continue
		}
		reason := result.Reason
		if reason == "" {
			reason = "already claimed"
		}
		lines = append(lines, fmt.Sprintf(
			"%s: FAILED — %s. Do not work on this task unless an owner/admin "+
				"explicitly redirects it to you.",
			label,
			reason,
		))
	}
	failed := len(response.Results) - succeeded
	summary := fmt.Sprintf("%d claimed", succeeded)
	if failed > 0 {
		summary += fmt.Sprintf(", %d failed", failed)
	}
	output := fmt.Sprintf(
		"Claim results (%s):\n%s",
		summary,
		strings.Join(lines, "\n"),
	)
	if len(threadHints) > 0 {
		output += "\n\nFollow up in each task's thread:\n" +
			strings.Join(threadHints, "\n")
	}
	return output
}

func taskTarget(request agentapi.Request) string {
	if target := request.Query.Get("channel"); target != "" {
		return target
	}
	body, _ := request.Body.(map[string]any)
	target, _ := body["channel"].(string)
	return target
}

func taskNumber(request agentapi.Request) int {
	body, _ := request.Body.(map[string]any)
	switch value := body["task_number"].(type) {
	case int:
		return value
	case float64:
		return int(value)
	default:
		return 0
	}
}

func optionalTaskNumber(number *int) string {
	if number == nil {
		return "undefined"
	}
	return strconv.Itoa(*number)
}

func canonicalTaskTarget(target string) string {
	if strings.HasPrefix(strings.ToLower(target), "dm:user:") {
		return "dm:@" + target[len("dm:user:"):]
	}
	return target
}
