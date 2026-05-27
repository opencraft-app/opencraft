package wrapper

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func TestParseWorkspaceFileDownloadCommandResponsePlainJSON(t *testing.T) {
	want := []byte{0x00, 0x01, 0x02, 0xff}
	stdout := "timeline noise\n" + `{"ok":true,"content_b64":"` + base64.StdEncoding.EncodeToString(want) + `"}` + "\n"
	got, err := parseWorkspaceFileDownloadCommandResponse(stdout)
	if err != nil {
		t.Fatalf("parse plain response: %v", err)
	}
	if !got.OK || got.ContentB64 != base64.StdEncoding.EncodeToString(want) {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestParseWorkspaceFileDownloadCommandResponseChunkedJSON(t *testing.T) {
	want := []byte{0x00, 0x01, 0x02, 0x7f, 0x80, 0xff}
	body := `{"ok":true,"content_b64":"` + base64.StdEncoding.EncodeToString(want) + `"}`
	stdout := "timeline noise\n" + chunkedText(body, 5, 7, 3, 11) + "\n"
	got, err := parseWorkspaceFileDownloadCommandResponse(stdout)
	if err != nil {
		t.Fatalf("parse chunked response: %v stdout=%q", err, stdout)
	}
	if !got.OK || got.ContentB64 != base64.StdEncoding.EncodeToString(want) {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func chunkedText(body string, sizes ...int) string {
	var out strings.Builder
	for len(body) > 0 {
		size := len(body)
		if len(sizes) > 0 {
			size = sizes[0]
			sizes = sizes[1:]
			if size > len(body) {
				size = len(body)
			}
		}
		out.WriteString(fmt.Sprintf("%x\r\n", size))
		out.WriteString(body[:size])
		out.WriteString("\r\n")
		body = body[size:]
	}
	out.WriteString("0\r\n\r\n")
	return out.String()
}

func TestWispRuntimeRootfsHostPathMapsRuntimePath(t *testing.T) {
	got, err := wispRuntimeRootfsHostPath("agent-session_abc", "/tmp/gateway/sessions/s1/upload.bin")
	if err != nil {
		t.Fatal(err)
	}
	want := "/var/lib/wisp-runtime/agent-session_abc/rootfs/tmp/gateway/sessions/s1/upload.bin"
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestWispRuntimeRootfsHostPathRejectsUnsafeName(t *testing.T) {
	if _, err := wispRuntimeRootfsHostPath("../bad", "/tmp/file"); err == nil {
		t.Fatal("expected invalid wisp runtime name")
	}
}
