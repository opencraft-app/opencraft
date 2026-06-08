package rescue

import (
	"context"
	"os"
	"path/filepath"
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
