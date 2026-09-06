package rescue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSCPArchiveReturnsSignedDownloadURLForCOSArchive(t *testing.T) {
	req := ExportRequest{CommandTransport: "tat"}
	archive := PreparedArchive{
		ObjectURL:   "https://bucket.cos.ap-beijing.myqcloud.com/rescue/a.tar.gz",
		DownloadURL: "https://bucket.cos.ap-beijing.myqcloud.com/rescue/a.tar.gz?q-signature=abc",
	}
	result, err := (Activities{}).SCPArchive(context.Background(), req, TencentConfig{}, InstanceInfo{}, archive)
	if err != nil {
		t.Fatal(err)
	}
	if result.LocalPath != archive.ObjectURL {
		t.Fatalf("LocalPath should keep object URL, got %s", result.LocalPath)
	}
	if result.OutputURL != archive.DownloadURL {
		t.Fatalf("OutputURL should be signed download URL, got %s", result.OutputURL)
	}
}

func TestPrepareMultipartArchiveDryRunReturnsSanitizedState(t *testing.T) {
	prepared, err := (Activities{}).PrepareMultipartArchive(context.Background(), ExportRequest{
		InstanceID:            "ins-test",
		ArchiveMode:           ArchiveModeHermes,
		COSUploadBucket:       "https://bucket-123.cos.ap-beijing.myqcloud.com",
		COSUploadRegion:       "ap-beijing",
		CommandTimeoutSeconds: 1800,
	}, TencentConfig{}, "ap-beijing")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(prepared)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(payload)
	for _, forbidden := range []string{"TmpSecret", "SessionToken", "tmp_secret", "session_token"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("activity result contains %q: %s", forbidden, serialized)
		}
	}
	if prepared.UploadID == "" {
		t.Fatalf("missing sanitized multipart identifier: %+v", prepared)
	}
}

func TestBuildRescueUploaderUsesConfiguredPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rescue-uploader")
	if err := os.WriteFile(path, []byte("test-uploader"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RESCUE_UPLOADER_PATH", path)

	got, err := buildRescueUploader()
	if err != nil {
		t.Fatal(err)
	}
	if got != path {
		t.Fatalf("buildRescueUploader() = %q, want %q", got, path)
	}
}
