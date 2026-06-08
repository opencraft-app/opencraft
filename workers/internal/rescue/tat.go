package rescue

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
)

type TATAgentStatus struct {
	InstanceID        string
	Status            string
	Environment       string
	LastHeartbeatTime string
	SupportedFeatures []string
}

type TATCommandResult struct {
	CommandID    string
	InvocationID string
	TaskID       string
	TaskStatus   string
	ExitCode     int
	Output       string
	OutputURL    string
	DroppedBytes int
	ErrorInfo    string
}

type tatClient interface {
	TAT(ctx context.Context, action string, payload map[string]any, dryRun bool) (map[string]any, error)
}

func DescribeTATAgentStatus(ctx context.Context, client tatClient, instanceID string) (TATAgentStatus, error) {
	resp, err := client.TAT(ctx, "DescribeAutomationAgentStatus", map[string]any{
		"InstanceIds": []string{instanceID},
	}, false)
	if err != nil {
		return TATAgentStatus{}, temporalActivityError(err)
	}
	set, _ := resp["AutomationAgentSet"].([]any)
	if len(set) == 0 {
		return TATAgentStatus{InstanceID: instanceID, Status: "Offline"}, nil
	}
	raw, _ := set[0].(map[string]any)
	return TATAgentStatus{
		InstanceID:        stringValue(raw["InstanceId"]),
		Status:            stringValue(raw["AgentStatus"]),
		Environment:       stringValue(raw["Environment"]),
		LastHeartbeatTime: stringValue(raw["LastHeartbeatTime"]),
		SupportedFeatures: stringSlice(raw["SupportFeatures"]),
	}, nil
}

func WaitTATOnline(ctx context.Context, client tatClient, instanceID string, timeout time.Duration) (TATAgentStatus, error) {
	deadline := time.Now().Add(timeout)
	var last TATAgentStatus
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return last, err
		}
		status, err := DescribeTATAgentStatus(ctx, client, instanceID)
		if err != nil {
			return TATAgentStatus{}, err
		}
		last = status
		recordHeartbeat(ctx, map[string]string{
			"kind":        "tat-agent",
			"instance_id": instanceID,
			"status":      status.Status,
			"environment": status.Environment,
		})
		fmt.Printf("[rescue] TAT agent status instance=%s status=%s environment=%s heartbeat=%s\n",
			instanceID, status.Status, status.Environment, status.LastHeartbeatTime)
		if status.Status == "Online" {
			return status, nil
		}
		if err := sleepContext(ctx, 5*time.Second); err != nil {
			return last, err
		}
	}
	return last, fmt.Errorf("timed out waiting for TAT agent online on %s; last=%s", instanceID, last.Status)
}

func RunTATCommandAndWait(ctx context.Context, client TencentClient, req ExportRequest, commandName string, script string, timeoutSeconds int) (TATCommandResult, error) {
	result, err := SubmitTATCommand(ctx, client, req, commandName, script, timeoutSeconds)
	if err != nil {
		return TATCommandResult{}, err
	}
	return WaitTATInvocation(ctx, client, result, time.Duration(timeoutSeconds+120)*time.Second)
}

func SubmitTATCommand(ctx context.Context, client tatClient, req ExportRequest, commandName string, script string, timeoutSeconds int) (TATCommandResult, error) {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 60
	}
	payload := map[string]any{
		"CommandName":      commandName,
		"SaveCommand":      false,
		"Description":      "rescue-exporter",
		"Content":          base64.StdEncoding.EncodeToString([]byte(script)),
		"CommandType":      "SHELL",
		"WorkingDirectory": req.TATWorkingDirectory,
		"Timeout":          timeoutSeconds,
		"InstanceIds":      []string{req.InstanceID},
		"Username":         req.TATUsername,
	}
	if req.TATOutputCOSBucketURL != "" {
		payload["OutputCOSBucketUrl"] = req.TATOutputCOSBucketURL
	}
	if req.TATOutputCOSKeyPrefix != "" {
		payload["OutputCOSKeyPrefix"] = req.TATOutputCOSKeyPrefix
	}

	fmt.Printf("[rescue] running TAT command instance=%s user=%s workdir=%s name=%s timeout=%d output_cos=%t\n",
		req.InstanceID, req.TATUsername, req.TATWorkingDirectory, commandName, timeoutSeconds, req.TATOutputCOSBucketURL != "")
	resp, err := client.TAT(ctx, "RunCommand", payload, !req.Execute)
	if err != nil {
		return TATCommandResult{}, temporalActivityError(err)
	}
	if !req.Execute {
		return TATCommandResult{CommandID: "dry-run-command", InvocationID: "dry-run-invocation", TaskStatus: "SUCCESS"}, nil
	}
	result := TATCommandResult{
		CommandID:    stringValue(resp["CommandId"]),
		InvocationID: stringValue(resp["InvocationId"]),
	}
	if result.InvocationID == "" {
		return result, temporalActivityError(fmt.Errorf("RunCommand returned no InvocationId: %v", resp))
	}
	fmt.Printf("[rescue] TAT command submitted command_id=%s invocation_id=%s\n", result.CommandID, result.InvocationID)
	return result, nil
}

