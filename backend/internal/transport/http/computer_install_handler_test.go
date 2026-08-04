package httptransport

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os/exec"
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
	} {
		if !strings.Contains(script, required) {
			t.Errorf("bootstrap 缺少 %q：\n%s", required, script)
		}
	}
	for _, forbidden := range []string{
		`>"$d/code"`, `--header "Authorization:`, `?code=`, `CODE=`, `cen1.`,
	} {
		if strings.Contains(script, forbidden) {
			t.Errorf("bootstrap 含有短码落盘/外泄形态 %q：\n%s", forbidden, script)
		}
	}
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
