package platform

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/vela/daemon"
)

var (
	ErrInvalidComputerCredential = errors.New(
		"Computer Runtime Credential 无效",
	)
	ErrInvalidComputerSession = errors.New("Computer Session 无效")
	ErrInvalidAssignmentQuery = errors.New("Assignment 查询无效")
)

type ComputerCredential struct {
	secret
	serverID   string
	computerID string
	version    int64
}

type ComputerAccessToken struct {
	secret
}

type ComputerIdentity struct {
	ID                 string
	ServerID           string
	CredentialVersion  int64
	AssignmentEpoch    string
	AssignmentRevision int64
}

type ComputerSession struct {
	AccessToken       ComputerAccessToken
	ExpiresAt         time.Time
	Computer          ComputerIdentity
	AssignmentVersion int
}

type ComputerAssignmentQuery struct {
	AssignmentVersion  int
	ExpectedComputerID string
	SinceEpoch         string
	SinceRevision      int64
	WaitSeconds        int
	ForceFull          bool
}

type ComputerAssignmentResult struct {
	Snapshot *daemon.Snapshot
	NoChange bool
	Revision int64
}

type ObservationCursor struct {
	AssignmentEpoch  string `json:"assignmentEpoch"`
	ConfigGeneration int64  `json:"configGeneration"`
	Attempt          int64  `json:"attempt"`
	Sequence         int64  `json:"sequence"`
}

func NewComputerCredential(value string) (ComputerCredential, error) {
	if value != strings.TrimSpace(value) ||
		strings.ContainsAny(value, " \t\r\n") {
		return ComputerCredential{}, ErrInvalidComputerCredential
	}
	parts := strings.Split(value, ".")
	if len(parts) != 4 ||
		!strings.HasPrefix(parts[0], "crc_") {
		return ComputerCredential{}, ErrInvalidComputerCredential
	}
	serverID := strings.TrimPrefix(parts[0], "crc_")
	version, err := strconv.ParseInt(parts[2], 10, 64)
	if !validUUIDv7(serverID) ||
		!validUUIDv7(parts[1]) ||
		err != nil ||
		version < 1 ||
		!validSecretPart(parts[3]) {
		return ComputerCredential{}, ErrInvalidComputerCredential
	}
	return ComputerCredential{
		secret:     secret{value: value},
		serverID:   serverID,
		computerID: parts[1],
		version:    version,
	}, nil
}

func (credential ComputerCredential) ServerID() string {
	return credential.serverID
}

func (credential ComputerCredential) ComputerID() string {
	return credential.computerID
}

func (credential ComputerCredential) Version() int64 {
	return credential.version
}

func (credential ComputerCredential) Reveal() string {
	return credential.value
}

func (ComputerCredential) String() string {
	return "[REDACTED]"
}

func (ComputerCredential) GoString() string {
	return "[REDACTED]"
}

func (ComputerCredential) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

func (token ComputerAccessToken) Reveal() string {
	return token.value
}

func (ComputerAccessToken) String() string {
	return "[REDACTED]"
}

func (ComputerAccessToken) GoString() string {
	return "[REDACTED]"
}

func (ComputerAccessToken) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

func newComputerAccessToken(value string) (ComputerAccessToken, error) {
	if strings.TrimSpace(value) == "" ||
		value != strings.TrimSpace(value) ||
		strings.ContainsAny(value, "\r\n") {
		return ComputerAccessToken{}, ErrInvalidComputerSession
	}
	return ComputerAccessToken{secret: secret{value: value}}, nil
}

