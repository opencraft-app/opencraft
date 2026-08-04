package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

var ErrInvalidComputerHeartbeat = errors.New("Computer heartbeat 无效")

type ComputerHeartbeatReconcile struct {
	State     string  `json:"state"`
	ErrorCode *string `json:"errorCode"`
}

type ComputerHeartbeatAgent struct {
	AgentID           string `json:"agentId"`
	AssignmentEpoch   string `json:"assignmentEpoch"`
	ConfigGeneration  int64  `json:"configGeneration"`
	CredentialVersion int64  `json:"credentialVersion"`
	Attempt           int64  `json:"attempt"`
	LaunchID          string `json:"launchId"`
}

type ComputerHeartbeat struct {
	HeartbeatID        string                     `json:"heartbeatId"`
	DaemonVersion      string                     `json:"daemonVersion"`
	DaemonBuildID      string                     `json:"daemonBuildId"`
	AssignmentEpoch    string                     `json:"assignmentEpoch"`
	AssignmentRevision int64                      `json:"assignmentRevision"`
	TATState           string                     `json:"tatState"`
	Reconcile          ComputerHeartbeatReconcile `json:"reconcile"`
	Agents             []ComputerHeartbeatAgent   `json:"agents"`
}

func (c *Client) SendComputerHeartbeat(
	ctx context.Context,
	token ComputerAccessToken,
	heartbeat ComputerHeartbeat,
) error {
	if c == nil ||
		ctx == nil ||
		token.Reveal() == "" ||
		!validComputerHeartbeat(heartbeat) {
		return ErrInvalidComputerHeartbeat
	}
	body, err := common.Marshal(heartbeat)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/computer/heartbeat",
		bytes.NewReader(body),
	)
	if err != nil {
		return ErrInvalidComputerHeartbeat
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ErrCredentialRejected
	}
	if response.StatusCode != http.StatusNoContent {
		return newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(
				response.Header.Get("Retry-After"),
				c.now().UTC(),
			),
		)
	}
	return nil
}

func validComputerHeartbeat(value ComputerHeartbeat) bool {
	if !validUUIDv7(value.HeartbeatID) ||
		strings.TrimSpace(value.DaemonVersion) == "" ||
		strings.TrimSpace(value.DaemonVersion) != value.DaemonVersion ||
		len(value.DaemonVersion) > 100 ||
		strings.TrimSpace(value.DaemonBuildID) == "" ||
		strings.TrimSpace(value.DaemonBuildID) != value.DaemonBuildID ||
		len(value.DaemonBuildID) > 200 ||
		!validUUIDv7(value.AssignmentEpoch) ||
		value.AssignmentRevision < 1 ||
		len(value.Agents) > 5 {
		return false
	}
	switch value.TATState {
	case "online", "offline", "error":
	default:
		return false
	}
	switch value.Reconcile.State {
	case "healthy":
		if value.Reconcile.ErrorCode != nil {
			return false
		}
	case "error":
		if value.Reconcile.ErrorCode == nil ||
			strings.TrimSpace(*value.Reconcile.ErrorCode) == "" ||
			len(*value.Reconcile.ErrorCode) > 100 {
			return false
		}
	default:
		return false
	}
	seen := make(map[string]struct{}, len(value.Agents))
	for _, agent := range value.Agents {
		if !validUUIDv7(agent.AgentID) ||
			!validUUIDv7(agent.AssignmentEpoch) ||
			!validUUIDv7(agent.LaunchID) ||
			agent.ConfigGeneration < 1 ||
			agent.CredentialVersion < 1 ||
			agent.Attempt < 1 {
			return false
		}
		if _, exists := seen[agent.AgentID]; exists {
			return false
		}
		seen[agent.AgentID] = struct{}{}
	}
	return true
}
