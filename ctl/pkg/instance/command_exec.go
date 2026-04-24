package instance

import (
	stdctx "context"
	"errors"
	"fmt"
	"strings"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/metric"
)

func (l *logic) execSandboxCommand(ctx pctx.Context, sandboxID, commandKind, bash string, timeoutSec int) (result *psandbox.ExecCommandResult, err error) {
	commandKind = strings.TrimSpace(commandKind)
	if commandKind == "" {
		commandKind = "unknown"
	}

	start := time.Now()
	gauge := metric.RemoteCommandInflightGaugeVec.WithLabelValues(commandKind)
	gauge.Inc()
	defer func() {
		gauge.Dec()
		metric.RecordRemoteCommand(commandKind, classifySandboxCommandResult(result, err), time.Since(start).Seconds())
	}()

	return l.sandboxAdapter.ExecCommand(ctx, sandboxID, bash, timeoutSec)
}

const debugProcessOutputMaxBytes = 128 * 1024
const debugProcessExecMaxTimeoutSec = 300

func (l *logic) execSandboxProcessCommand(ctx pctx.Context, sandboxID, commandKind string, req *psandbox.ProcessStartRequest, timeoutSec int) (result *psandbox.ExecCommandResult, err error) {
	return l.execSandboxProcessCommandWithOutputLimit(ctx, sandboxID, commandKind, req, timeoutSec, debugProcessOutputMaxBytes)
}

func (l *logic) execSandboxProcessCommandWithOutputLimit(ctx pctx.Context, sandboxID, commandKind string, req *psandbox.ProcessStartRequest, timeoutSec int, maxOutputBytes int) (result *psandbox.ExecCommandResult, err error) {
	commandKind = strings.TrimSpace(commandKind)
	if commandKind == "" {
		commandKind = "unknown"
	}
	if timeoutSec <= 0 {
		timeoutSec = debugExecTimeoutSec
	}
	if timeoutSec > debugProcessExecMaxTimeoutSec {
		timeoutSec = debugProcessExecMaxTimeoutSec
	}

	startedAt := time.Now()
	gauge := metric.RemoteCommandInflightGaugeVec.WithLabelValues(commandKind)
	gauge.Inc()
	defer func() {
		gauge.Dec()
		metric.RecordRemoteCommand(commandKind, classifySandboxCommandResult(result, err), time.Since(startedAt).Seconds())
	}()

	runCtx, cancel := stdctx.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	result = &psandbox.ExecCommandResult{
		Status:    "RUNNING",
		StartTime: startedAt.Format(time.RFC3339),
	}
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	ended := false

	err = l.sandboxAdapter.StartProcessStream(runCtx, sandboxID, req, func(ev psandbox.ProcessStreamEvent) error {
		if ev.PID != 0 && result.InvocationID == "" {
			pidRef := fmt.Sprintf("pid:%d", ev.PID)
			result.InvocationID = pidRef
			result.CommandID = pidRef
		}
		if ev.Stdout != "" {
			appendBounded(&stdoutBuf, ev.Stdout, maxOutputBytes)
		}
		if ev.Stderr != "" {
			appendBounded(&stderrBuf, ev.Stderr, maxOutputBytes)
		}
		if !ev.Ended {
			return nil
		}

		ended = true
		result.ExitCode = int64(ev.ExitCode)
		result.EndTime = time.Now().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		result.ErrorInfo = strings.TrimSpace(ev.Error)
		result.Status = normalizeProcessExitStatus(ev.Status, ev.ExitCode)
		return nil
	})
	if err != nil {
		if errors.Is(err, stdctx.DeadlineExceeded) || errors.Is(runCtx.Err(), stdctx.DeadlineExceeded) {
			result.Status = "TIMEOUT"
			result.EndTime = time.Now().Format(time.RFC3339)
			result.Stdout = stdoutBuf.String()
			result.Stderr = stderrBuf.String()
			result.Output = result.Stdout + result.Stderr
			return result, errcode.ErrSandboxTimeout
		}
		result.Status = "FAILED"
		result.EndTime = time.Now().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		result.ErrorInfo = err.Error()
		return result, err
	}
	if !ended {
		result.Status = "FAILED"
		result.EndTime = time.Now().Format(time.RFC3339)
		result.Stdout = stdoutBuf.String()
		result.Stderr = stderrBuf.String()
		result.Output = result.Stdout + result.Stderr
		result.ErrorInfo = "process stream ended without exit event"
	}
	return result, nil
}