func (c *Client) CreateComputerSession(
	ctx context.Context,
	credential ComputerCredential,
) (ComputerSession, error) {
	if c == nil || ctx == nil || credential.value == "" {
		return ComputerSession{}, ErrInvalidConfig
	}
	body, err := common.Marshal(map[string]any{
		"assignmentVersions": []int{daemon.AssignmentSchemaVersionV3},
	})
	if err != nil {
		return ComputerSession{}, ErrInvalidConfig
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/computer/session-v2",
		bytes.NewReader(body),
	)
	if err != nil {
		return ComputerSession{}, ErrInvalidConfig
	}
	request.Header.Set(
		"Authorization",
		"ComputerCredential "+credential.Reveal(),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ComputerSession{}, ctx.Err()
		}
		return ComputerSession{}, newRequestError(true, 0)
	}
	if response.StatusCode == http.StatusNotFound {
		response.Body.Close()
		return c.createLegacyComputerSession(ctx, credential)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ComputerSession{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusCreated {
		return ComputerSession{}, newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(
				response.Header.Get("Retry-After"),
				c.now().UTC(),
			),
		)
	}
	var payload computerSessionPayload
	if err := decodeLimited(response.Body, &payload); err != nil {
		return ComputerSession{}, ErrInvalidComputerSession
	}
	return c.validateComputerSession(payload, credential)
}

func (c *Client) createLegacyComputerSession(
	ctx context.Context,
	credential ComputerCredential,
) (ComputerSession, error) {
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.baseURL+"/computer/session", nil,
	)
	if err != nil {
		return ComputerSession{}, ErrInvalidConfig
	}
	request.Header.Set("Authorization", "ComputerCredential "+credential.Reveal())
	request.Header.Set("X-Vela-Assignment-Version", "1")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ComputerSession{}, ctx.Err()
		}
		return ComputerSession{}, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ComputerSession{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusCreated {
		return ComputerSession{}, newRequestError(
			response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
			parseRetryAfter(response.Header.Get("Retry-After"), c.now().UTC()),
		)
	}
	var payload computerSessionPayload
	if err := decodeLimited(response.Body, &payload); err != nil {
		return ComputerSession{}, ErrInvalidComputerSession
	}
	return c.validateComputerSession(payload, credential)
}

type computerSessionPayload struct {
	AccessToken string    `json:"accessToken"`
	ExpiresAt   time.Time `json:"expiresAt"`
	Computer    struct {
		ID                 string `json:"id"`
		ServerID           string `json:"serverId"`
		CredentialVersion  int64  `json:"credentialVersion"`
		AssignmentEpoch    string `json:"assignmentEpoch"`
		AssignmentRevision int64  `json:"assignmentRevision"`
	} `json:"computer"`
	AssignmentVersions []int `json:"assignmentVersions"`
	AssignmentVersion  int   `json:"assignmentVersion"`
}

func (c *Client) validateComputerSession(
	payload computerSessionPayload,
	credential ComputerCredential,
) (ComputerSession, error) {
	now := c.now().UTC()
	if payload.Computer.ID != credential.ComputerID() ||
		payload.Computer.ServerID != credential.ServerID() ||
		payload.Computer.CredentialVersion != credential.Version() ||
		!validUUIDv7(payload.Computer.AssignmentEpoch) ||
		payload.Computer.AssignmentRevision < 1 ||
		!validNegotiatedAssignmentVersion(payload) ||
		!validExpiry(payload.ExpiresAt, now, c.maxSessionTTL) {
		return ComputerSession{}, ErrInvalidComputerSession
	}
	token, err := newComputerAccessToken(payload.AccessToken)
	if err != nil {
		return ComputerSession{}, ErrInvalidComputerSession
	}
	return ComputerSession{
		AccessToken: token,
		ExpiresAt:   payload.ExpiresAt.UTC(),
		Computer: ComputerIdentity{
			ID:                 payload.Computer.ID,
			ServerID:           payload.Computer.ServerID,
			CredentialVersion:  payload.Computer.CredentialVersion,
			AssignmentEpoch:    payload.Computer.AssignmentEpoch,
			AssignmentRevision: payload.Computer.AssignmentRevision,
		},
		AssignmentVersion: negotiatedAssignmentVersion(payload),
	}, nil
}

func validNegotiatedAssignmentVersion(payload computerSessionPayload) bool {
	return payload.AssignmentVersion == daemon.AssignmentSchemaVersionV3 ||
		(payload.AssignmentVersion == 0 && len(payload.AssignmentVersions) == 1 &&
			payload.AssignmentVersions[0] == daemon.AssignmentSchemaVersionV1)
}

