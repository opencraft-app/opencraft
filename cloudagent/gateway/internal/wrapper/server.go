package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

type Server struct {
	store   *Store
	worker  Worker
	acpGate *ACPGateway
}

func NewServer(store *Store, worker Worker) *Server {
	return &Server{store: store, worker: worker, acpGate: NewACPGateway(store, worker)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/models", s.handleListModels)
	mux.HandleFunc("POST /v1/files", s.handleCreateFile)
	mux.HandleFunc("GET /v1/files/", s.handleGetFileContent)
	mux.HandleFunc("POST /v1/responses", s.handleCreateResponse)
	mux.HandleFunc("GET /v1/responses/", s.handleGetResponse)
	mux.HandleFunc("POST /v1/chat/completions", s.handleCreateChatCompletion)
	mux.HandleFunc("/v1/acp/sessions/", s.handleSessionEnvdProxy)
	mux.HandleFunc("/acp", s.handleRawACP)
	mux.HandleFunc("/ws", s.handleAppWS)
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.serveMaybeEnvdProxy(w, r) {
			return
		}
		mux.ServeHTTP(w, r)
	}))
	return otelhttp.NewHandler(withOTELAccessLog(handler), "cloudagent-gateway")
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID, X-Tenant-ID, X-Project-ID, X-Sandbox-Scope")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serverTimeline(start time.Time, event string, fields ...string) {
	parts := []string{
		fmt.Sprintf("timeline source=server t=%.3fs", time.Since(start).Seconds()),
		"event=" + event,
	}
	parts = append(parts, fields...)
	fmt.Fprintln(os.Stderr, strings.Join(parts, " "))
}

