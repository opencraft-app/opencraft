package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttachmentUploadUsesOfficialReceiptText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		switch request.URL.Path {
		case "/internal/agent-api/resolve-channel":
			_, _ = response.Write([]byte(`{"channelId":"channel-1"}`))
		case "/internal/agent-api/upload":
			_, _ = response.Write([]byte(`{
				"id":"attachment11111111",
				"filename":"artifact.txt",
				"mimeType":"text/plain",
				"sizeBytes":1536,
				"thumbnailUrl":null
			}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "artifact.txt")
	if err := os.WriteFile(path, []byte("attachment body"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, stdout, stderr := newAgentCLITestApp(t, server.URL, strings.NewReader(""))
	if exitCode := app.Run(context.Background(), []string{
		"attachment", "upload",
		"--path", path,
		"--target", "#general",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const expected = "File uploaded: artifact.txt (1.5KB)\n" +
		"Attachment ID: attachment11111111\n\n" +
		"Use this ID with vela message send --attachment-id " +
		"attachment11111111 to include it in a message.\n"
	if stdout.String() != expected {
		t.Fatalf("stdout = %q, want %q", stdout.String(), expected)
	}
}