func WaitTATInvocation(ctx context.Context, client tatClient, current TATCommandResult, timeout time.Duration) (TATCommandResult, error) {
	deadline := time.Now().Add(timeout)
	var heartbeat TATCommandResult
	if activity.IsActivity(ctx) && activity.HasHeartbeatDetails(ctx) {
		if err := activity.GetHeartbeatDetails(ctx, &heartbeat); err == nil && heartbeat.InvocationID != "" {
			current = heartbeat
		}
	}
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return current, err
		}
		task, err := DescribeTATInvocationTask(ctx, client, current.InvocationID)
		if err != nil {
			return current, err
		}
		if task.InvocationID != "" {
			current = task
		}
		recordHeartbeat(ctx, current)
		fmt.Printf("[rescue] TAT task status invocation_id=%s task_id=%s status=%s exit_code=%d dropped=%d output_url=%s error=%s\n",
			current.InvocationID, current.TaskID, current.TaskStatus, current.ExitCode, current.DroppedBytes, current.OutputURL, trimForLog(current.ErrorInfo, 512))
		switch current.TaskStatus {
		case "SUCCESS":
			return current, nil
		case "FAILED", "TIMEOUT", "TASK_TIMEOUT", "DELIVER_FAILED", "START_FAILED", "CANCELLED", "TERMINATED":
			return current, fmt.Errorf("TAT command failed status=%s exit_code=%d error=%s output=%s", current.TaskStatus, current.ExitCode, current.ErrorInfo, trimForLog(current.Output, 4096))
		}
		if err := sleepContext(ctx, 5*time.Second); err != nil {
			return current, err
		}
	}
	return current, fmt.Errorf("timed out waiting for TAT invocation %s; last=%s", current.InvocationID, current.TaskStatus)
}

func DescribeTATInvocationTask(ctx context.Context, client tatClient, invocationID string) (TATCommandResult, error) {
	resp, err := client.TAT(ctx, "DescribeInvocationTasks", map[string]any{
		"Filters": []map[string]any{
			{"Name": "invocation-id", "Values": []string{invocationID}},
		},
		"Limit":      10,
		"Offset":     0,
		"HideOutput": false,
	}, false)
	if err != nil {
		return TATCommandResult{}, temporalActivityError(err)
	}
	set, _ := resp["InvocationTaskSet"].([]any)
	if len(set) == 0 {
		return TATCommandResult{InvocationID: invocationID, TaskStatus: "PENDING"}, nil
	}
	raw, _ := set[0].(map[string]any)
	result := TATCommandResult{
		InvocationID: stringValue(raw["InvocationId"]),
		TaskID:       stringValue(raw["InvocationTaskId"]),
		CommandID:    stringValue(raw["CommandId"]),
		TaskStatus:   stringValue(raw["TaskStatus"]),
		ErrorInfo:    stringValue(raw["ErrorInfo"]),
	}
	if result.InvocationID == "" {
		result.InvocationID = invocationID
	}
	taskResult, _ := raw["TaskResult"].(map[string]any)
	result.ExitCode = intValue(taskResult["ExitCode"])
	result.DroppedBytes = intValue(taskResult["Dropped"])
	result.OutputURL = stringValue(taskResult["OutputUrl"])
	outputB64 := stringValue(taskResult["Output"])
	if outputB64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(outputB64)
		if err != nil {
			result.Output = outputB64
		} else {
			result.Output = string(decoded)
		}
	}
	return result, nil
}

func recordHeartbeat(ctx context.Context, details ...interface{}) {
	if activity.IsActivity(ctx) {
		activity.RecordHeartbeat(ctx, details...)
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := stringValue(item); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func intValue(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}
