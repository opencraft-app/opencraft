package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/vela/daemon"
)

var ErrInvalidComputerAgentLaunch = errors.New("Computer Agent Launch 无效")

type ComputerAgentLaunchRequest struct {
	LaunchID            string  `json:"launchId"`
	PredecessorLaunchID *string `json:"predecessorLaunchId"`
	AssignmentEpoch     string  `json:"assignmentEpoch"`
	AssignmentRevision  int64   `json:"assignmentRevision"`
	ConfigGeneration    int64   `json:"configGeneration"`
	CredentialVersion   int64   `json:"credentialVersion"`
}

type ComputerAgentSessionRefreshRequest struct {
	AssignmentEpoch   string `json:"assignmentEpoch"`
	ConfigGeneration  int64  `json:"configGeneration"`
	CredentialVersion int64  `json:"credentialVersion"`
	Attempt           int64  `json:"attempt"`
}

type ComputerAgentLaunchFence struct {
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion int64
	Attempt           int64
	IssuedAt          time.Time
}

func (fence ComputerAgentLaunchFence) DaemonFence() daemon.Fence {
	return daemon.Fence{
		Epoch: fence.AssignmentEpoch, ConfigGeneration: fence.ConfigGeneration,
		Attempt: fence.Attempt, LaunchID: fence.LaunchID,
	}
}

type ComputerAgentLaunch struct {
	Fence   ComputerAgentLaunchFence
	Session RuntimeSession
}

type computerAgentLaunchPayload struct {
	Launch struct {
		LaunchID          string    `json:"launchId"`
		AssignmentEpoch   string    `json:"assignmentEpoch"`
		ConfigGeneration  int64     `json:"configGeneration"`
		CredentialVersion int64     `json:"credentialVersion"`
		Attempt           int64     `json:"attempt"`
		IssuedAt          time.Time `json:"issuedAt"`
	} `json:"launch"`
	Session runtimeSessionPayload `json:"session"`
}

