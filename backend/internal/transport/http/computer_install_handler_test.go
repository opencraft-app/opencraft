package httptransport

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestComputerInstallHandlerStreamsShortCodeOnlyThroughRequestBody(t *testing.T) {
	handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL: "https://computer.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/install", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK ||
		recorder.Header().Get("Content-Type") != "text/x-shellscript; charset=utf-8" ||
		recorder.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("response = %d %#v", recorder.Code, recorder.Header())
	}
	script := recorder.Body.String()
	for _, required := range []string{
		`code=${1-}`,
		`tmp_root=${TMPDIR:-/tmp}`,
		`tmp_root=${tmp_root%/}`,
		`printf '%s' "$code" |`,
		`--data-binary @-`,
		`https://computer.example.com/v1/computer/setup-codes:redeem`,
		`--output "$d/setup.sh"`,
		`/bin/sh "$d/setup.sh"`,
		`trap '/bin/rm -rf "$d"' 0 HUP INT TERM`,
	} {
		if !strings.Contains(script, required) {
			t.Errorf("bootstrap 缺少 %q：\n%s", required, script)
		}
	}
	for _, forbidden := range []string{
		`>"$d/code"`, `--header "Authorization:`, `?code=`, `CODE=`, `cen1.`,
		`trap '/bin/rm -rf "$d"' EXIT HUP INT TERM`,
	} {
		if strings.Contains(script, forbidden) {
			t.Errorf("bootstrap 含有短码落盘/外泄形态 %q：\n%s", forbidden, script)
		}
	}
}

func TestComputerInstallBootstrapMapsRedemptionFailuresWithoutLeakingCode(t *testing.T) {
	const setupCode = "TEST-CODE-ONLY-0001"
	const unsafeBody = "/usr/bin/printf 'unsafe response executed\\n'"
	const invalidMessage = "Computer setup code is invalid, expired, or already used. Generate a new setup code and try again.\n"
	const unexpectedMessage = "Computer setup service returned an unexpected response. Try again later.\n"

	for _, test := range []struct {
		name       string
		status     int
		wantStderr string
	}{
		{name: "invalid code", status: http.StatusUnauthorized, wantStderr: invalidMessage},
		{name: "unexpected response", status: http.StatusServiceUnavailable, wantStderr: unexpectedMessage},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodPost ||
					request.URL.Path != "/v1/computer/setup-codes:redeem" ||
					request.URL.RawQuery != "" {
					t.Errorf("request = %s %s", request.Method, request.URL.String())
				}
				for name, values := range request.Header {
					if strings.Contains(strings.Join(values, "\x00"), setupCode) {
						t.Errorf("setup code leaked through header %s", name)
					}
				}
				body, err := io.ReadAll(request.Body)
				if err != nil || string(body) != setupCode {
					t.Errorf("request body = %q, err = %v", body, err)
				}
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, unsafeBody)
			}))
			defer server.Close()

			handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
				BaseURL: server.URL, AllowInsecureHTTP: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			exitCode, stdout, stderr := runComputerInstallBootstrap(t, handler.script(), setupCode)
			if exitCode == 0 || stdout != "" || stderr != test.wantStderr {
				t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout, stderr)
			}
			for _, forbidden := range []string{setupCode, unsafeBody, "curl:", server.URL} {
				if strings.Contains(stdout+stderr, forbidden) {
					t.Fatalf("bootstrap failure leaked %q: %q", forbidden, stdout+stderr)
				}
			}
		})
	}
}

func TestComputerInstallBootstrapReportsTransportFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	baseURL := server.URL
	server.Close()
	handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL: baseURL, AllowInsecureHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	exitCode, stdout, stderr := runComputerInstallBootstrap(t, handler.script(), "TEST-CODE-ONLY-0002")
	const want = "Unable to contact the Computer setup service. Check your network and try again.\n"
	if exitCode == 0 || stdout != "" || stderr != want {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout, stderr)
	}
}

