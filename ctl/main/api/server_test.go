package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	logfields "ctl/pkg/log"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type stubLogic struct {
	createResp                             *transport.InstanceResponse
	createErr                              error
	createReq                              *transport.CreateInstanceRequest
	updateResp                             *transport.InstanceResponse
	updateErr                              error
	updateReq                              *transport.UpdateInstanceRequest
	listSoulResp                           *transport.ListSoulTemplatesResponse
	listSoulErr                            error
	usageResp                              *transport.UserUsageResponse
	usageErr                               error
	listOperationsResp                     *transport.ListOperationsResponse
	listOperationsErr                      error
	getLogsResp                            *psandbox.SandboxLogs
	getLogsErr                             error
	workspaceResp                          *transport.WorkspaceFilesResponse
	workspaceErr                           error
	workspaceFile                          string
	updateWorkspaceReq                     *transport.UpdateWorkspaceFileRequest
	updateWorkspaceResp                    *transport.WorkspaceFileResponse
	updateWorkspaceErr                     error
	uploadWorkspaceReq                     *transport.UploadWorkspaceAttachmentRequest
	uploadWorkspaceResp                    *transport.WorkspaceUploadResponse
	uploadWorkspaceErr                     error
	listWorkspaceUploadsReq                *transport.ListWorkspaceUploadsRequest
	listWorkspaceUploadsResp               *transport.WorkspaceUploadsResponse
	listWorkspaceUploadsErr                error
	getWorkspaceUploadID                   string
	getWorkspaceUploadResp                 *transport.WorkspaceUploadResponse
	getWorkspaceUploadErr                  error
	getWorkspaceUploadContentID            string
	getWorkspaceUploadContentResp          *transport.WorkspaceUploadResponse
	getWorkspaceUploadContent              []byte
	getWorkspaceUploadContentErr           error
	automationSchedulesResp                *transport.AutomationSchedulesResponse
	automationSchedulesErr                 error
	automationScheduleResp                 *transport.AutomationSchedule
	automationScheduleErr                  error
	automationCreateReq                    *transport.CreateAutomationScheduleRequest
	automationUpdateReq                    *transport.UpdateAutomationScheduleRequest
	automationRunResp                      *transport.AutomationRunResponse
	automationRunErr                       error
	automationOffset                       int64
	automationLimit                        int64
	automationScheduleID                   string
	automationDeleteID                     string
	chatClawStateResp                      *transport.ChatClawStateResponse
	chatClawStateErr                       error
	chatClawRuntimeBootstrapResp           *transport.ChatClawRuntimeBootstrapResponse
	chatClawRuntimeBootstrapErr            error
	chatClawRuntimeBootstrapConversationID string
	createAgentReq                         *transport.CreateChatClawAgentRequest
	createAgentResp                        *transport.ChatClawAgentResponse
	createAgentErr                         error
	updateAgentReq                         *transport.UpdateChatClawAgentRequest
	updateAgentResp                        *transport.ChatClawAgentResponse
	updateAgentErr                         error
	deleteAgentID                          string
	deleteAgentErr                         error
	configureResp                          *transport.ConfigureChannelResponse
	configureErr                           error
	configureReq                           *transport.ConfigureChannelRequest
	configureInstance                      string
	debugInstanceID                        string
	debugCommand                           string
	debugRunAsUser                         string
	debugResp                              *transport.ExecDebugCommandResponse
	debugErr                               error
	debugStreamEvents                      []transport.ExecDebugCommandStreamEvent
	debugStreamErr                         error
}

type stubRetryAfterError struct {
	seconds int
}

func (e *stubRetryAfterError) Error() string {
	return errcode.ErrInstanceChurnLimited.Message
}

func (e *stubRetryAfterError) Unwrap() error {
	return errcode.ErrInstanceChurnLimited
}

func (e *stubRetryAfterError) RetryAfterSeconds() int {
	return e.seconds
}

func (s *stubLogic) CreateInstance(ctx pctx.Context, req *transport.CreateInstanceRequest) (*transport.InstanceResponse, error) {
	if req != nil {
		cloned := *req
		s.createReq = &cloned
	}
	return s.createResp, s.createErr
}