func (c *Client) CreateComputerAgentLaunch(
	ctx context.Context,
	token ComputerAccessToken,
	requestBody ComputerAgentLaunchRequest,
	assignment daemon.AgentAssignment,
	assignmentVersions ...int,
) (ComputerAgentLaunch, error) {
	if c == nil || ctx == nil || token.Reveal() == "" ||
		!validLaunchRequest(requestBody, assignment) {
		return ComputerAgentLaunch{}, ErrInvalidComputerAgentLaunch
	}
	encoded, err := common.Marshal(requestBody)
	if err != nil {
		return ComputerAgentLaunch{}, err
	}
	assignmentVersion := daemon.AssignmentSchemaVersionV1
	if len(assignmentVersions) > 0 {
		assignmentVersion = assignmentVersions[0]
	}
	if assignmentVersion != daemon.AssignmentSchemaVersionV1 &&
		assignmentVersion != daemon.AssignmentSchemaVersionV3 {
		return ComputerAgentLaunch{}, ErrInvalidComputerAgentLaunch
	}
	launchPath := "/launches"
	if assignmentVersion == daemon.AssignmentSchemaVersionV3 {
		launchPath = "/launches-v2"
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/computer/agents/"+url.PathEscape(assignment.AgentID)+launchPath,
		bytes.NewReader(encoded),
	)
	if err != nil {
		return ComputerAgentLaunch{}, ErrInvalidComputerAgentLaunch
	}
	setComputerBearerHeaders(request, token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ComputerAgentLaunch{}, c.mapLaunchRequestError(ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ComputerAgentLaunch{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		return ComputerAgentLaunch{}, launchStatusError(c, response)
	}
	var payload computerAgentLaunchPayload
	if err := decodeLimited(response.Body, &payload); err != nil {
		return ComputerAgentLaunch{}, ErrInvalidComputerAgentLaunch
	}
	return c.validateComputerAgentLaunch(payload, requestBody, assignment)
}

func (c *Client) RefreshComputerAgentLaunchSession(
	ctx context.Context,
	token ComputerAccessToken,
	fence ComputerAgentLaunchFence,
	assignment daemon.AgentAssignment,
	assignmentVersions ...int,
) (RuntimeSession, error) {
	if c == nil || ctx == nil || token.Reveal() == "" ||
		!validLaunchFence(fence, assignment) {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	body := ComputerAgentSessionRefreshRequest{
		AssignmentEpoch: fence.AssignmentEpoch, ConfigGeneration: fence.ConfigGeneration,
		CredentialVersion: fence.CredentialVersion, Attempt: fence.Attempt,
	}
	encoded, err := common.Marshal(body)
	if err != nil {
		return RuntimeSession{}, err
	}
	assignmentVersion := daemon.AssignmentSchemaVersionV1
	if len(assignmentVersions) > 0 {
		assignmentVersion = assignmentVersions[0]
	}
	if assignmentVersion != daemon.AssignmentSchemaVersionV1 &&
		assignmentVersion != daemon.AssignmentSchemaVersionV3 {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	launchPath := "/launches/"
	if assignmentVersion == daemon.AssignmentSchemaVersionV3 {
		launchPath = "/launches-v2/"
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/computer/agents/"+url.PathEscape(assignment.AgentID)+
			launchPath+url.PathEscape(fence.LaunchID)+"/session",
		bytes.NewReader(encoded),
	)
	if err != nil {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	setComputerBearerHeaders(request, token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return RuntimeSession{}, c.mapLaunchRequestError(ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return RuntimeSession{}, ErrCredentialRejected
	}
	wantStatus := http.StatusOK
	if assignmentVersion == daemon.AssignmentSchemaVersionV3 {
		wantStatus = http.StatusCreated
	}
	if response.StatusCode != wantStatus {
		return RuntimeSession{}, launchStatusError(c, response)
	}
	var payload runtimeSessionPayload
	if err := decodeLimited(response.Body, &payload); err != nil {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	return c.validateLaunchSession(payload, assignment)
}

func (c *Client) validateComputerAgentLaunch(
	payload computerAgentLaunchPayload,
	request ComputerAgentLaunchRequest,
	assignment daemon.AgentAssignment,
) (ComputerAgentLaunch, error) {
	fence := ComputerAgentLaunchFence{
		LaunchID:          payload.Launch.LaunchID,
		AssignmentEpoch:   payload.Launch.AssignmentEpoch,
		ConfigGeneration:  payload.Launch.ConfigGeneration,
		CredentialVersion: payload.Launch.CredentialVersion,
		Attempt:           payload.Launch.Attempt,
		IssuedAt:          payload.Launch.IssuedAt.UTC(),
	}
	if fence.LaunchID != request.LaunchID ||
		fence.AssignmentEpoch != request.AssignmentEpoch ||
		fence.ConfigGeneration != request.ConfigGeneration ||
		fence.CredentialVersion != request.CredentialVersion ||
		!validLaunchFence(fence, assignment) {
		return ComputerAgentLaunch{}, ErrInvalidComputerAgentLaunch
	}
	session, err := c.validateLaunchSession(payload.Session, assignment)
	if err != nil {
		return ComputerAgentLaunch{}, err
	}
	return ComputerAgentLaunch{Fence: fence, Session: session}, nil
}

func (c *Client) validateLaunchSession(
	payload runtimeSessionPayload,
	assignment daemon.AgentAssignment,
) (RuntimeSession, error) {
	now := c.now().UTC()
	if payload.AccessToken == nil || payload.IM.UserSig == nil ||
		payload.Agent.ID != assignment.AgentID ||
		payload.Agent.ServerID != assignment.ServerID ||
		payload.Agent.ReplyPolicy != assignment.ReplyPolicy ||
		payload.Agent.Runtime.Kind != assignment.Runtime.Kind ||
		payload.Agent.UserID == "" || payload.Agent.UserID != payload.IM.UserID ||
		payload.IM.SDKAppID <= 0 ||
		!validExpiry(payload.ExpiresAt, now, c.maxSessionTTL) ||
		!validExpiry(payload.IM.ExpiresAt, now, c.maxSessionTTL) {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	accessToken, err := newAccessToken(*payload.AccessToken)
	if err != nil {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	userSig, err := newUserSig(*payload.IM.UserSig)
	if err != nil {
		return RuntimeSession{}, ErrInvalidComputerAgentLaunch
	}
	return RuntimeSession{
		AccessToken: accessToken,
		ExpiresAt:   payload.ExpiresAt.UTC(),
		Agent: AgentIdentity{
			ID:           payload.Agent.ID,
			ServerID:     payload.Agent.ServerID,
			UserID:       payload.Agent.UserID,
			ReplyPolicy:  payload.Agent.ReplyPolicy,
			RuntimeKind:  payload.Agent.Runtime.Kind,
			RuntimeModel: payload.Agent.Runtime.Model,
			Capabilities: append([]string(nil), payload.Agent.Capabilities...),
		},
		IM: IMSession{
			SDKAppID:  payload.IM.SDKAppID,
			UserID:    payload.IM.UserID,
			UserSig:   userSig,
			ExpiresAt: payload.IM.ExpiresAt.UTC(),
		},
	}, nil
}

func validLaunchRequest(
	request ComputerAgentLaunchRequest,
	assignment daemon.AgentAssignment,
) bool {
	return validUUIDv7(request.LaunchID) &&
		(request.PredecessorLaunchID == nil || validUUIDv7(*request.PredecessorLaunchID)) &&
		validUUIDv7(request.AssignmentEpoch) && request.AssignmentRevision >= 1 &&
		request.ConfigGeneration == assignment.ConfigGeneration &&
		request.CredentialVersion == assignment.CredentialVersion &&
		request.CredentialVersion >= 1 && validUUIDv7(assignment.AgentID) &&
		validUUIDv7(assignment.ServerID)
}

func validLaunchFence(
	fence ComputerAgentLaunchFence,
	assignment daemon.AgentAssignment,
) bool {
	return validUUIDv7(fence.LaunchID) && validUUIDv7(fence.AssignmentEpoch) &&
		fence.ConfigGeneration == assignment.ConfigGeneration &&
		fence.CredentialVersion == assignment.CredentialVersion &&
		fence.CredentialVersion >= 1 && fence.Attempt >= 1 && !fence.IssuedAt.IsZero()
}

func setComputerBearerHeaders(request *http.Request, token ComputerAccessToken) {
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
}

func (c *Client) mapLaunchRequestError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return newRequestError(true, 0)
}

func launchStatusError(c *Client, response *http.Response) error {
	return newRequestError(
		response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= http.StatusInternalServerError,
		parseRetryAfter(response.Header.Get("Retry-After"), c.now().UTC()),
	)
}