func TestComputerInstallBootstrapDetectsLinuxBeforeRedeemingCode(t *testing.T) {
	const setupCode = "TEST-CODE-ONLY-0003"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Vela-Computer-Target") != "linux-amd64" {
			t.Errorf("target header = %q", request.Header.Get("X-Vela-Computer-Target"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil || string(body) != setupCode {
			t.Errorf("request body = %q err=%v", body, err)
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "#!/bin/sh\nexit 0\n")
	}))
	defer server.Close()

	handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL: server.URL, AllowInsecureHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	handler.commands = computerInstallCommands{
		Uname: writeInstallTestCommand(t, root, "uname", `
case "$1" in
  -s) printf '%s\n' Linux ;;
  -m) printf '%s\n' x86_64 ;;
  *) exit 2 ;;
esac
`),
		ID:                      writeInstallTestCommand(t, root, "id", `[ "$1" = -u ] && printf '%s\n' 0`),
		Systemctl:               writeInstallTestCommand(t, root, "systemctl", `exit 0`),
		SystemdRuntimeDirectory: filepath.Join(root, "systemd"),
	}
	if err := os.Mkdir(handler.commands.SystemdRuntimeDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	exitCode, stdout, stderr := runComputerInstallBootstrap(t, handler.script(), setupCode)
	if exitCode != 0 || stdout != "" || stderr != "" || requests != 1 {
		t.Fatalf("exit=%d stdout=%q stderr=%q requests=%d", exitCode, stdout, stderr, requests)
	}
}

func writeInstallTestCommand(t *testing.T, root string, name string, body string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func runComputerInstallBootstrap(t *testing.T, script string, setupCode string) (int, string, string) {
	t.Helper()
	command := exec.Command("/bin/sh", "-c", script, "computer-bootstrap", setupCode)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	if err == nil {
		return 0, stdout.String(), stderr.String()
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("bootstrap execution failed: %v", err)
	}
	return exitError.ExitCode(), stdout.String(), stderr.String()
}

func TestComputerInstallBootstrapReportsMissingSetupCodeInEnglish(t *testing.T) {
	handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL: "https://computer.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	const message = "Missing the 16-character Computer setup code."
	script := handler.script()
	if strings.Count(script, message) != 1 || strings.Contains(script, "缺少 16 位 Computer 安装码") {
		t.Fatalf("bootstrap missing-code prompt is not the single exact English message:\n%s", script)
	}

	command := exec.Command("/bin/sh", "-c", script)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err = command.Run()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != 2 {
		t.Fatalf("missing-code exit = %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("missing-code stdout = %q", stdout.String())
	}
	if stderr.String() != message+"\n" {
		t.Fatalf("missing-code stderr = %q", stderr.String())
	}
}

func TestComputerInstallHandlerRejectsInvalidPublicURL(t *testing.T) {
	for _, value := range []string{
		"", "http://example.com", "https://user@example.com",
		"https://example.com/path", "https://example.com/path?x=1",
	} {
		if _, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{BaseURL: value}); err == nil {
			t.Fatalf("NewComputerInstallHandler(%q) unexpectedly succeeded", value)
		}
	}
}

func TestComputerInstallHandlerAllowsExplicitHTTPWithoutRedirects(t *testing.T) {
	handler, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL:           "http://9.135.236.64/",
		AllowInsecureHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	script := handler.script()
	for _, required := range []string{
		"http://9.135.236.64/v1/computer/setup-codes:redeem",
		"--proto '=http'",
		"--proto-redir '=https'",
		"--max-redirs 0",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("HTTP bootstrap missing %q:\n%s", required, script)
		}
	}
	if strings.Contains(script, "--proto '=https'") {
		t.Fatalf("HTTP bootstrap still requires HTTPS:\n%s", script)
	}
}

func TestComputerInstallHandlerRejectsUnusedHTTPOptIn(t *testing.T) {
	if _, err := NewComputerInstallHandler(ComputerInstallHandlerConfig{
		BaseURL:           "https://computer.example.com",
		AllowInsecureHTTP: true,
	}); err == nil {
		t.Fatal("HTTPS install origin accepted an unused insecure HTTP opt-in")
	}
}