func (s *stubLogic) UpdateInstance(ctx pctx.Context, instanceID string, req *transport.UpdateInstanceRequest) (*transport.InstanceResponse, error) {
	if req != nil {
		cloned := *req
		s.updateReq = &cloned
	}
	if s.updateResp != nil || s.updateErr != nil {
		return s.updateResp, s.updateErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ListSoulTemplates(ctx pctx.Context) (*transport.ListSoulTemplatesResponse, error) {
	if s.listSoulResp != nil || s.listSoulErr != nil {
		return s.listSoulResp, s.listSoulErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetUserUsage(ctx pctx.Context) (*transport.UserUsageResponse, error) {
	if s.usageResp != nil || s.usageErr != nil {
		return s.usageResp, s.usageErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ListInstances(ctx pctx.Context, page, pageSize int) (*transport.ListInstancesResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) DestroyInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) PauseInstance(ctx pctx.Context, instanceID string) (*transport.InstanceResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ResumeInstance(ctx pctx.Context, instanceID string, req *transport.ResumeInstanceRequest) (*transport.InstanceResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) SetInstanceTimeout(ctx pctx.Context, instanceID string, req *transport.SetTimeoutRequest) (*transport.InstanceResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ListOperations(ctx pctx.Context, instanceID string, page, pageSize int) (*transport.ListOperationsResponse, error) {
	if s.listOperationsResp != nil || s.listOperationsErr != nil {
		return s.listOperationsResp, s.listOperationsErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetInstanceLogs(ctx pctx.Context, instanceID string, start *int64, limit *int32) (*psandbox.SandboxLogs, error) {
	if s.getLogsResp != nil || s.getLogsErr != nil {
		return s.getLogsResp, s.getLogsErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ExecDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string) (*transport.ExecDebugCommandResponse, error) {
	if s.debugResp != nil || s.debugErr != nil {
		s.debugInstanceID = instanceID
		s.debugCommand = commandType
		s.debugRunAsUser = runAsUser
		return s.debugResp, s.debugErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) StreamDebugCommand(ctx pctx.Context, instanceID string, commandType string, runAsUser string, onEvent func(transport.ExecDebugCommandStreamEvent) error) error {
	if len(s.debugStreamEvents) > 0 || s.debugStreamErr != nil {
		s.debugInstanceID = instanceID
		s.debugCommand = commandType
		s.debugRunAsUser = runAsUser
		for _, event := range s.debugStreamEvents {
			if err := onEvent(event); err != nil {
				return err
			}
		}
		return s.debugStreamErr
	}
	return errors.New("unexpected call")
}

func (s *stubLogic) GetWorkspaceFiles(ctx pctx.Context, instanceID string, fileName string) (*transport.WorkspaceFilesResponse, error) {
	if s.workspaceResp != nil || s.workspaceErr != nil {
		s.workspaceFile = fileName
		return s.workspaceResp, s.workspaceErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UpdateWorkspaceFile(ctx pctx.Context, instanceID string, req *transport.UpdateWorkspaceFileRequest) (*transport.WorkspaceFileResponse, error) {
	if s.updateWorkspaceResp != nil || s.updateWorkspaceErr != nil {
		if req != nil {
			cloned := *req
			s.updateWorkspaceReq = &cloned
		}
		return s.updateWorkspaceResp, s.updateWorkspaceErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UploadWorkspaceAttachment(ctx pctx.Context, instanceID string, req *transport.UploadWorkspaceAttachmentRequest) (*transport.WorkspaceUploadResponse, error) {
	if s.uploadWorkspaceResp != nil || s.uploadWorkspaceErr != nil {
		if req != nil {
			cloned := *req
			cloned.Content = append([]byte(nil), req.Content...)
			s.uploadWorkspaceReq = &cloned
		}
		return s.uploadWorkspaceResp, s.uploadWorkspaceErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) ListWorkspaceUploads(ctx pctx.Context, instanceID string, req *transport.ListWorkspaceUploadsRequest) (*transport.WorkspaceUploadsResponse, error) {
	if s.listWorkspaceUploadsResp != nil || s.listWorkspaceUploadsErr != nil {
		if req != nil {
			cloned := *req
			s.listWorkspaceUploadsReq = &cloned
		}
		return s.listWorkspaceUploadsResp, s.listWorkspaceUploadsErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetWorkspaceUpload(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, error) {
	if s.getWorkspaceUploadResp != nil || s.getWorkspaceUploadErr != nil {
		s.getWorkspaceUploadID = uploadID
		return s.getWorkspaceUploadResp, s.getWorkspaceUploadErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetWorkspaceUploadContent(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, []byte, error) {
	if s.getWorkspaceUploadContentResp != nil || s.getWorkspaceUploadContentErr != nil || len(s.getWorkspaceUploadContent) > 0 {
		s.getWorkspaceUploadContentID = uploadID
		return s.getWorkspaceUploadContentResp, s.getWorkspaceUploadContent, s.getWorkspaceUploadContentErr
	}
	return nil, nil, errors.New("unexpected call")
}

func (s *stubLogic) ListAutomationSchedules(ctx pctx.Context, instanceID string, offset, limit int64) (*transport.AutomationSchedulesResponse, error) {
	if s.automationSchedulesResp != nil || s.automationSchedulesErr != nil {
		s.automationOffset = offset
		s.automationLimit = limit
		return s.automationSchedulesResp, s.automationSchedulesErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationSchedule, error) {
	if s.automationScheduleResp != nil || s.automationScheduleErr != nil {
		s.automationScheduleID = scheduleID
		return s.automationScheduleResp, s.automationScheduleErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) CreateAutomationSchedule(ctx pctx.Context, instanceID string, req *transport.CreateAutomationScheduleRequest) (*transport.AutomationSchedule, error) {
	if s.automationScheduleResp != nil || s.automationScheduleErr != nil {
		if req != nil {
			cloned := *req
			s.automationCreateReq = &cloned
		}
		return s.automationScheduleResp, s.automationScheduleErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UpdateAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string, req *transport.UpdateAutomationScheduleRequest) (*transport.AutomationSchedule, error) {
	if s.automationScheduleResp != nil || s.automationScheduleErr != nil {
		s.automationScheduleID = scheduleID
		if req != nil {
			cloned := *req
			s.automationUpdateReq = &cloned
		}
		return s.automationScheduleResp, s.automationScheduleErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) DeleteAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) error {
	s.automationDeleteID = scheduleID
	return s.automationScheduleErr
}

func (s *stubLogic) RunAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationRunResponse, error) {
	if s.automationRunResp != nil || s.automationRunErr != nil {
		s.automationScheduleID = scheduleID
		return s.automationRunResp, s.automationRunErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error) {
	if s.chatClawStateResp != nil || s.chatClawStateErr != nil {
		return s.chatClawStateResp, s.chatClawStateErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) SyncChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error) {
	if s.chatClawStateResp != nil || s.chatClawStateErr != nil {
		return s.chatClawStateResp, s.chatClawStateErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetChatClawRuntimeBootstrap(ctx pctx.Context, instanceID, conversationID string) (*transport.ChatClawRuntimeBootstrapResponse, error) {
	if s.chatClawRuntimeBootstrapResp != nil || s.chatClawRuntimeBootstrapErr != nil {
		s.chatClawRuntimeBootstrapConversationID = conversationID
		return s.chatClawRuntimeBootstrapResp, s.chatClawRuntimeBootstrapErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) CreateChatClawAgent(ctx pctx.Context, instanceID string, req *transport.CreateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error) {
	if s.createAgentResp != nil || s.createAgentErr != nil {
		if req != nil {
			cloned := *req
			s.createAgentReq = &cloned
		}
		return s.createAgentResp, s.createAgentErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UpdateChatClawAgent(ctx pctx.Context, instanceID, agentID string, req *transport.UpdateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error) {
	if s.updateAgentResp != nil || s.updateAgentErr != nil {
		if req != nil {
			cloned := *req
			s.updateAgentReq = &cloned
		}
		return s.updateAgentResp, s.updateAgentErr
	}
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) DeleteChatClawAgent(ctx pctx.Context, instanceID, agentID string) error {
	if s.deleteAgentErr != nil || s.deleteAgentID != "" {
		s.deleteAgentID = agentID
		return s.deleteAgentErr
	}
	return errors.New("unexpected call")
}

func (s *stubLogic) CreateChatClawTeam(ctx pctx.Context, instanceID string, req *transport.CreateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UpdateChatClawTeam(ctx pctx.Context, instanceID, teamID string, req *transport.UpdateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) DeleteChatClawTeam(ctx pctx.Context, instanceID, teamID string) error {
	return errors.New("unexpected call")
}

func (s *stubLogic) CreateChatClawConversation(ctx pctx.Context, instanceID string, req *transport.CreateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) UpdateChatClawConversation(ctx pctx.Context, instanceID, conversationID string, req *transport.UpdateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) DeleteChatClawConversation(ctx pctx.Context, instanceID, conversationID string) error {
	return errors.New("unexpected call")
}

func (s *stubLogic) CreateWeixinLoginSession(ctx pctx.Context, instanceID string) (*transport.CreateWeixinLoginSessionResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) GetWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) CancelWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, error) {
	return nil, errors.New("unexpected call")
}

func (s *stubLogic) SubscribeWeixinLoginSession(ctx pctx.Context, instanceID, sessionID string) (*transport.WeixinLoginSessionResponse, <-chan transport.WeixinLoginSessionEvent, func(), error) {
	return nil, nil, func() {}, errors.New("unexpected call")
}

func (s *stubLogic) ConfigureChannel(ctx pctx.Context, instanceID string, req *transport.ConfigureChannelRequest) (*transport.ConfigureChannelResponse, error) {
	if s.configureResp != nil || s.configureErr != nil {
		s.configureInstance = instanceID
		if req != nil {
			cloned := *req
			s.configureReq = &cloned
		}
		return s.configureResp, s.configureErr
	}
	return nil, errors.New("unexpected call")
}

func TestHealthEndpointUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" || payload.Data.Status != "ok" {
		t.Fatalf("unexpected payload: %s", rec.Body.String())
	}
}

func TestCreateInstanceUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{"soul_template_id":"gentle"}`))
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		createResp: &transport.InstanceResponse{
			InstanceID: "ins-1",
			Name:       "Gentle Bot",
			SandboxID:  "sbx-1",
			Status:     "Running",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	if got := rec.Header().Get(headerRequestID); got != "req-1" {
		t.Fatalf("unexpected response header request id: %s", got)
	}
	if values := rec.Header().Values(headerRequestID); len(values) != 1 {
		t.Fatalf("expected single %s header, got %v", headerRequestID, values)
	}

	var payload struct {
		Code      string                     `json:"code"`
		Message   string                     `json:"message"`
		RequestID string                     `json:"request_id"`
		Data      transport.InstanceResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" {
		t.Fatalf("unexpected envelope: %s", rec.Body.String())
	}
	if payload.RequestID != "req-1" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
	if payload.Data.InstanceID != "ins-1" || payload.Data.SandboxID != "sbx-1" {
		t.Fatalf("unexpected data: %+v", payload.Data)
	}
	if payload.Data.Name != "Gentle Bot" {
		t.Fatalf("unexpected instance name: %+v", payload.Data)
	}
	if handler.logic.(*stubLogic).createReq == nil || handler.logic.(*stubLogic).createReq.SoulTemplateID != "gentle" {
		t.Fatalf("expected soul_template_id to be forwarded, got %+v", handler.logic.(*stubLogic).createReq)
	}
}

func TestUpdateInstanceUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "/v1/instances/ins-1", strings.NewReader(`{"name":"Renamed Bot"}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		updateResp: &transport.InstanceResponse{
			InstanceID: "ins-1",
			Name:       "Renamed Bot",
			SandboxID:  "sbx-1",
			Status:     "Running",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code    string                     `json:"code"`
		Message string                     `json:"message"`
		Data    transport.InstanceResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Data.Name != "Renamed Bot" {
		t.Fatalf("unexpected payload: %s", rec.Body.String())
	}
	if handler.logic.(*stubLogic).updateReq == nil || handler.logic.(*stubLogic).updateReq.Name == nil || *handler.logic.(*stubLogic).updateReq.Name != "Renamed Bot" {
		t.Fatalf("expected name to be forwarded, got %+v", handler.logic.(*stubLogic).updateReq)
	}
}

func TestGetWorkspaceFilesUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/workspace/files?name=SOUL.md", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		workspaceResp: &transport.WorkspaceFilesResponse{
			Items: []*transport.WorkspaceFileResponse{{
				Name:    "SOUL.md",
				Content: "hello soul",
				Exists:  true,
			}},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code string                           `json:"code"`
		Data transport.WorkspaceFilesResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" {
		t.Fatalf("unexpected code: %s", payload.Code)
	}
	if handler.logic.(*stubLogic).workspaceFile != "SOUL.md" {
		t.Fatalf("expected file filter SOUL.md, got %q", handler.logic.(*stubLogic).workspaceFile)
	}
	if len(payload.Data.Items) != 1 || payload.Data.Items[0].Content != "hello soul" {
		t.Fatalf("unexpected payload: %+v", payload.Data.Items)
	}
}

func TestUpdateWorkspaceFileUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/workspace/files", strings.NewReader(`{"name":"SOUL.md","content":"updated"}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		updateWorkspaceResp: &transport.WorkspaceFileResponse{
			Name:    "SOUL.md",
			Content: "updated",
			Exists:  true,
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code string                          `json:"code"`
		Data transport.WorkspaceFileResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if handler.logic.(*stubLogic).updateWorkspaceReq == nil || handler.logic.(*stubLogic).updateWorkspaceReq.Name != "SOUL.md" || handler.logic.(*stubLogic).updateWorkspaceReq.Content != "updated" {
		t.Fatalf("expected forwarded request, got %+v", handler.logic.(*stubLogic).updateWorkspaceReq)
	}
	if payload.Data.Content != "updated" {
		t.Fatalf("unexpected payload: %+v", payload.Data)
	}
}

func TestUploadWorkspaceAttachmentUsesSuccessEnvelope(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("owner_type", "agent")
	_ = writer.WriteField("owner_id", "main")
	part, err := writer.CreateFormFile("file", "notes.md")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write([]byte("# hello\n")); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/workspace/uploads", &body)
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		uploadWorkspaceResp: &transport.WorkspaceUploadResponse{
			ID:            "upload_1",
			OwnerType:     "agent",
			OwnerID:       "main",
			AgentID:       "main",
			FileName:      "notes.md",
			MediaType:     "text/markdown",
			SizeBytes:     8,
			WorkspacePath: "/home/lightclaw/.openclaw/workspace",
			RelativePath:  "uploads/upload_1-notes.md",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if handler.logic.(*stubLogic).uploadWorkspaceReq == nil {
		t.Fatal("expected upload request to be forwarded")
	}
	if handler.logic.(*stubLogic).uploadWorkspaceReq.OwnerType != "agent" || handler.logic.(*stubLogic).uploadWorkspaceReq.FileName != "notes.md" {
		t.Fatalf("unexpected forwarded upload: %+v", handler.logic.(*stubLogic).uploadWorkspaceReq)
	}
}

func TestInternalChatClawRuntimeBootstrapReturnsTrustedFacts(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/internal/instances/ins-1/chatclaw/runtime-bootstrap?conversation_id=conv_1", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		chatClawRuntimeBootstrapResp: &transport.ChatClawRuntimeBootstrapResponse{
			UserID:             "user-1",
			InstanceID:         "ins-1",
			ConversationID:     "conv_1",
			SessionID:          "ses_1",
			SessionTitle:       "Main conversation",
			UpstreamSessionKey: "agent:main:chatclaw:1",
			GatewayURL:         "wss://18789-sandbox-1.sandbox.lightclaw.tech",
			GatewayToken:       "gw-token",
		},
	}}

	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if handler.logic.(*stubLogic).chatClawRuntimeBootstrapConversationID != "conv_1" {
		t.Fatalf("expected conversation id to be forwarded, got %q", handler.logic.(*stubLogic).chatClawRuntimeBootstrapConversationID)
	}

	var payload transport.ChatClawRuntimeBootstrapResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if payload.GatewayToken != "gw-token" || payload.ConversationID != "conv_1" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestInternalChatClawRuntimeBootstrapRequiresInternalBearerWhenConfigured(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "inner-token")
	req := httptest.NewRequest(http.MethodGet, "/internal/instances/ins-1/chatclaw/runtime-bootstrap?conversation_id=conv_1", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		chatClawRuntimeBootstrapResp: &transport.ChatClawRuntimeBootstrapResponse{},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGetWorkspaceUploadContentStreamsBytes(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/workspace/uploads/upload_1/content", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		getWorkspaceUploadContentResp: &transport.WorkspaceUploadResponse{
			ID:        "upload_1",
			FileName:  "notes.md",
			MediaType: "text/markdown",
		},
		getWorkspaceUploadContent: []byte("# hello\n"),
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/markdown" {
		t.Fatalf("unexpected content type: %s", got)
	}
	if rec.Body.String() != "# hello\n" {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
}

func TestListAutomationSchedulesUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/automation/schedules?offset=10&limit=20", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		automationSchedulesResp: &transport.AutomationSchedulesResponse{
			Items: []*transport.AutomationSchedule{{
				ID:      "job_1",
				Title:   "Morning sync",
				Enabled: true,
			}},
			Total: 1,
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Code string                                `json:"code"`
		Data transport.AutomationSchedulesResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" {
		t.Fatalf("unexpected code: %s", payload.Code)
	}
	if handler.logic.(*stubLogic).automationOffset != 10 || handler.logic.(*stubLogic).automationLimit != 20 {
		t.Fatalf("unexpected pagination: offset=%d limit=%d", handler.logic.(*stubLogic).automationOffset, handler.logic.(*stubLogic).automationLimit)
	}
	if len(payload.Data.Items) != 1 || payload.Data.Items[0].ID != "job_1" {
		t.Fatalf("unexpected payload: %+v", payload.Data)
	}
}

func TestCreateAutomationScheduleUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/automation/schedules", strings.NewReader(`{"title":"Morning sync","prompt":"Check alerts","cron":"0 9 * * *","timezone":"Asia/Shanghai","enabled":true}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		automationScheduleResp: &transport.AutomationSchedule{
			ID:      "job_1",
			Title:   "Morning sync",
			Enabled: true,
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if handler.logic.(*stubLogic).automationCreateReq == nil || handler.logic.(*stubLogic).automationCreateReq.Title != "Morning sync" || handler.logic.(*stubLogic).automationCreateReq.Prompt != "Check alerts" {
		t.Fatalf("unexpected request: %+v", handler.logic.(*stubLogic).automationCreateReq)
	}
}

func TestRunAutomationScheduleUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/automation/schedules/job_1/run", strings.NewReader(`{}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		automationRunResp: &transport.AutomationRunResponse{
			ID:     "job_1",
			Status: "ok",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if handler.logic.(*stubLogic).automationScheduleID != "job_1" {
		t.Fatalf("expected run target job_1, got %s", handler.logic.(*stubLogic).automationScheduleID)
	}
}

func TestGetChatClawStateUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/chatclaw", nil)
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		chatClawStateResp: &transport.ChatClawStateResponse{
			Agents: []*transport.ChatClawAgentResponse{{ID: "main", Name: "Main"}},
			Teams:  []*transport.ChatClawTeamResponse{{ID: "solo-team", Name: "Solo Team"}},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code string                          `json:"code"`
		Data transport.ChatClawStateResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || len(payload.Data.Agents) != 1 || payload.Data.Agents[0].ID != "main" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestCreateChatClawAgentUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/chatclaw/agents", strings.NewReader(`{"name":"Research","description":"desc","specialty":"research"}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		createAgentResp: &transport.ChatClawAgentResponse{
			ID:        "agent_1",
			Name:      "Research",
			Specialty: "research",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code string                          `json:"code"`
		Data transport.ChatClawAgentResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Data.Name != "Research" || handler.logic.(*stubLogic).createAgentReq == nil || handler.logic.(*stubLogic).createAgentReq.Specialty != "research" {
		t.Fatalf("unexpected payload/request: %+v %+v", payload.Data, handler.logic.(*stubLogic).createAgentReq)
	}
}

func TestListSoulTemplatesUsesSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/soul-templates", nil)
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-soul")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		listSoulResp: &transport.ListSoulTemplatesResponse{
			Items: []*transport.SoulTemplateResponse{
				{ID: "gentle", Name: "Gentle & Caring", Description: "Warm and supportive."},
				{ID: "pro", Name: "Professional & Knowledgeable", Description: "Structured and precise."},
			},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload struct {
		Code      string                              `json:"code"`
		Message   string                              `json:"message"`
		RequestID string                              `json:"request_id"`
		Data      transport.ListSoulTemplatesResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" {
		t.Fatalf("unexpected envelope: %s", rec.Body.String())
	}
	if payload.RequestID != "req-soul" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
	if len(payload.Data.Items) != 2 || payload.Data.Items[0].ID != "gentle" {
		t.Fatalf("unexpected data: %+v", payload.Data)
	}
}

func TestListSoulTemplatesRequiresUserID(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/soul-templates", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceMissingUserID.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestCreateInstanceRejectsWithRetryAfterMetadata(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader(`{}`))
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-reject")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		createErr: &stubRetryAfterError{seconds: 42},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "42" {
		t.Fatalf("unexpected Retry-After: %s", got)
	}

	var payload struct {
		Code              string `json:"code"`
		Message           string `json:"message"`
		RequestID         string `json:"request_id"`
		RetryAfterSeconds *int   `json:"retry_after_seconds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceChurnLimited.Code {
		t.Fatalf("unexpected code: %s", payload.Code)
	}
	if payload.RetryAfterSeconds == nil || *payload.RetryAfterSeconds != 42 {
		t.Fatalf("unexpected retry_after_seconds: %+v", payload.RetryAfterSeconds)
	}
	if payload.RequestID != "req-reject" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
}

func TestGeneratedRequestIDIsReturnedInHeaderBodyAndAccessLog(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	prevLogger := resource.ZapLogger
	resource.ZapLogger = zap.New(core)
	defer func() {
		resource.ZapLogger = prevLogger
	}()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload successResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.RequestID == "" {
		t.Fatal("expected generated request_id in body")
	}
	if got := rec.Header().Get(headerRequestID); got != payload.RequestID {
		t.Fatalf("header request id mismatch: got %s want %s", got, payload.RequestID)
	}
	if values := rec.Header().Values(headerRequestID); len(values) != 1 {
		t.Fatalf("expected single %s header, got %v", headerRequestID, values)
	}

	entries := logs.FilterMessage("http request").All()
	if len(entries) != 1 {
		t.Fatalf("expected one access log, got %d", len(entries))
	}
	if got := entries[0].ContextMap()[logfields.FieldTraceID]; got != payload.RequestID {
		t.Fatalf("log trace_id mismatch: got %v want %s", got, payload.RequestID)
	}
}

func TestRequestIDHeaderTakesPrecedenceOverTraceHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(headerRequestID, "req-preferred")
	req.Header.Set(headerTraceID, "trace-fallback")
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload successResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.RequestID != "req-preferred" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
	if got := rec.Header().Get(headerRequestID); got != "req-preferred" {
		t.Fatalf("unexpected response header request id: %s", got)
	}
}

func TestInvalidRouteReturnsJSONNotFound(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrNotFound.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestMethodNotAllowedReturnsJSONError(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "/v1/instances", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrMethodNotAllowed.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestInvalidJSONUsesInstanceInvalidParam(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances", strings.NewReader("{"))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceInvalidParam.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestWriteHTTPErrorUsesStringCodesForWrappedErrors(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances", nil).WithContext(context.Background())
	rec := httptest.NewRecorder()

	writeHTTPError(rec, req, errcode.Wrap(errcode.ErrInstanceInvalidParam, "bad page"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceInvalidParam.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

type stubDetailError struct {
	detail any
}

func (e *stubDetailError) Error() string {
	return errcode.ErrDebugExecFailed.Message
}

func (e *stubDetailError) Unwrap() error {
	return errcode.ErrDebugExecFailed
}

func (e *stubDetailError) ErrorDetail() any {
	return e.detail
}

func TestWriteHTTPErrorIncludesDetails(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances", nil).WithContext(context.Background())
	rec := httptest.NewRecorder()

	writeHTTPError(rec, req, &stubDetailError{detail: map[string]any{
		"stdout":    "hello",
		"stderr":    "boom",
		"exit_code": 17,
	}})

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", rec.Code)
	}

	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrDebugExecFailed.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
	details, ok := payload.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected details object, got %#v", payload.Details)
	}
	if details["stderr"] != "boom" {
		t.Fatalf("unexpected details: %#v", details)
	}
}

type streamingRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (r *streamingRecorder) Flush() {
	r.flushed = true
	r.ResponseRecorder.Flush()
}

func TestNotFoundMiddlewareBypassesBufferingForStreamingRequests(t *testing.T) {
	handler := notFoundMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "event: ping\n")
		_, _ = fmt.Fprint(w, "data: {}\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/channels/weixin/login-sessions/sess-1/events", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec := &streamingRecorder{ResponseRecorder: httptest.NewRecorder()}

	handler.ServeHTTP(rec, req)

	if !rec.flushed {
		t.Fatalf("expected streaming response to flush")
	}
	if !strings.Contains(rec.Body.String(), "event: ping") {
		t.Fatalf("expected SSE body, got %q", rec.Body.String())
	}
}

func TestListOperationsReturnsSuccessEnvelope(t *testing.T) {
	now := time.Now().Truncate(time.Millisecond)
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/operations?page=1&page_size=10", nil)
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-ops")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		listOperationsResp: &transport.ListOperationsResponse{
			Total:    1,
			Page:     1,
			PageSize: 10,
			Items: []*transport.OperationResponse{
				{
					OperationID:   "op-abc",
					OperationType: "CREATE",
					InstanceID:    "ins-1",
					Status:        "SUCCESS",
					CreatedAt:     now,
					UpdatedAt:     now,
				},
			},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d, body: %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code      string                           `json:"code"`
		Message   string                           `json:"message"`
		RequestID string                           `json:"request_id"`
		Data      transport.ListOperationsResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" {
		t.Fatalf("unexpected envelope: %s", rec.Body.String())
	}
	if payload.RequestID != "req-ops" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
	if payload.Data.Total != 1 || len(payload.Data.Items) != 1 {
		t.Fatalf("unexpected data: %+v", payload.Data)
	}
	if payload.Data.Items[0].OperationID != "op-abc" || payload.Data.Items[0].Status != "SUCCESS" {
		t.Fatalf("unexpected operation item: %+v", payload.Data.Items[0])
	}
}

func TestExecDebugCommandPassesRunAsUser(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/debug/exec", strings.NewReader(`{"command":"echo hello","run_as_user":"agentuser"}`))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		debugResp: &transport.ExecDebugCommandResponse{
			Status:    "SUCCESS",
			RunAsUser: "agentuser",
			ExitCode:  0,
			Output:    "hello\n",
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	stub := handler.logic.(*stubLogic)
	if stub.debugInstanceID != "ins-1" || stub.debugCommand != "echo hello" || stub.debugRunAsUser != "agentuser" {
		t.Fatalf("unexpected debug call capture: instance=%q command=%q runAs=%q", stub.debugInstanceID, stub.debugCommand, stub.debugRunAsUser)
	}

	var payload struct {
		Code string                             `json:"code"`
		Data transport.ExecDebugCommandResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Data.RunAsUser != "agentuser" {
		t.Fatalf("expected run_as_user in response, got %+v", payload.Data)
	}
}

func TestExecDebugCommandStreamsSSE(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/debug/exec", strings.NewReader(`{"command":"echo hello","run_as_user":"agentuser"}`))
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set("Accept", "text/event-stream")
	rec := &streamingRecorder{ResponseRecorder: httptest.NewRecorder()}

	handler := &instanceHandler{logic: &stubLogic{
		debugStreamEvents: []transport.ExecDebugCommandStreamEvent{
			{Type: "started", InvocationID: "pid:1234", CommandID: "pid:1234", RunAsUser: "agentuser"},
			{Type: "stdout", Stream: "stdout", Chunk: "hello\n", InvocationID: "pid:1234", CommandID: "pid:1234", RunAsUser: "agentuser"},
			{Type: "finished", InvocationID: "pid:1234", CommandID: "pid:1234", RunAsUser: "agentuser", Response: &transport.ExecDebugCommandResponse{
				Status:       "SUCCESS",
				RunAsUser:    "agentuser",
				ExitCode:     0,
				Output:       "hello\n",
				Stdout:       "hello\n",
				InvocationID: "pid:1234",
				CommandID:    "pid:1234",
			}},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if !rec.flushed {
		t.Fatalf("expected streaming response to flush")
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: started") || !strings.Contains(body, "event: stdout") || !strings.Contains(body, "event: finished") {
		t.Fatalf("expected started/stdout/finished events, got %q", body)
	}
	if !strings.Contains(body, `"run_as_user":"agentuser"`) {
		t.Fatalf("expected run_as_user in stream body, got %q", body)
	}

	stub := handler.logic.(*stubLogic)
	if stub.debugRunAsUser != "agentuser" {
		t.Fatalf("expected run_as_user forwarded to logic, got %q", stub.debugRunAsUser)
	}
}

func TestListOperationsMissingUserIDReturnsError(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/operations", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceMissingUserID.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestGetInstanceLogsReturnsSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/logs?limit=50", nil)
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-logs")
	rec := httptest.NewRecorder()

	handler := &instanceHandler{logic: &stubLogic{
		getLogsResp: &psandbox.SandboxLogs{
			Logs: []psandbox.SandboxLog{
				{Line: "hello world"},
			},
		},
	}}
	newRouter(handler, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d, body: %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Code      string               `json:"code"`
		Message   string               `json:"message"`
		RequestID string               `json:"request_id"`
		Data      psandbox.SandboxLogs `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" {
		t.Fatalf("unexpected envelope: %s", rec.Body.String())
	}
	if payload.RequestID != "req-logs" {
		t.Fatalf("unexpected request_id: %s", payload.RequestID)
	}
	if len(payload.Data.Logs) != 1 || payload.Data.Logs[0].Line != "hello world" {
		t.Fatalf("unexpected logs data: %+v", payload.Data)
	}
}

func TestGetInstanceLogsMissingUserIDReturnsError(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/logs", nil)
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceMissingUserID.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestParseLogsParamsDefaults(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/logs", nil)
	start, limit := parseLogsParams(req)
	if start != nil {
		t.Fatalf("expected nil start, got %d", *start)
	}
	if limit == nil || *limit != 100 {
		t.Fatalf("expected default limit 100, got %v", limit)
	}
}

func TestParseLogsParamsRejectsNegativeStart(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/logs?start=-1&limit=50", nil)
	start, limit := parseLogsParams(req)
	if start != nil {
		t.Fatalf("expected nil start for negative value, got %d", *start)
	}
	if limit == nil || *limit != 50 {
		t.Fatalf("expected limit 50, got %v", limit)
	}
}

func TestParseLogsParamsRejectsOutOfRangeLimit(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/instances/ins-1/logs?limit=9999", nil)
	_, limit := parseLogsParams(req)
	// out of range limit falls back to default 100
	if limit == nil || *limit != 100 {
		t.Fatalf("expected default limit 100 for out-of-range, got %v", limit)
	}
}

func TestConfigureChannelReturnsSuccessEnvelope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/channels/config", strings.NewReader(`{"channel":"qqbot","token":"123:secret","account":"bot1"}`))
	req.Header.Set(headerUserID, "user-1")
	req.Header.Set(headerRequestID, "req-channel")
	rec := httptest.NewRecorder()

	logic := &stubLogic{
		configureResp: &transport.ConfigureChannelResponse{
			Status:           "Succeeded",
			Channel:          "qqbot",
			GatewayRestarted: true,
			Output:           "configured",
		},
	}
	newRouter(&instanceHandler{logic: logic}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if logic.configureInstance != "ins-1" {
		t.Fatalf("unexpected instance id: %s", logic.configureInstance)
	}
	if logic.configureReq == nil || logic.configureReq.Channel != "qqbot" || logic.configureReq.Token != "123:secret" || logic.configureReq.Account != "bot1" {
		t.Fatalf("unexpected request: %+v", logic.configureReq)
	}

	var payload struct {
		Code      string                             `json:"code"`
		Message   string                             `json:"message"`
		RequestID string                             `json:"request_id"`
		Data      transport.ConfigureChannelResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "OK" || payload.Message != "success" || payload.RequestID != "req-channel" {
		t.Fatalf("unexpected envelope: %+v", payload)
	}
	if payload.Data.Status != "Succeeded" || payload.Data.Channel != "qqbot" || !payload.Data.GatewayRestarted {
		t.Fatalf("unexpected data: %+v", payload.Data)
	}
}

func TestConfigureChannelMissingUserIDReturnsError(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/channels/config", strings.NewReader(`{"channel":"qqbot","token":"123:secret"}`))
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceMissingUserID.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}

func TestConfigureChannelInvalidJSONReturnsError(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/ins-1/channels/config", strings.NewReader("{"))
	req.Header.Set(headerUserID, "user-1")
	rec := httptest.NewRecorder()

	newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	var payload errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != errcode.ErrInstanceInvalidParam.Code {
		t.Fatalf("unexpected error code: %+v", payload)
	}
}
