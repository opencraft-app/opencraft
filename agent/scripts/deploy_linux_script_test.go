package scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLinuxDeployUploadsAndRequestsChecksumVerifiedInstall(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve deploy script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "deploy-linux.sh")
	root := t.TempDir()
	source := filepath.Join(root, "raft-computer-go-linux-amd64")
	if err := os.WriteFile(source, []byte("linux fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	fakeBin := filepath.Join(root, "bin")
	if err := os.Mkdir(fakeBin, 0o700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "calls.log")
	for _, name := range []string{"scp", "ssh"} {
		body := "#!/bin/sh\n" +
			"printf '%s' " + name + " >> \"$DEPLOY_TEST_LOG\"\n" +
			"for arg in \"$@\"; do printf ' <%s>' \"$arg\" >> \"$DEPLOY_TEST_LOG\"; done\n" +
			"printf '\\n' >> \"$DEPLOY_TEST_LOG\"\n" +
			"if [ '" + name + "' = ssh ]; then cat >> \"$DEPLOY_TEST_LOG\"; fi\n"
		if err := os.WriteFile(
			filepath.Join(fakeBin, name),
			[]byte(body),
			0o700,
		); err != nil {
			t.Fatal(err)
		}
	}

	command := exec.Command(
		"sh",
		script,
		"--host",
		"root@example.test",
		"--source",
		source,
		"--destination",
		"/usr/local/bin/raft-computer-go",
	)
	command.Env = append(
		os.Environ(),
		"PATH="+fakeBin+":/usr/bin:/bin",
		"DEPLOY_TEST_LOG="+logPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("deploy: %v: %s", err, output)
	}
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(log)
	if !strings.Contains(
		text,
		"scp <"+source+"> <root@example.test:/usr/local/bin/raft-computer-go.upload.",
	) {
		t.Fatalf("missing scoped upload: %s", text)
	}
	if !strings.Contains(
		text,
		"ssh <root@example.test> <sh> <-s> <-->",
	) || !strings.Contains(text, "sha256sum") ||
		!strings.Contains(text, "mv \"$upload\" \"$destination\"") {
		t.Fatalf("missing verified remote install: %s", text)
	}
}

func TestLinuxDeployRejectsUnsafeDestinationBeforeSCP(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve deploy script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "deploy-linux.sh")
	source := filepath.Join(t.TempDir(), "raft-computer-go")
	if err := os.WriteFile(source, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(
		"sh",
		script,
		"--host",
		"root@example.test",
		"--source",
		source,
		"--destination",
		"../../unsafe",
	)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "unsafe destination") {
		t.Fatalf("unsafe destination result: err=%v output=%s", err, output)
	}
}