func negotiatedAssignmentVersion(payload computerSessionPayload) int {
	if payload.AssignmentVersion != 0 {
		return payload.AssignmentVersion
	}
	return daemon.AssignmentSchemaVersionV1
}

func (c *Client) GetComputerAssignments(
	ctx context.Context,
	token ComputerAccessToken,
	query ComputerAssignmentQuery,
) (ComputerAssignmentResult, error) {
	if c == nil ||
		ctx == nil ||
		token.value == "" ||
		query.SinceRevision < 0 ||
		query.WaitSeconds < 0 ||
		query.WaitSeconds > 25 ||
		query.ExpectedComputerID != "" &&
			!validUUIDv7(query.ExpectedComputerID) ||
		query.SinceEpoch != "" && !validUUIDv7(query.SinceEpoch) ||
		(query.AssignmentVersion != 0 &&
			query.AssignmentVersion != daemon.AssignmentSchemaVersionV1 &&
			query.AssignmentVersion != daemon.AssignmentSchemaVersionV3) ||
		query.SinceEpoch == "" &&
			(query.SinceRevision != 0 || !query.ForceFull) {
		return ComputerAssignmentResult{}, ErrInvalidAssignmentQuery
	}
	parameters := url.Values{}
	if query.SinceEpoch != "" {
		parameters.Set("sinceEpoch", query.SinceEpoch)
	}
	parameters.Set(
		"sinceRevision",
		strconv.FormatInt(query.SinceRevision, 10),
	)
	parameters.Set("waitSeconds", strconv.Itoa(query.WaitSeconds))
	parameters.Set("forceFull", strconv.FormatBool(query.ForceFull))
	assignmentVersion := query.AssignmentVersion
	if assignmentVersion == 0 {
		assignmentVersion = daemon.AssignmentSchemaVersionV1
	}
	path := "/computer/assignments"
	if assignmentVersion == daemon.AssignmentSchemaVersionV3 {
		path = "/computer/assignments-v3"
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		c.baseURL+path+"?"+parameters.Encode(),
		nil,
	)
	if err != nil {
		return ComputerAssignmentResult{}, ErrInvalidAssignmentQuery
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	if assignmentVersion == daemon.AssignmentSchemaVersionV1 {
		request.Header.Set("X-Vela-Assignment-Version", strconv.Itoa(assignmentVersion))
	}
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ComputerAssignmentResult{}, ctx.Err()
		}
		return ComputerAssignmentResult{}, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		revision, err := strconv.ParseInt(
			response.Header.Get("X-Assignment-Revision"),
			10,
			64,
		)
		if err != nil || revision < 1 {
			return ComputerAssignmentResult{}, daemon.ErrInvalidSnapshot
		}
		return ComputerAssignmentResult{
			NoChange: true,
			Revision: revision,
		}, nil
	}
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ComputerAssignmentResult{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusOK {
		return ComputerAssignmentResult{}, newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(
				response.Header.Get("Retry-After"),
				c.now().UTC(),
			),
		)
	}
	var snapshot daemon.Snapshot
	if err := decodeLimited(response.Body, &snapshot); err != nil {
		return ComputerAssignmentResult{}, daemon.ErrInvalidSnapshot
	}
	expectedComputerID := query.ExpectedComputerID
	if expectedComputerID == "" {
		expectedComputerID = snapshot.ComputerID
	}
	if err := daemon.ValidateSnapshot(
		snapshot,
		expectedComputerID,
	); err != nil {
		return ComputerAssignmentResult{}, err
	}
	return ComputerAssignmentResult{
		Snapshot: &snapshot,
		Revision: snapshot.Revision,
	}, nil
}

func decodeLimited(reader io.Reader, destination any) error {
	data, err := io.ReadAll(io.LimitReader(
		reader,
		maxSessionResponseBytes+1,
	))
	if err != nil ||
		len(data) == 0 ||
		len(data) > maxSessionResponseBytes {
		return ErrInvalidSession
	}
	return common.Unmarshal(data, destination)
}

func validSecretPart(value string) bool {
	if len(value) != 43 {
		return false
	}
	for _, character := range value {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '_', character == '-':
		default:
			return false
		}
	}
	return true
}
