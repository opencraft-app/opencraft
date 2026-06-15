package wrapper

import (
	"context"
	"encoding/json"
	"fmt"
)

type sidecarRunStatusResponse struct {
	OK             bool   `json:"ok"`
	RunID          string `json:"run_id"`
	SessionID      string `json:"session_id"`
	Status         string `json:"status"`
	EventCount     int64  `json:"event_count"`
	ResultReadable bool   `json:"result_readable"`
	Error          string `json:"error"`
}

func (w *AgentSidecarWorker) sidecarRunStatus(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, runID string) (sidecarRunStatusResponse, CommandResult, error) {
	command := fmt.Sprintf(
		"%s client --addr %s run-status --run-id %s",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(runID),
	)
	result, err := w.runOuterCommand(ctx, host, sb, runtime, command, nil, nil, nil)
	if err != nil {
		return sidecarRunStatusResponse{}, result, err
	}
	var response sidecarRunStatusResponse
	if err := json.Unmarshal([]byte(lastJSONLine(result.Stdout)), &response); err != nil {
		return sidecarRunStatusResponse{}, result, fmt.Errorf("decode sidecar run status: %w", err)
	}
	return response, result, nil
}

func (w *AgentSidecarWorker) sidecarRunResult(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, runID string) (CommandResult, error) {
	command := fmt.Sprintf(
		"%s client --addr %s run-result --run-id %s",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(runID),
	)
	return w.runOuterCommand(ctx, host, sb, runtime, command, nil, nil, nil)
}

func (w *AgentSidecarWorker) sidecarRunEvents(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, runID string, afterSeq int64) (CommandResult, error) {
	if afterSeq < 0 {
		afterSeq = 0
	}
	command := fmt.Sprintf(
		"%s client --addr %s run-events --run-id %s --after-seq %d",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(runID),
		afterSeq,
	)
	return w.runOuterCommand(ctx, host, sb, runtime, command, nil, nil, nil)
}

func (w *AgentSidecarWorker) SessionRuntimeRunResult(ctx context.Context, runtime ACPSessionRuntime, sessionID, runID string) (ACPSessionRuntimeRunResult, error) {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return ACPSessionRuntimeRunResult{}, fmt.Errorf("runtime identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntimeRunResult{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	status, _, err := w.sidecarRunStatus(ctx, backend.host, sb, runtime, runID)
	if err != nil {
		return ACPSessionRuntimeRunResult{}, err
	}
	result := ACPSessionRuntimeRunResult{
		RunID:        firstNonEmpty(status.RunID, runID),
		Status:       status.Status,
		ErrorMessage: status.Error,
	}
	if mappedStatus, stopReason, errorMessage, ok := cloudAgentRuntimeRunStatus(ACPSessionRuntimeRunRecord{
		RunID:        result.RunID,
		SessionID:    firstNonEmpty(status.SessionID, sessionID),
		Status:       status.Status,
		ErrorMessage: status.Error,
	}); ok {
		result.Status = mappedStatus
		result.StopReason = stopReason
		result.ErrorMessage = firstNonEmpty(errorMessage, result.ErrorMessage)
	}
	if !status.ResultReadable && status.Error == "" {
		return result, nil
	}
	commandResult, err := w.sidecarRunResult(ctx, backend.host, sb, runtime, runID)
	if err != nil {
		return result, err
	}
	if runErr, ok := parseAgentRunErrorEnvelope(commandResult.Stdout); ok {
		result.Status = firstNonEmpty(result.Status, "failed")
		result.StopReason = firstNonEmpty(result.StopReason, "failed")
		result.ErrorMessage = firstNonEmpty(runErr.Message, result.ErrorMessage)
		return result, nil
	}
	if envelope, ok := parseAgentRunEnvelope(commandResult.Stdout); ok {
		result.OutputText = envelope.OutputText
	}
	return result, nil
}

func (w *AgentSidecarWorker) SessionRuntimeRunEvents(ctx context.Context, runtime ACPSessionRuntime, sessionID, runID string, afterSeq int64) ([]ACPSessionRuntimeRunEvent, error) {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return nil, fmt.Errorf("runtime identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return nil, err
	}
	sb := runtimeOuterSandbox(runtime)
	result, err := w.sidecarRunEvents(ctx, backend.host, sb, runtime, runID, afterSeq)
	if err != nil {
		return nil, err
	}
	parser := &sidecarStdoutParser{}
	sidecarEvents := append(parser.Feed(result.Stdout), parser.Finish()...)
	events := make([]ACPSessionRuntimeRunEvent, 0, len(sidecarEvents))
	var fallbackSeq int64
	for _, event := range sidecarEvents {
		seq := event.RunSeq
		if seq <= 0 {
			fallbackSeq++
			seq = afterSeq + fallbackSeq
		}
		workerEvent, _ := workerEventFromSidecarEvent(runID, seq, event)
		if workerEvent.Kind == "" {
			continue
		}
		events = append(events, ACPSessionRuntimeRunEvent{Seq: seq, Event: workerEvent})
	}
	return events, nil
}

func sidecarRunTerminal(status string) bool {
	switch status {
	case "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}
