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

	"github.com/QuantumNous/new-api/common"
)

const maxRuntimeTaskResponseBytes = 2 << 20

var ErrInvalidRuntimeTask = errors.New("平台返回的 Runtime Task 无效")

type TaskStatus string

const (
	TaskTodo       TaskStatus = "todo"
	TaskInProgress TaskStatus = "in_progress"
	TaskInReview   TaskStatus = "in_review"
	TaskDone       TaskStatus = "done"
	TaskClosed     TaskStatus = "closed"
)

type Task struct {
	ID                 string
	ServerID           string
	Number             int64
	Title              string
	Description        *string
	Status             TaskStatus
	OwnerMemberID      string
	AssignmentRevision int64
	CreatedByMemberID  string
	UpdatedByMemberID  string
	Revision           int64
}

func (c *Client) ListRuntimeTasks(
	ctx context.Context,
	token AccessToken,
) ([]Task, error) {
	request, err := c.runtimeTaskRequest(ctx, token, http.MethodGet, "/runtime/tasks", nil)
	if err != nil {
		return nil, err
	}
	response, err := c.doRuntimeTaskRequest(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeTaskResponseBytes)
	if err != nil {
		return nil, ErrInvalidRuntimeTask
	}
	var payload []runtimeTaskPayload
	if err := common.Unmarshal(data, &payload); err != nil || len(payload) > 10_000 {
		return nil, ErrInvalidRuntimeTask
	}
	values := make([]Task, 0, len(payload))
	for _, item := range payload {
		value, err := validateRuntimeTask(item)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (c *Client) GetRuntimeTask(
	ctx context.Context,
	token AccessToken,
	taskID string,
) (Task, error) {
	if !validUUIDv7(taskID) {
		return Task{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodGet,
		"/runtime/tasks/"+url.PathEscape(taskID), nil,
	)
	if err != nil {
		return Task{}, err
	}
	return c.doRuntimeTaskMutation(request, taskID)
}

func (c *Client) ClaimRuntimeTask(
	ctx context.Context,
	token AccessToken,
	taskID string,
	idempotencyKey string,
) (Task, error) {
	if !validUUIDv7(taskID) || strings.TrimSpace(idempotencyKey) == "" {
		return Task{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPost,
		"/runtime/tasks/"+url.PathEscape(taskID)+"/claim", nil,
	)
	if err != nil {
		return Task{}, err
	}
	request.Header.Set("Idempotency-Key", idempotencyKey)
	return c.doRuntimeTaskMutation(request, taskID)
}

func (c *Client) UpdateRuntimeTaskStatus(
	ctx context.Context,
	token AccessToken,
	taskID string,
	revision int64,
	status TaskStatus,
	idempotencyKey string,
) (Task, error) {
	if !validUUIDv7(taskID) || revision < 1 ||
		!runtimeWritableTaskStatus(status) || strings.TrimSpace(idempotencyKey) == "" {
		return Task{}, ErrInvalidConfig
	}
	body, err := common.Marshal(map[string]string{"status": string(status)})
	if err != nil {
		return Task{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPatch,
		"/runtime/tasks/"+url.PathEscape(taskID), bytes.NewReader(body),
	)
	if err != nil {
		return Task{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", strconv.FormatInt(revision, 10))
	request.Header.Set("Idempotency-Key", idempotencyKey)
	return c.doRuntimeTaskMutation(request, taskID)
}

func (c *Client) runtimeTaskRequest(
	ctx context.Context,
	token AccessToken,
	method string,
	path string,
	body *bytes.Reader,
) (*http.Request, error) {
	if c == nil || c.httpClient == nil || ctx == nil ||
		strings.TrimSpace(token.Reveal()) == "" {
		return nil, ErrInvalidConfig
	}
	var reader io.Reader = http.NoBody
	if body != nil {
		reader = body
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	return request, nil
}

func (c *Client) doRuntimeTaskRequest(request *http.Request) (*http.Response, error) {
	return c.doRuntimeRequest(request, http.StatusOK)
}

func (c *Client) doRuntimeRequest(
	request *http.Request,
	acceptedStatus ...int,
) (*http.Response, error) {
	response, err := c.httpClient.Do(request)
	if err != nil {
		if request.Context().Err() != nil {
			return nil, request.Context().Err()
		}
		return nil, newRequestError(true, 0)
	}
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		response.Body.Close()
		return nil, ErrCredentialRejected
	}
	accepted := false
	for _, status := range acceptedStatus {
		if response.StatusCode == status {
			accepted = true
			break
		}
	}
	if !accepted {
		err := requestErrorForResponse(response, c.now().UTC())
		response.Body.Close()
		return nil, err
	}
	return response, nil
}

func (c *Client) doRuntimeTaskMutation(
	request *http.Request,
	taskID string,
) (Task, error) {
	response, err := c.doRuntimeTaskRequest(request)
	if err != nil {
		return Task{}, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeTaskResponseBytes)
	if err != nil {
		return Task{}, ErrInvalidRuntimeTask
	}
	var payload runtimeTaskPayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return Task{}, ErrInvalidRuntimeTask
	}
	value, err := validateRuntimeTask(payload)
	if err != nil || value.ID != taskID {
		return Task{}, ErrInvalidRuntimeTask
	}
	return value, nil
}

type runtimeTaskPayload struct {
	ID                 string  `json:"id"`
	ServerID           string  `json:"serverId"`
	Number             int64   `json:"number"`
	Title              string  `json:"title"`
	Description        *string `json:"description"`
	Status             string  `json:"status"`
	OwnerMemberID      *string `json:"ownerMemberId"`
	AssignmentRevision int64   `json:"assignmentRevision"`
	CreatedByMemberID  string  `json:"createdByMemberId"`
	UpdatedByMemberID  string  `json:"updatedByMemberId"`
	Revision           int64   `json:"revision"`
}

func validateRuntimeTask(payload runtimeTaskPayload) (Task, error) {
	status := TaskStatus(payload.Status)
	if !validUUIDv7(payload.ID) || !validUUIDv7(payload.ServerID) ||
		payload.Number < 1 || strings.TrimSpace(payload.Title) == "" ||
		len(payload.Title) > 500 || !validTaskStatus(status) ||
		payload.OwnerMemberID == nil || !validUUIDv7(*payload.OwnerMemberID) ||
		payload.AssignmentRevision < 1 || payload.Revision < 1 ||
		!validUUIDv7(payload.CreatedByMemberID) ||
		!validUUIDv7(payload.UpdatedByMemberID) {
		return Task{}, ErrInvalidRuntimeTask
	}
	return Task{
		ID: payload.ID, ServerID: payload.ServerID, Number: payload.Number,
		Title: payload.Title, Description: payload.Description, Status: status,
		OwnerMemberID:      *payload.OwnerMemberID,
		AssignmentRevision: payload.AssignmentRevision,
		CreatedByMemberID:  payload.CreatedByMemberID,
		UpdatedByMemberID:  payload.UpdatedByMemberID,
		Revision:           payload.Revision,
	}, nil
}

func validTaskStatus(status TaskStatus) bool {
	switch status {
	case TaskTodo, TaskInProgress, TaskInReview, TaskDone, TaskClosed:
		return true
	default:
		return false
	}
}

func runtimeWritableTaskStatus(status TaskStatus) bool {
	return status == TaskInProgress || status == TaskInReview || status == TaskDone
}
