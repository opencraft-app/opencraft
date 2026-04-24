package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShellEnvironmentOmitsInheritedSecrets(t *testing.T) {
	t.Setenv("PATH", "/usr/local/bin:/usr/bin:/bin")
	t.Setenv("HOME", "/root")
	t.Setenv("HOSTNAME", "nextgen-dashboard-test")
	t.Setenv("NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN", "root:secret@tcp(10.0.0.1:3306)/auth")
	t.Setenv("NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN", "root:secret@tcp(10.0.0.2:3306)/sandbox")

	req := httptest.NewRequest("GET", "http://runner/ws/shell", nil)
	req.Header.Set("X-Nextgen-Proxy-URL", "http://127.0.0.1:8084/admin/api/commands/proxy")
	req.Header.Set("X-Nextgen-Proxy-Token", "proxy-token")
	req.Header.Set("X-Nextgen-Proxy-Username", "skipzhang")

	env := shellEnvironment("/bin/bash", req)
	joined := "\n" + strings.Join(env, "\n") + "\n"

	if strings.Contains(joined, "NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN=") {
		t.Fatal("shell environment leaked auth mysql dsn")
	}
	if strings.Contains(joined, "NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN=") {
		t.Fatal("shell environment leaked sandbox mysql dsn")
	}
	if !strings.Contains(joined, "\nNEXTGEN_PROXY_TOKEN=proxy-token\n") {
		t.Fatal("shell environment missing proxy token")
	}
	if !strings.Contains(joined, "\nPATH=/usr/local/bin:/usr/bin:/bin\n") {
		t.Fatal("shell environment missing path")
	}
}
