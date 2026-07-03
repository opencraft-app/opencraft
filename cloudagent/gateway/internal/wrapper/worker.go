package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Worker interface {
	Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error)
	FetchArtifact(ctx context.Context, job workerJob, artifact artifactDescriptor) ([]byte, error)
}

type FakeWorker struct {
	ExpectedVersion     string
	OutputText          string
	ArtifactContent     []byte
	OmitEventVersion    bool
	OmitResultVersion   bool
	OmitArtifactVersion bool
	BadArtifactChecksum bool
	BadArtifactSize     bool
}

func (w FakeWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	expected := w.ExpectedVersion
	if expected == "" {
		expected = WorkerContractVersion
	}
	if job.WorkerContractVersion != expected {
		return workerResult{}, workerError("worker_contract_version_mismatch", "worker contract version mismatch")
	}
	output := w.OutputText
	if output == "" {
		output = "Python 3.12.11"
	}
	parts := splitDeltas(output)
	for i, part := range parts {
		select {
		case <-ctx.Done():
			return workerResult{}, ctx.Err()
		default:
		}
		eventVersion := expected
		if w.OmitEventVersion {
			eventVersion = ""
		}
		if err := emit(workerEvent{
			WorkerContractVersion: eventVersion,
			EventID:               fmt.Sprintf("evt_%d", i+1),
			JobID:                 job.JobID,
			Sequence:              int64(i + 1),
			Kind:                  "output_text_delta",
			Timestamp:             time.Now().UTC().Unix(),
			Delta:                 part,
		}); err != nil {
			return workerResult{}, err
		}
	}
	artifactContent := w.ArtifactContent
	if artifactContent == nil {
		artifactContent = []byte(output + "\n")
	}
	sum := sha256.Sum256(artifactContent)
	handle := filepath.Join(os.TempDir(), "fake-worker-"+randomHex(8)+".artifact")
	if err := os.WriteFile(handle, artifactContent, 0o600); err != nil {
		return workerResult{}, err
	}
	resultVersion := expected
	if w.OmitResultVersion {
		resultVersion = ""
	}
	artifactVersion := expected
	if w.OmitArtifactVersion {
		artifactVersion = ""
	}
	checksum := hex.EncodeToString(sum[:])
	if w.BadArtifactChecksum {
		checksum = strings.Repeat("0", 64)
	}
	size := int64(len(artifactContent))
	if w.BadArtifactSize {
		size++
	}
	return workerResult{
		WorkerContractVersion: resultVersion,
		JobID:                 job.JobID,
		Status:                "completed",
		OutputText:            output,
		Artifacts: []artifactDescriptor{
			{
				WorkerContractVersion: artifactVersion,
				LogicalFilename:       "result.txt",
				ContentType:           "text/plain; charset=utf-8",
				RetrievalHandle:       handle,
				ChecksumSHA256:        checksum,
				SizeBytes:             size,
				Provenance: map[string]string{
					"worker": "fake",
				},
			},
		},
	}, nil
}

func (w FakeWorker) FetchArtifact(ctx context.Context, job workerJob, artifact artifactDescriptor) ([]byte, error) {
	if artifact.RetrievalHandle == "" {
		return nil, workerError("artifact_descriptor_invalid", "artifact retrieval handle is required")
	}
	return os.ReadFile(artifact.RetrievalHandle)
}

func splitDeltas(text string) []string {
	if text == "" {
		return nil
	}
	words := strings.Split(text, " ")
	if len(words) == 1 {
		return []string{text}
	}
	out := make([]string, 0, len(words))
	for i, word := range words {
		if i == 0 {
			out = append(out, word)
		} else {
			out = append(out, " "+word)
		}
	}
	return out
}

func workerError(code, message string) error {
	return &workerFailure{code: code, message: message}
}

func workerStop(code, message, stopReason string) error {
	return &workerFailure{code: code, message: message, stopReason: stopReason}
}

type workerFailure struct {
	code       string
	message    string
	stopReason string
}

func (e *workerFailure) Error() string {
	return e.message
}

func apiErrorFromWorker(err error) *APIError {
	var failure *workerFailure
	if errors.As(err, &failure) {
		return apiErr(failure.code, failure.message)
	}
	return apiErr("worker_failed", err.Error())
}

func workerFailureIsTurnScoped(err error) bool {
	var failure *workerFailure
	if !errors.As(err, &failure) {
		return false
	}
	switch failure.code {
	case "provider_error", "tool_call_validation_error", "invalid_tool_arguments":
		return true
	default:
		return false
	}
}
