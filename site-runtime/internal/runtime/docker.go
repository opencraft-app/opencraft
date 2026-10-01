package runtime

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// DockerRunner deliberately has no native-process fallback. Production execution
// requires Linux Docker configured with runsc and a digest-pinned runtime image.
// The manager must run on a dedicated node: Docker access is a privileged boundary.
type DockerRunner struct{ image, owner, dataDir string }

var pinnedImage = regexp.MustCompile(`^([a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$`)

func NewDockerRunner(image, dataDir string) (*DockerRunner, error) {
	if !pinnedImage.MatchString(image) {
		return nil, fmt.Errorf("runtime image must be digest pinned")
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(abs))
	return &DockerRunner{image: image, owner: hex.EncodeToString(sum[:16]), dataDir: abs}, nil
}
func (d *DockerRunner) createArgs(name, bundle, socket string) ([]string, error) {
	for _, path := range []string{bundle, socket} {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, ",\r\n") {
			return nil, fmt.Errorf("unsafe mount path")
		}
	}
	return []string{"create", "--name", name, "--label", "lightvela.website-runtime=" + d.owner,
		"--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
		"--user=65532:65532", "--memory=128m", "--memory-swap=128m", "--cpus=1", "--pids-limit=64",
		"--ulimit=nofile=256:256", "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,size=16777216,mode=1777",
		"--mount", "type=bind,src=" + bundle + ",dst=/bundle,readonly",
		"--mount", "type=bind,src=" + socket + ",dst=/socket",
		d.image, "serve", "/bundle/runtime.capnp"}, nil
}
func dockerCommand(ctx context.Context, args ...string) ([]byte, error) {
	// Never return Docker output (it may include daemon details or user paths) to
	// public callers. Only fixed administrative operations use this function.
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker operation failed: %w", err)
	}
	return out, nil
}

// Reconcile removes only this store's labelled containers after a manager crash.
// The executable holds an exclusive local store lock before calling this method.
func (d *DockerRunner) Reconcile(ctx context.Context) error {
	out, err := dockerCommand(ctx, "ps", "-aq", "--filter", "label=lightvela.website-runtime="+d.owner)
	if err != nil {
		return err
	}
	for _, id := range strings.Fields(string(out)) {
		if !regexp.MustCompile(`^[a-f0-9]{12,64}$`).MatchString(id) {
			return fmt.Errorf("invalid container id")
		}
		if _, err := dockerCommand(ctx, "rm", "-f", "-v", id); err != nil {
			return err
		}
	}
	return reconcileStore(d.dataDir)
}
func (d *DockerRunner) Run(ctx context.Context, bundle string, in Invocation) (result Result, err error) {
	ctx, cancel := context.WithTimeout(ctx, ExecutionTimeout)
	defer cancel()
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return result, err
	}
	name := "lv-website-" + hex.EncodeToString(nonce)
	socket, err := os.MkdirTemp("", "lv-website-socket-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(socket)
	if err = os.Chmod(socket, 0777); err != nil {
		return result, err
	}
	args, err := d.createArgs(name, bundle, socket)
	if err != nil {
		return result, err
	}
	// Cleanup has its own deadline: a timed-out request must still kill execution.
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, cleanupErr := dockerCommand(cleanupCtx, "rm", "-f", "-v", name); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("runtime cleanup failed: %w", cleanupErr))
		}
	}()
	if _, err = dockerCommand(ctx, args...); err != nil {
		return result, err
	}
	if _, err = dockerCommand(ctx, "start", name); err != nil {
		return result, err
	}
	address := filepath.Join(socket, "http.sock")
	// Probe socket readiness without issuing the application request. Retrying an
	// actual POST could execute a mutation more than once.
	for {
		connection, dialErr := (&net.Dialer{}).DialContext(ctx, "unix", address)
		if dialErr == nil {
			_ = connection.Close()
			break
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", address)
	}, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 << 10}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, in.Method, "http://site.invalid"+in.Path, bytes.NewReader(in.Body))
	if err != nil {
		return result, err
	}
	for k, v := range allowedHeaders(in.Headers, false) {
		request.Header.Set(k, v)
	}
	response, err := client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return result, err
	}
	if len(body) > MaxResponseBytes {
		return result, fmt.Errorf("response too large")
	}
	return Result{Status: response.StatusCode, Headers: map[string]string{"Content-Type": response.Header.Get("Content-Type")}, Body: body}, nil
}
