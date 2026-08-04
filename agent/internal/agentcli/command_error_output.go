package agentcli

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
)

func (a *App) writeAgentAPICommandError(
	err error,
	fallbackCode string,
	useServerCode bool,
) int {
	code := fallbackCode
	message := err.Error()
	var httpError *agentapi.HTTPError
	if errors.As(err, &httpError) {
		if httpError.Message != "" {
			message = httpError.Message
		}
		switch {
		case httpError.StatusCode >= 500:
			code = "SERVER_5XX"
		case useServerCode && httpError.Code != "":
			code = httpError.Code
		}
	}
	return a.writeCommandError(message, code, "")
}

func (a *App) writeCommandError(message, code, nextAction string) int {
	_, _ = fmt.Fprintln(a.stderr, "Error: "+message)
	_, _ = fmt.Fprintln(a.stderr, "Code: "+code)
	if nextAction != "" {
		_, _ = fmt.Fprintln(a.stderr, "Next action: "+nextAction)
	}
	return 1
}