func (l *logic) execSandboxProcessCommandWithStdin(ctx pctx.Context, sandboxID, commandKind string, req *psandbox.ProcessStartRequest, stdin []byte, timeoutSec int) (result *psandbox.ExecCommandResult, err error) {
	commandKind = strings.TrimSpace(commandKind)
	if commandKind == "" {
		commandKind = "unknown"
	}
	if timeoutSec <= 0 {
		timeoutSec = debugExecTimeoutSec
	}
	if timeoutSec > debugProcessExecMaxTimeoutSec {
		timeoutSec = debugProcessExecMaxTimeoutSec
	}

	startedAt := time.Now()
	gauge := metric.RemoteCommandInflightGaugeVec.WithLabelValues(commandKind)
	gauge.Inc()
	defer func() {
		gauge.Dec()
		metric.RecordRemoteCommand(commandKind, classifySandboxCommandResult(result, err), time.Since(startedAt).Seconds())
	}()

	runCtx, cancel := stdctx.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	result, err = l.sandboxAdapter.RunProcessWithStdin(runCtx, sandboxID, req, stdin)
	if err != nil {
		if errors.Is(err, stdctx.DeadlineExceeded) || errors.Is(runCtx.Err(), stdctx.DeadlineExceeded) {
			if result == nil {
				result = &psandbox.ExecCommandResult{}
			}
			result.Status = "TIMEOUT"
			return result, errcode.ErrSandboxTimeout
		}
		return result, err
	}
	return result, nil
}

func classifySandboxCommandResult(result *psandbox.ExecCommandResult, err error) string {
	if err != nil {
		if errors.Is(err, errcode.ErrSandboxTimeout) {
			return "timeout"
		}
		return "transport_error"
	}
	if result == nil {
		return "empty_result"
	}

	status := strings.ToUpper(strings.TrimSpace(result.Status))
	switch {
	case result.ExitCode == 0 && (status == "" || status == "SUCCESS" || strings.HasPrefix(status, "EXIT STATUS 0")):
		return "success"
	case status == "TIMEOUT":
		return "timeout"
	case status != "" && status != "SUCCESS":
		return "failed_status"
	case result.ExitCode != 0:
		return "nonzero_exit"
	default:
		return "unknown"
	}
}

func sandboxCommandSucceeded(result *psandbox.ExecCommandResult) bool {
	if result == nil {
		return false
	}
	status := strings.ToUpper(strings.TrimSpace(result.Status))
	return result.ExitCode == 0 && (status == "" || status == "SUCCESS" || strings.HasPrefix(status, "EXIT STATUS 0"))
}

func sandboxCommandFailureDetail(result *psandbox.ExecCommandResult) string {
	if result == nil {
		return "empty command result"
	}

	status := strings.TrimSpace(result.Status)
	switch {
	case status != "" && !strings.EqualFold(status, "SUCCESS"):
		parts := []string{fmt.Sprintf("status=%s", status)}
		if result.ExitCode != 0 {
			parts = append(parts, fmt.Sprintf("exit_code=%d", result.ExitCode))
		}
		if msg := strings.TrimSpace(result.ErrorInfo); msg != "" {
			parts = append(parts, fmt.Sprintf("error=%s", msg))
		} else if stderr := strings.TrimSpace(result.Stderr); stderr != "" {
			parts = append(parts, fmt.Sprintf("stderr=%s", stderr))
		} else if stdout := strings.TrimSpace(result.Stdout); stdout != "" {
			parts = append(parts, fmt.Sprintf("stdout=%s", stdout))
		}
		return strings.Join(parts, " ")
	case result.ExitCode != 0:
		output := strings.TrimSpace(result.Stderr)
		if output == "" {
			output = strings.TrimSpace(result.Stdout)
		}
		if output == "" {
			output = strings.TrimSpace(result.Output)
		}
		if output == "" {
			output = strings.TrimSpace(result.ErrorInfo)
		}
		if output != "" {
			return fmt.Sprintf("exit code %d: %s", result.ExitCode, output)
		}
		return fmt.Sprintf("exit code %d", result.ExitCode)
	default:
		return "command did not complete successfully"
	}
}

func normalizeProcessExitStatus(raw string, exitCode int32) string {
	status := strings.TrimSpace(raw)
	upper := strings.ToUpper(status)

	switch {
	case exitCode == 0:
		// envd process currently reports successful completions as "exit status 0".
		// Normalize that to SUCCESS so upper layers don't misclassify a healthy command.
		return "SUCCESS"
	case upper != "":
		return upper
	default:
		return "FAILED"
	}
}
