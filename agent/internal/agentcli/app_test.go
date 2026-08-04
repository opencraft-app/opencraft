package agentcli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
)

func TestOfficialCommandTopologyEvidenceIsPinned(t *testing.T) {
	t.Parallel()

	manifestPath := filepath.Join(
		"..", "..", "docs", "legacy", "raft-1.0.13", "agent-cli-evidence.json",
	)
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema   string `json:"schema"`
		Baseline struct {
			Version string `json:"version"`
		} `json:"baseline"`
		Source struct {
			Path              string `json:"path"`
			SHA256            string `json:"sha256"`
			DefinitionsStart  int    `json:"definitionsStartLine"`
			DefinitionsEnd    int    `json:"definitionsEndLine"`
			RegistrationStart int    `json:"registrationStartLine"`
			RegistrationEnd   int    `json:"registrationEndLine"`
		} `json:"source"`
		Families []struct {
			Name     string   `json:"name"`
			Commands []string `json:"commands"`
		} `json:"families"`
	}
	if err := common.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Schema != "raft-computer-go.agent-cli-evidence.v1" ||
		manifest.Baseline.Version != "1.0.13" ||
		manifest.Source.DefinitionsStart != 52513 ||
		manifest.Source.DefinitionsEnd != 55635 ||
		manifest.Source.RegistrationStart != 55658 ||
		manifest.Source.RegistrationEnd != 55733 {
		t.Fatalf("Agent CLI evidence metadata = %#v", manifest)
	}
	pinnedDigest, err := hex.DecodeString(manifest.Source.SHA256)
	if err != nil || len(pinnedDigest) != sha256.Size {
		t.Fatalf("Agent CLI source sha256 is not a valid SHA-256 digest: %q", manifest.Source.SHA256)
	}
	source, err := os.ReadFile(filepath.Join(
		filepath.Dir(manifestPath),
		manifest.Source.Path,
	))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err == nil {
		digest := sha256.Sum256(source)
		if actual := hex.EncodeToString(digest[:]); actual != manifest.Source.SHA256 {
			t.Fatalf("Agent CLI source sha256 = %s, want %s", actual, manifest.Source.SHA256)
		}
	}
	expected := map[string][]string{
		"auth":        {"whoami"},
		"agent":       {"list", "login", "login start", "login wait", "login status", "bridge"},
		"channel":     {"info", "members", "create", "update", "archive", "unarchive", "add-member", "remove-member", "join", "leave", "mute", "unmute"},
		"thread":      {"unfollow"},
		"server":      {"info", "update"},
		"user":        {"info"},
		"manual":      {"get", "search"},
		"knowledge":   {"get", "search"},
		"inbox":       {"check"},
		"message":     {"send", "check", "read", "search", "resolve", "react"},
		"attachment":  {"upload", "view", "comments"},
		"task":        {"list", "create", "claim", "unclaim", "update"},
		"mention":     {"pending", "notify", "add"},
		"profile":     {"show", "update"},
		"integration": {"list", "login", "env", "invoke", "app prepare register", "app prepare recover-owner", "app rotate-secret", "app transfer-owner", "app update", "app list", "app status"},
		"reminder":    {"schedule", "list", "cancel", "snooze", "update", "log"},
		"migrate":     {"export", "import", "status", "ready", "arrived"},
		"action":      {"prepare"},
	}
	if len(manifest.Families) != len(expected) {
		t.Fatalf("Agent CLI families = %d, want %d", len(manifest.Families), len(expected))
	}
	seen := make(map[string]bool, len(manifest.Families))
	for _, family := range manifest.Families {
		want, ok := expected[family.Name]
		if !ok || seen[family.Name] || !sameCommandPaths(family.Commands, want) {
			t.Fatalf("Agent CLI family evidence = %#v, want %v", family, want)
		}
		seen[family.Name] = true
	}
}

func sameCommandPaths(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestMessageSendBuildsTypedAgentAPICall(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/agent-api/send" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		var body struct {
			Target                string   `json:"target"`
			Content               string   `json:"content"`
			DraftReholdCount      *float64 `json:"draftReholdCount"`
			DraftReplacedExisting *bool    `json:"draftReplacedExisting"`
		}
		if err := common.DecodeJson(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Target != "#test" ||
			body.Content != "hello" ||
			body.DraftReholdCount != nil ||
			body.DraftReplacedExisting != nil {
			t.Fatalf("body = %#v", body)
		}
		_, _ = response.Write([]byte(`{
			"ok":true,
			"state":"sent",
			"messageId":"message-test"
		}`))
	}))
	defer server.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := agentapi.New(agentapi.ClientOptions{BaseURL: server.URL, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := New(Options{Client: client, Stdout: &stdout, Stderr: &stderr})
	if exitCode := app.Run(context.Background(), []string{
		"message", "send", "--target", "#test", "--text", "hello", "--json",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr=%s", exitCode, stderr.String())
	}
	var output struct {
		State string `json:"state"`
	}
	if err := common.UnmarshalJsonStr(stdout.String(), &output); err != nil {
		t.Fatal(err)
	}
	if output.State != "sent" {
		t.Fatalf("output = %#v", output)
	}
}

func TestMessageSendRequestRejectsRemovedContentForms(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		args []string
	}{
		{
			name: "object valued json",
			args: []string{
				"--target", "#all",
				"--json", `{"content":"legacy"}`,
			},
		},
		{
			name: "positional content",
			args: []string{"--target", "#all", "legacy"},
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := messageSendRequest(test.args, nil); err == nil {
				t.Fatal("removed content form was accepted")
			}
		})
	}
}

