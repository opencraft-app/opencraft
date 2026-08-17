package cli

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestComputerUpdateCLIStartsIndependentServiceAndStopsWithContext(t *testing.T) {
	root := t.TempDir()
	releaseRoot := filepath.Join(root, "releases")
	if err := os.Mkdir(releaseRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	releasePublicKey := filepath.Join(root, "release.public")
	channelPrivateKey := filepath.Join(root, "channel.private")
	if err := os.WriteFile(
		releasePublicKey,
		[]byte(base64.RawStdEncoding.EncodeToString(publicKey)+"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		channelPrivateKey,
		[]byte(base64.RawStdEncoding.EncodeToString(privateKey)+"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	secretID := writeTextSecret(t, root, "cos-secret-id", "test-secret-id-000000000000", 0o600)
	secretKey := writeTextSecret(t, root, "cos-secret-key", "test-secret-key-00000000000", 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdout := newSignalBuffer("Computer Update 已启动")
	var stderr bytes.Buffer
	result := make(chan int, 1)
	go func() {
		result <- Run(ctx, []string{
			"computer-update", "serve",
			"--listen", "127.0.0.1:0",
			"--state-dir", filepath.Join(root, "state"),
			"--release-root", releaseRoot,
			"--release-public-key-file", releasePublicKey,
			"--channel-key-id", "channel-key-2026-08",
			"--channel-private-key-file", channelPrivateKey,
			"--host", "updates.internal.example",
			"--origin", "https://updates.internal.example",
			"--trusted-proxy-cidr", "127.0.0.0/8",
			"--tencent-cloud-secret-id-file", secretID,
			"--tencent-cloud-secret-key-file", secretKey,
			"--computer-artifact-bucket", "computer-test-1250000000",
			"--computer-artifact-region", "ap-beijing",
			"--url-ttl", "5m",
		}, stdout, &stderr)
	}()
	select {
	case <-stdout.signaled:
	case <-time.After(5 * time.Second):
		t.Fatalf("Computer Update CLI 未启动：stderr=%q", stderr.String())
	}
	cancel()
	code := <-result

	if code != 0 || !strings.Contains(stdout.String(), "Computer Update 已启动：http://127.0.0.1:") {
		t.Fatalf("computer-update serve code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	for _, secretPath := range []string{channelPrivateKey, secretID, secretKey} {
		if strings.Contains(stdout.String(), secretPath) || strings.Contains(stderr.String(), secretPath) {
			t.Fatalf("Computer Update CLI 泄漏 Secret 路径：stdout=%q stderr=%q", stdout.String(), stderr.String())
		}
	}
}
