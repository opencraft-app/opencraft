package wrapper

import (
	"encoding/json"
	"time"
)

const WorkerContractVersion = "2026-05-15.v1"

type Scope struct {
	TenantID     string `json:"tenant_id"`
	ProjectID    string `json:"project_id"`
	SandboxScope string `json:"sandbox_scope,omitempty"`
}

type FileRecord struct {
	ID               string    `json:"id"`
	Object           string    `json:"object"`
	Bytes            int64     `json:"bytes"`
	CreatedAt        int64     `json:"created_at"`
	Filename         string    `json:"filename"`
	Purpose          string    `json:"purpose"`
	ContentType      string    `json:"content_type"`
	SHA256           string    `json:"sha256"`
	Kind             string    `json:"kind"`
	SourceResponseID string    `json:"source_response_id,omitempty"`
	Scope            Scope     `json:"-"`
	ExpiresAt        time.Time `json:"-"`
	StoragePath      string    `json:"-"`
	StorageURI       string    `json:"-"`
}

type ResponseRecord struct {
	ID              string       `json:"id"`
	Object          string       `json:"object"`
	CreatedAt       int64        `json:"created_at"`
	Status          string       `json:"status"`
	Model           string       `json:"model,omitempty"`
	OutputText      string       `json:"output_text,omitempty"`
	Output          []OutputItem `json:"output,omitempty"`
	ArtifactFileIDs []string     `json:"artifact_file_ids,omitempty"`
	Error           *APIError    `json:"error,omitempty"`
	AuditSummary    []AuditEvent `json:"audit_summary,omitempty"`
	Scope           Scope        `json:"-"`
}

type OutputItem struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Status  string          `json:"status"`
	Role    string          `json:"role"`
	Content []OutputContent `json:"content"`
}

type OutputContent struct {
	Type        string `json:"type"`
	Text        string `json:"text"`
	Annotations []any  `json:"annotations"`
}

type AuditEvent struct {
	Type       string    `json:"type"`
	SubjectID  string    `json:"subject_id,omitempty"`
	ResponseID string    `json:"response_id,omitempty"`
	FileID     string    `json:"file_id,omitempty"`
	Scope      Scope     `json:"scope"`
	CreatedAt  time.Time `json:"created_at"`
	Detail     string    `json:"detail,omitempty"`
}

type APIError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

type createResponseRequest struct {
	Model              string `json:"model"`
	Input              any    `json:"input"`
	Instructions       string `json:"instructions"`
	Stream             bool   `json:"stream"`
	PreviousResponseID string `json:"previous_response_id,omitempty"`
}

type chatCompletionRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type listModelsResponse struct {
	Object string        `json:"object"`
	Data   []modelRecord `json:"data"`
}

type modelRecord struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type materializedFile struct {
	FileID        string `json:"file_id"`
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	Path          string `json:"path"`
	WorkspacePath string `json:"workspace_path,omitempty"`
}

type workerJob struct {
	WorkerContractVersion string             `json:"worker_contract_version"`
	JobID                 string             `json:"job_id"`
	ResponseID            string             `json:"response_id"`
	Model                 string             `json:"model,omitempty"`
	Scope                 Scope              `json:"scope"`
	CWD                   string             `json:"cwd,omitempty"`
	Instruction           string             `json:"instruction"`
	InputFiles            []materializedFile `json:"input_files"`
	TimeoutSeconds        int                `json:"timeout_seconds"`
	CorrelationID         string             `json:"correlation_id"`
	ACPSessionID          string             `json:"acp_session_id,omitempty"`
	ACPSessionGeneration  int64              `json:"acp_session_generation,omitempty"`
	ACPSessionRuntime     ACPSessionRuntime  `json:"-"`
}

type workerEvent struct {
	WorkerContractVersion string          `json:"worker_contract_version"`
	EventID               string          `json:"event_id"`
	JobID                 string          `json:"job_id"`
	Sequence              int64           `json:"sequence"`
	Kind                  string          `json:"kind"`
	Timestamp             int64           `json:"timestamp"`
	Delta                 string          `json:"delta,omitempty"`
	Message               string          `json:"message,omitempty"`
	ToolCallID            string          `json:"tool_call_id,omitempty"`
	ToolName              string          `json:"tool_name,omitempty"`
	ToolStatus            string          `json:"tool_status,omitempty"`
	ToolError             string          `json:"tool_error,omitempty"`
	ToolContent           string          `json:"tool_content,omitempty"`
	ToolRawInput          json.RawMessage `json:"tool_raw_input,omitempty"`
	ToolRawOutput         json.RawMessage `json:"tool_raw_output,omitempty"`
}

type artifactDescriptor struct {
	WorkerContractVersion string            `json:"worker_contract_version"`
	LogicalFilename       string            `json:"logical_filename"`
	ContentType           string            `json:"content_type"`
	RetrievalHandle       string            `json:"retrieval_handle"`
	ChecksumSHA256        string            `json:"checksum_sha256,omitempty"`
	SizeBytes             int64             `json:"size_bytes,omitempty"`
	Provenance            map[string]string `json:"provenance,omitempty"`
}

type workerResult struct {
	WorkerContractVersion string                  `json:"worker_contract_version"`
	JobID                 string                  `json:"job_id"`
	Status                string                  `json:"status"`
	OutputText            string                  `json:"output_text"`
	Artifacts             []artifactDescriptor    `json:"artifacts,omitempty"`
	AdvisoryLog           []string                `json:"advisory_log,omitempty"`
	RuntimeUpdate         ACPSessionRuntimeUpdate `json:"-"`
}