func quoteServerField(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func (s *Server) handleRawACP(w http.ResponseWriter, r *http.Request) {
	s.acpGate.HandleRawWS(w, r)
}

func (s *Server) handleAppWS(w http.ResponseWriter, r *http.Request) {
	s.acpGate.HandleAppWS(w, r)
}

func (s *Server) handleSessionEnvdProxy(w http.ResponseWriter, r *http.Request) {
	s.acpGate.HandleSessionEnvdProxy(w, r)
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "models_request_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	models := configuredModels()
	serverTimeline(start, "models_request_done", "tenant="+quoteServerField(scope.TenantID), "project="+quoteServerField(scope.ProjectID), fmt.Sprintf("models=%d", len(models)))
	writeJSON(w, http.StatusOK, listModelsResponse{Object: "list", Data: models})
}

func (s *Server) handleCreateFile(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "file_upload_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	serverTimeline(start, "file_upload_request_start", "tenant="+quoteServerField(scope.TenantID), "project="+quoteServerField(scope.ProjectID))
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		serverTimeline(start, "file_upload_failed", "code=invalid_multipart", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusBadRequest, "invalid_multipart", err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		serverTimeline(start, "file_upload_failed", "code=file_required", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusBadRequest, "file_required", "multipart field file is required")
		return
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil {
		serverTimeline(start, "file_upload_failed", "code=file_read_failed", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusBadRequest, "file_read_failed", err.Error())
		return
	}
	purpose := r.FormValue("purpose")
	if purpose == "" {
		purpose = "assistants"
	}
	contentType := contentTypeFromHeader(header)
	serverTimeline(start, "file_upload_read_done", "filename="+quoteServerField(header.Filename), fmt.Sprintf("bytes=%d", len(content)), "purpose="+quoteServerField(purpose))
	rec, err := s.store.PutFile(scope, header.Filename, purpose, contentType, "input", "", content)
	if err != nil {
		serverTimeline(start, "file_upload_failed", "code=file_persist_failed", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusInternalServerError, "file_persist_failed", err.Error())
		return
	}
	s.store.AddAudit("file_uploaded", scope, "", rec.ID, "")
	serverTimeline(start, "file_upload_done", "file_id="+rec.ID, fmt.Sprintf("bytes=%d", rec.Bytes), "sha256="+rec.SHA256)
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleGetFileContent(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "file_download_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	id, ok := fileIDFromContentPath(r.URL.Path)
	if !ok {
		serverTimeline(start, "file_download_failed", "code=not_found")
		writeError(w, http.StatusNotFound, "not_found", "unknown file endpoint")
		return
	}
	serverTimeline(start, "file_download_start", "file_id="+id, "tenant="+quoteServerField(scope.TenantID), "project="+quoteServerField(scope.ProjectID))
	rec, content, apiErr := s.store.GetFile(scope, id)
	if apiErr != nil {
		status := http.StatusForbidden
		if apiErr.Code == "file_not_found" {
			status = http.StatusNotFound
		}
		if apiErr.Code == "file_expired" {
			status = http.StatusGone
		}
		serverTimeline(start, "file_download_failed", "file_id="+id, "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		writeError(w, status, apiErr.Code, apiErr.Message)
		return
	}
	w.Header().Set("Content-Type", rec.ContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", rec.Filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
	serverTimeline(start, "file_download_done", "file_id="+id, "kind="+rec.Kind, fmt.Sprintf("bytes=%d", len(content)), "source_response_id="+rec.SourceResponseID)
}

func (s *Server) handleCreateResponse(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "response_request_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	var req createResponseRequest
	if err := decodeCreateResponseRequest(r.Body, &req); err != nil {
		serverTimeline(start, "response_request_failed", "code=invalid_json", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	serverTimeline(start, "response_request_start", "model="+quoteServerField(req.Model), fmt.Sprintf("stream=%t", req.Stream), "tenant="+quoteServerField(scope.TenantID), "project="+quoteServerField(scope.ProjectID))
	if req.PreviousResponseID != "" {
		if _, apiErr := s.store.GetResponse(scope, req.PreviousResponseID); apiErr != nil {
			status := http.StatusForbidden
			if apiErr.Code == "response_not_found" {
				status = http.StatusNotFound
			}
			serverTimeline(start, "response_request_failed", "code="+apiErr.Code, "field=previous_response_id", "message="+quoteServerField(apiErr.Message))
			writeError(w, status, apiErr.Code, apiErr.Message)
			return
		}
		serverTimeline(start, "previous_response_accepted", "previous_response_id="+req.PreviousResponseID)
	}
	instruction, fileIDs, err := extractInput(req)
	if err != nil {
		serverTimeline(start, "response_request_failed", "code=invalid_input", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	files, apiErr := s.store.MaterializeFiles(scope, fileIDs)
	if apiErr != nil {
		status := http.StatusForbidden
		if apiErr.Code == "file_not_found" {
			status = http.StatusNotFound
		}
		serverTimeline(start, "response_request_failed", "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		writeError(w, status, apiErr.Code, apiErr.Message)
		return
	}
	rec := s.store.CreateResponse(scope, req.Model)
	job := workerJob{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 "job_" + randomHex(12),
		ResponseID:            rec.ID,
		Model:                 req.Model,
		Scope:                 scope,
		Instruction:           strings.TrimSpace(req.Instructions + "\n" + instruction),
		InputFiles:            files,
		TimeoutSeconds:        300,
		CorrelationID:         r.Header.Get("X-Request-ID"),
	}
	serverTimeline(start, "response_job_ready", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("input_files=%d", len(files)), fmt.Sprintf("instruction_bytes=%d", len(job.Instruction)))
	if req.Stream {
		s.runStreaming(w, r, rec, job, start)
		return
	}
	serverTimeline(start, "worker_run_start", "response_id="+rec.ID, "job_id="+job.JobID)
	result, workerErr := s.worker.Run(r.Context(), job, func(workerEvent) error { return nil })
	if workerErr != nil {
		apiErr := apiErrorFromWorker(workerErr)
		serverTimeline(start, "worker_run_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		failed := s.store.FailResponse(rec.ID, apiErr)
		writeJSON(w, http.StatusOK, failed)
		return
	}
	serverTimeline(start, "worker_run_done", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("output_bytes=%d", len(result.OutputText)), fmt.Sprintf("artifacts=%d", len(result.Artifacts)))
	completed, persistErr := s.persistArtifactsAndComplete(r.Context(), job, rec, result, start)
	if persistErr != nil {
		serverTimeline(start, "response_finalize_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+persistErr.Code, "message="+quoteServerField(persistErr.Message))
		failed := s.store.FailResponse(rec.ID, persistErr)
		writeJSON(w, http.StatusOK, failed)
		return
	}
	serverTimeline(start, "response_completed", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("artifact_file_ids=%d", len(completed.ArtifactFileIDs)))
	writeJSON(w, http.StatusOK, completed)
}

func (s *Server) handleCreateChatCompletion(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "chat_completion_denied", "code="+errResp.Code)
		chatCompletionError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	var req chatCompletionRequest
	if err := decodeChatCompletionRequest(r.Body, &req); err != nil {
		serverTimeline(start, "chat_completion_failed", "code=invalid_json", "error="+quoteServerField(err.Error()))
		chatCompletionError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	instruction, err := chatMessagesInstruction(req.Messages)
	if err != nil {
		serverTimeline(start, "chat_completion_failed", "code=invalid_messages", "error="+quoteServerField(err.Error()))
		chatCompletionError(w, http.StatusBadRequest, "invalid_messages", err.Error())
		return
	}
	rec := s.store.CreateResponse(scope, req.Model)
	job := workerJob{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 "job_" + randomHex(12),
		ResponseID:            rec.ID,
		Model:                 req.Model,
		Scope:                 scope,
		Instruction:           instruction,
		TimeoutSeconds:        300,
		CorrelationID:         r.Header.Get("X-Request-ID"),
	}
	serverTimeline(start, "chat_completion_start", "response_id="+rec.ID, "job_id="+job.JobID, "model="+quoteServerField(req.Model), fmt.Sprintf("stream=%t", req.Stream))
	if req.Stream {
		s.runChatCompletionStreaming(w, r, rec, job, start)
		return
	}
	result, workerErr := s.worker.Run(r.Context(), job, func(workerEvent) error { return nil })
	if workerErr != nil {
		apiErr := apiErrorFromWorker(workerErr)
		serverTimeline(start, "chat_completion_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		_ = s.store.FailResponse(rec.ID, apiErr)
		chatCompletionError(w, http.StatusInternalServerError, apiErr.Code, apiErr.Message)
		return
	}
	completed, persistErr := s.persistArtifactsAndComplete(r.Context(), job, rec, result, start)
	if persistErr != nil {
		serverTimeline(start, "chat_completion_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+persistErr.Code, "message="+quoteServerField(persistErr.Message))
		_ = s.store.FailResponse(rec.ID, persistErr)
		chatCompletionError(w, http.StatusInternalServerError, persistErr.Code, persistErr.Message)
		return
	}
	serverTimeline(start, "chat_completion_done", "response_id="+rec.ID, "job_id="+job.JobID)
	writeJSON(w, http.StatusOK, chatCompletionResponse(chatCompletionID(), completed.CreatedAt, completed.Model, completed.OutputText))
}

func (s *Server) runChatCompletionStreaming(w http.ResponseWriter, r *http.Request, rec ResponseRecord, job workerJob, start time.Time) {
	stream, ok := newSSEWriter(w)
	if !ok {
		serverTimeline(start, "chat_completion_stream_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code=streaming_unsupported")
		chatCompletionError(w, http.StatusInternalServerError, "streaming_unsupported", "response writer does not support flushing")
		return
	}
	streamID := chatCompletionID()
	created := chatCompletionCreated()
	serverTimeline(start, "chat_completion_stream_start", "response_id="+rec.ID, "job_id="+job.JobID)
	var output strings.Builder
	result, workerErr := s.worker.Run(r.Context(), job, func(ev workerEvent) error {
		if err := validateWorkerVersion(ev.WorkerContractVersion); err != nil {
			return err
		}
		if ev.Kind != "output_text_delta" || ev.Delta == "" {
			return nil
		}
		output.WriteString(ev.Delta)
		return stream.SendData(chatCompletionChunk(streamID, created, rec.Model, ev.Delta, ""))
	})
	if workerErr != nil {
		apiErr := apiErrorFromWorker(workerErr)
		serverTimeline(start, "chat_completion_stream_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		_ = stream.SendData(map[string]any{"error": apiErr})
		return
	}
	if strings.TrimSpace(result.OutputText) == "" && output.Len() > 0 {
		result.OutputText = output.String()
	}
	completed, persistErr := s.persistArtifactsAndComplete(r.Context(), job, rec, result, start)
	if persistErr != nil {
		serverTimeline(start, "chat_completion_stream_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+persistErr.Code, "message="+quoteServerField(persistErr.Message))
		_ = stream.SendData(map[string]any{"error": persistErr})
		return
	}
	_ = stream.SendData(chatCompletionChunk(streamID, created, completed.Model, "", "stop"))
	_ = stream.SendRawData("[DONE]")
	serverTimeline(start, "chat_completion_stream_done", "response_id="+rec.ID, "job_id="+job.JobID)
}

func (s *Server) handleGetResponse(w http.ResponseWriter, r *http.Request) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	id := path.Base(r.URL.Path)
	rec, apiErr := s.store.GetResponse(scope, id)
	if apiErr != nil {
		status := http.StatusForbidden
		if apiErr.Code == "response_not_found" {
			status = http.StatusNotFound
		}
		writeError(w, status, apiErr.Code, apiErr.Message)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) runStreaming(w http.ResponseWriter, r *http.Request, rec ResponseRecord, job workerJob, start time.Time) {
	stream, ok := newSSEWriter(w)
	if !ok {
		serverTimeline(start, "response_stream_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code=streaming_unsupported")
		writeError(w, http.StatusInternalServerError, "streaming_unsupported", "response writer does not support flushing")
		return
	}
	serverTimeline(start, "response_stream_start", "response_id="+rec.ID, "job_id="+job.JobID)
	_ = stream.Send("response.created", responseCreatedEvent(rec))
	var output strings.Builder
	serverTimeline(start, "worker_run_start", "response_id="+rec.ID, "job_id="+job.JobID)
	result, workerErr := s.worker.Run(r.Context(), job, func(ev workerEvent) error {
		if err := validateWorkerVersion(ev.WorkerContractVersion); err != nil {
			return err
		}
		if ev.Kind != "output_text_delta" {
			return nil
		}
		output.WriteString(ev.Delta)
		return stream.Send("response.output_text.delta", responseEvent("response.output_text.delta", rec.ID, map[string]any{
			"item_id":       rec.ID,
			"output_index":  0,
			"content_index": 0,
			"delta":         ev.Delta,
			"sequence":      ev.Sequence,
		}))
	})
	if workerErr != nil {
		apiErr := apiErrorFromWorker(workerErr)
		serverTimeline(start, "worker_run_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+apiErr.Code, "message="+quoteServerField(apiErr.Message))
		_ = stream.Send("error", map[string]any{"type": "error", "response_id": rec.ID, "error": apiErr})
		return
	}
	serverTimeline(start, "worker_run_done", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("output_bytes=%d", len(result.OutputText)), fmt.Sprintf("artifacts=%d", len(result.Artifacts)))
	if strings.TrimSpace(result.OutputText) == "" && output.Len() > 0 {
		result.OutputText = output.String()
	}
	completed, persistErr := s.persistArtifactsAndComplete(r.Context(), job, rec, result, start)
	if persistErr != nil {
		serverTimeline(start, "response_finalize_failed", "response_id="+rec.ID, "job_id="+job.JobID, "code="+persistErr.Code, "message="+quoteServerField(persistErr.Message))
		failed := s.store.FailResponse(rec.ID, persistErr)
		_ = stream.Send("error", map[string]any{"type": "error", "response_id": rec.ID, "error": failed.Error})
		return
	}
	_ = stream.Send("response.output_text.done", responseEvent("response.output_text.done", rec.ID, map[string]any{
		"item_id":       rec.ID,
		"output_index":  0,
		"content_index": 0,
		"text":          completed.OutputText,
	}))
	_ = stream.Send("response.completed", responseCompletedEvent(completed))
	serverTimeline(start, "response_completed", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("artifact_file_ids=%d", len(completed.ArtifactFileIDs)))
}

func (s *Server) persistArtifactsAndComplete(ctx context.Context, job workerJob, rec ResponseRecord, result workerResult, start time.Time) (ResponseRecord, *APIError) {
	scope := rec.Scope
	serverTimeline(start, "artifact_persist_start", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("artifacts=%d", len(result.Artifacts)))
	if err := validateWorkerVersion(result.WorkerContractVersion); err != nil {
		s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", err.Error())
		return ResponseRecord{}, apiErr("artifact_persistence_failed", err.Error())
	}
	artifactIDs := make([]string, 0, len(result.Artifacts))
	for _, artifact := range result.Artifacts {
		serverTimeline(start, "artifact_persist_item_start", "response_id="+rec.ID, "job_id="+job.JobID, "filename="+quoteServerField(artifact.LogicalFilename), fmt.Sprintf("declared_bytes=%d", artifact.SizeBytes))
		if err := validateWorkerVersion(artifact.WorkerContractVersion); err != nil {
			s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", err.Error())
			return ResponseRecord{}, apiErr("artifact_persistence_failed", err.Error())
		}
		content, err := s.worker.FetchArtifact(ctx, job, artifact)
		if err != nil {
			s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", err.Error())
			return ResponseRecord{}, apiErr("artifact_persistence_failed", err.Error())
		}
		sum := sha256.Sum256(content)
		if artifact.ChecksumSHA256 != "" && artifact.ChecksumSHA256 != fmt.Sprintf("%x", sum[:]) {
			s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", "artifact checksum mismatch")
			return ResponseRecord{}, apiErr("artifact_persistence_failed", "artifact checksum mismatch")
		}
		if artifact.SizeBytes > 0 && artifact.SizeBytes != int64(len(content)) {
			s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", "artifact size mismatch")
			return ResponseRecord{}, apiErr("artifact_persistence_failed", "artifact size mismatch")
		}
		filename := artifact.LogicalFilename
		if filename == "" {
			filename = "artifact"
		}
		contentType := artifact.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		fileRec, err := s.store.PutFile(scope, filename, "assistants_output", contentType, "artifact", rec.ID, content)
		if err != nil {
			s.store.AddAudit("artifact_persistence_failed", scope, rec.ID, "", err.Error())
			return ResponseRecord{}, apiErr("artifact_persistence_failed", err.Error())
		}
		artifactIDs = append(artifactIDs, fileRec.ID)
		s.store.AddAudit("artifact_created", scope, rec.ID, fileRec.ID, "")
		serverTimeline(start, "artifact_persist_item_done", "response_id="+rec.ID, "job_id="+job.JobID, "file_id="+fileRec.ID, fmt.Sprintf("bytes=%d", fileRec.Bytes))
	}
	serverTimeline(start, "artifact_persist_done", "response_id="+rec.ID, "job_id="+job.JobID, fmt.Sprintf("artifact_file_ids=%d", len(artifactIDs)))
	return s.store.CompleteResponse(rec.ID, result.OutputText, artifactIDs), nil
}

func validateWorkerVersion(version string) error {
	if version == "" {
		return workerError("worker_contract_version_missing", "worker_contract_version_missing: worker contract version is required")
	}
	if version != WorkerContractVersion {
		return workerError("worker_contract_version_mismatch", "worker_contract_version_mismatch: worker contract version mismatch")
	}
	return nil
}

func extractInput(req createResponseRequest) (string, []string, error) {
	var texts []string
	var fileIDs []string
	if err := walkInput(req.Input, &texts, &fileIDs); err != nil {
		return "", nil, err
	}
	return strings.Join(texts, "\n"), dedupe(fileIDs), nil
}

func walkInput(value any, texts *[]string, fileIDs *[]string) error {
	switch v := value.(type) {
	case string:
		if v != "" {
			*texts = append(*texts, v)
		}
		return nil
	case []any:
		for _, item := range v {
			if err := walkInput(item, texts, fileIDs); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		if typ, ok := v["type"].(string); ok {
			switch typ {
			case "input_text":
				return walkInputText(v, texts)
			case "input_file":
				return walkInputFile(v, fileIDs)
			case "message":
				return walkInputMessage(v, texts, fileIDs)
			default:
				return fmt.Errorf("unsupported input item type %q", typ)
			}
		}
		allowed := map[string]bool{"role": true, "content": true, "text": true, "file_id": true, "file_ids": true}
		for key := range v {
			if !allowed[key] {
				return fmt.Errorf("unsupported input field %q", key)
			}
		}
		if content, ok := v["content"]; ok {
			if err := walkInput(content, texts, fileIDs); err != nil {
				return err
			}
		}
		if text, ok := v["text"].(string); ok && text != "" {
			*texts = append(*texts, text)
		}
		if ids, ok := v["file_ids"].([]any); ok {
			for _, raw := range ids {
				if id, ok := raw.(string); ok && id != "" {
					*fileIDs = append(*fileIDs, id)
				}
			}
		}
		if id, ok := v["file_id"].(string); ok && id != "" {
			*fileIDs = append(*fileIDs, id)
		}
		return nil
	case nil:
		return nil
	default:
		return fmt.Errorf("unsupported input value")
	}
}

func walkInputText(v map[string]any, texts *[]string) error {
	for key := range v {
		if key != "type" && key != "text" {
			return fmt.Errorf("unsupported input_text field %q", key)
		}
	}
	text, ok := v["text"].(string)
	if !ok {
		return fmt.Errorf("input_text.text must be a string")
	}
	if text != "" {
		*texts = append(*texts, text)
	}
	return nil
}

func walkInputMessage(v map[string]any, texts *[]string, fileIDs *[]string) error {
	allowed := map[string]bool{"type": true, "role": true, "content": true, "id": true, "status": true}
	for key := range v {
		if !allowed[key] {
			return fmt.Errorf("unsupported message field %q", key)
		}
	}
	if content, ok := v["content"]; ok {
		return walkInput(content, texts, fileIDs)
	}
	return nil
}

func walkInputFile(v map[string]any, fileIDs *[]string) error {
	for key := range v {
		if key != "type" && key != "file_id" {
			return fmt.Errorf("unsupported input_file field %q", key)
		}
	}
	id, ok := v["file_id"].(string)
	if !ok || id == "" {
		return fmt.Errorf("input_file.file_id must be a non-empty string")
	}
	*fileIDs = append(*fileIDs, id)
	return nil
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if !seen[value] {
			out = append(out, value)
			seen[value] = true
		}
	}
	return out
}

func fileIDFromContentPath(raw string) (string, bool) {
	const prefix = "/v1/files/"
	const suffix = "/content"
	if !strings.HasPrefix(raw, prefix) || !strings.HasSuffix(raw, suffix) {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(raw, prefix), suffix)
	return strings.Trim(id, "/"), id != ""
}

func contentTypeFromHeader(header *multipart.FileHeader) string {
	if header == nil {
		return "application/octet-stream"
	}
	if values := header.Header.Values("Content-Type"); len(values) > 0 && values[0] != "" {
		return values[0]
	}
	return "application/octet-stream"
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