func TestMessageSendHelpDoesNotRequireAgentAPI(t *testing.T) {
	t.Parallel()

	for _, flag := range []string{"--help", "-h"} {
		flag := flag
		t.Run(flag, func(t *testing.T) {
			t.Parallel()
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			app := New(Options{Stdout: &stdout, Stderr: &stderr})
			if exitCode := app.Run(
				context.Background(),
				[]string{"message", "send", flag},
			); exitCode != 0 {
				t.Fatalf(
					"exit code = %d, stdout=%q stderr=%q",
					exitCode,
					stdout.String(),
					stderr.String(),
				)
			}
			if !strings.Contains(
				stdout.String(),
				"--text string",
			) {
				t.Fatalf("stdout = %q", stdout.String())
			}
			if strings.Contains(stdout.String(), `--json '{"target"`) {
				t.Fatalf("help advertises removed object-valued --json: %q", stdout.String())
			}
		})
	}
}

func TestMessageSendMissingTargetSuggestsCanonicalRecovery(t *testing.T) {
	t.Parallel()

	_, err := messageSendRequest([]string{"--text", "hello"}, nil)
	if err == nil || !strings.Contains(
		err.Error(),
		"raft message send --target <target>",
	) {
		t.Fatalf("error = %v", err)
	}
}

func TestMessageSendCompatibilityErrorsExitTwo(t *testing.T) {
	t.Parallel()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   "http://127.0.0.1:1",
		TokenFile: tokenFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		args     []string
		exitCode int
	}{
		{
			name:     "malformed legacy object",
			args:     []string{"message", "send", "--json", `{"content":`},
			exitCode: 2,
		},
		{
			name: "help takes precedence over send arguments",
			args: []string{
				"message", "send", "--help",
				"--target", "#all", "--text", "hello",
			},
			exitCode: 0,
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var stderr bytes.Buffer
			app := New(Options{Client: client, Stderr: &stderr})
			if exitCode := app.Run(context.Background(), test.args); exitCode != test.exitCode {
				t.Fatalf(
					"exit code = %d, want %d, stderr=%q",
					exitCode,
					test.exitCode,
					stderr.String(),
				)
			}
		})
	}
}

func TestAttachmentUploadResolvesTargetAndStreamsMultipart(t *testing.T) {
	t.Parallel()

	var resolved atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/agent-api/resolve-channel":
			var body map[string]string
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Error(err)
				return
			}
			if body["target"] != "#test" {
				t.Errorf("resolve body = %#v", body)
			}
			resolved.Store(true)
			_, _ = response.Write([]byte(`{"channelId":"channel-test"}`))
		case "/internal/agent-api/upload":
			if !resolved.Load() {
				t.Error("upload arrived before channel resolution")
			}
			if err := request.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return
			}
			if request.FormValue("channelId") != "channel-test" ||
				request.FormValue("target") != "#test" ||
				request.FormValue("mimeType") != "text/plain" {
				t.Errorf("multipart fields = %#v", request.MultipartForm.Value)
			}
			file, header, err := request.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			data := new(bytes.Buffer)
			if _, err := data.ReadFrom(file); err != nil {
				t.Error(err)
				return
			}
			if header.Filename != "note.txt" || data.String() != "attachment body" {
				t.Errorf("multipart file = %q %q", header.Filename, data.String())
			}
			_, _ = response.Write([]byte(`{
				"id":"attachment-test",
				"filename":"note.txt",
				"mimeType":"text/plain",
				"sizeBytes":15,
				"thumbnailUrl":null
			}`))
		default:
			t.Errorf("unexpected path %q", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	attachmentPath := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(attachmentPath, []byte("attachment body"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := agentapi.New(agentapi.ClientOptions{BaseURL: server.URL, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := New(Options{Client: client, Stdout: &stdout, Stderr: &stderr})
	if exitCode := app.Run(context.Background(), []string{
		"attachment", "upload",
		"--path", attachmentPath,
		"--target", "#test",
		"--mime-type", "text/plain",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr=%s", exitCode, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Attachment ID: attachment-test") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}
