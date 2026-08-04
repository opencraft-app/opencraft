package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var ErrInvalidComputerAgentObservation = errors.New(
	"Computer Agent observation 无效",
)

type ComputerAgentObservation struct {
	AssignmentEpoch    string    `json:"assignmentEpoch"`
	AssignmentRevision int64     `json:"assignmentRevision"`
	ConfigGeneration   int64     `json:"configGeneration"`
	CredentialVersion  int64     `json:"credentialVersion"`
	Attempt            int64     `json:"attempt"`
	Sequence           int64     `json:"sequence"`
	LaunchID           string    `json:"launchId"`
	State              string    `json:"state"`
	IMTransportState   string    `json:"imTransportState"`
	ErrorCode          *string   `json:"errorCode,omitempty"`
	ObservedAt         time.Time `json:"observedAt"`
}

type ComputerObservationCurrent struct {
	LaunchID *string `json:"launchId"`
	Attempt  int64   `json:"attempt"`
	Sequence int64   `json:"sequence"`
}

type ComputerAgentObservationResult struct {
	Accepted bool
	Reason   string
	Current  ComputerObservationCurrent
	Stale    bool
}

func (c *Client) PutComputerAgentObservation(
	ctx context.Context,
	token ComputerAccessToken,
	agentID string,
	observationID string,
	observation ComputerAgentObservation,
) (ComputerAgentObservationResult, error) {
	if c == nil || ctx == nil || token.Reveal() == "" ||
		!validUUIDv7(agentID) || !validUUIDv7(observationID) ||
		!validComputerAgentObservation(observation) {
		return ComputerAgentObservationResult{},
			ErrInvalidComputerAgentObservation
	}
	body, err := common.Marshal(observation)
	if err != nil {
		return ComputerAgentObservationResult{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		c.baseURL+"/computer/agents/"+url.PathEscape(agentID)+
			"/observations/"+url.PathEscape(observationID),
		bytes.NewReader(body),
	)
	if err != nil {
		return ComputerAgentObservationResult{},
			ErrInvalidComputerAgentObservation
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ComputerAgentObservationResult{}, ctx.Err()
		}
		return ComputerAgentObservationResult{}, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ComputerAgentObservationResult{}, ErrCredentialRejected
	}
	switch response.StatusCode {
	case http.StatusOK:
		var payload struct {
			Accepted bool                       `json:"accepted"`
			Reason   string                     `json:"reason"`
			Current  ComputerObservationCurrent `json:"current"`
		}
		if err := decodeLimited(response.Body, &payload); err != nil ||
			!validObservationResult(payload.Accepted, payload.Reason, payload.Current) {
			return ComputerAgentObservationResult{},
				ErrInvalidComputerAgentObservation
		}
		return ComputerAgentObservationResult{
			Accepted: payload.Accepted,
			Reason:   payload.Reason,
			Current:  payload.Current,
			Stale:    payload.Reason == "stale_launch",
		}, nil
	case http.StatusNoContent:
		return ComputerAgentObservationResult{
			Accepted: true,
			Reason:   "accepted",
		}, nil
	case http.StatusAccepted:
		var payload struct {
			Accepted bool   `json:"accepted"`
			Reason   string `json:"reason"`
		}
		if err := decodeLimited(response.Body, &payload); err != nil ||
			payload.Accepted || payload.Reason != "ignored_stale_observation" {
			return ComputerAgentObservationResult{},
				ErrInvalidComputerAgentObservation
		}
		return ComputerAgentObservationResult{
			Accepted: false,
			Reason:   "stale_launch",
			Stale:    true,
		}, nil
	default:
		return ComputerAgentObservationResult{}, newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(
				response.Header.Get("Retry-After"),
				c.now().UTC(),
			),
		)
	}
}

func validComputerAgentObservation(value ComputerAgentObservation) bool {
	if !validUUIDv7(value.AssignmentEpoch) ||
		!validUUIDv7(value.LaunchID) ||
		value.AssignmentRevision < 1 || value.ConfigGeneration < 1 ||
		value.CredentialVersion < 1 ||
		value.Attempt < 1 || value.Sequence < 1 || value.ObservedAt.IsZero() {
		return false
	}
	switch value.IMTransportState {
	case "unknown", "connecting", "connected", "disconnected", "error":
	default:
		return false
	}
	switch value.State {
	case "starting", "running", "stopping", "stopped":
		return value.ErrorCode == nil
	case "error":
		return value.ErrorCode != nil &&
			strings.TrimSpace(*value.ErrorCode) == *value.ErrorCode &&
			*value.ErrorCode != "" && len(*value.ErrorCode) <= 100
	default:
		return false
	}
}

func validObservationResult(
	accepted bool,
	reason string,
	current ComputerObservationCurrent,
) bool {
	if current.Attempt < 0 || current.Sequence < 0 ||
		(current.LaunchID != nil && !validUUIDv7(*current.LaunchID)) {
		return false
	}
	if accepted {
		return reason == "accepted" && current.LaunchID != nil &&
			current.Attempt >= 1 && current.Sequence >= 1
	}
	return reason == "stale_launch" || reason == "older_sequence"
}
