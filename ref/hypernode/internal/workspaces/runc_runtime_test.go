package workspaces

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestRuncConfigurationMountsOnlyPrincipalAttachmentCapability(t *testing.T) {
	root := t.TempDir()
	agent := filepath.Join(root, "hypernode")
	policy := filepath.Join(root, "workspace-agent.js")
	if err := os.WriteFile(agent, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policy, []byte("policy"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(root, "runtime"), AgentBinary: agent, AgentPolicy: policy,
	})
	if err != nil {
		t.Fatal(err)
	}
	bundle := runcBundlePaths{
		bundle: "/run/hypernode/attachment", rootfs: "/private/btrfs/systems/workspace-id",
		workspace: "/private/btrfs/data/workspace-id", attachments: "/run/hypernode/attachment/attachments",
	}
	configuration := runtime.ociConfiguration(bundle, 1234, ModeReadWrite)
	encoded := string(mustJSON(configuration))
	for _, required := range []string{bundle.rootfs, bundle.workspace, bundle.attachments, "hypernode-fs@v1", "/etc/resolv.conf", "/etc/hosts"} {
		if !strings.Contains(encoded, required) {
			t.Fatalf("missing %s in %s", required, encoded)
		}
	}
	if strings.Contains(encoded, "hypernode-users") || strings.Contains(encoded, "UsersRoot") {
		t.Fatalf("runc configuration leaked the users root: %s", encoded)
	}
}

func TestRuncConfigurationExposesPrincipalCodexHomeAtWorkspaceAlias(t *testing.T) {
	root := t.TempDir()
	agent := filepath.Join(root, "hypernode")
	policy := filepath.Join(root, "workspace-agent.js")
	if err := os.WriteFile(agent, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policy, []byte("policy"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(root, "runtime"), AgentBinary: agent, AgentPolicy: policy,
	})
	if err != nil {
		t.Fatal(err)
	}
	principalHome := "/private/users/alice-stable"
	configuration := runtime.ociConfiguration(runcBundlePaths{
		bundle: "/run/hypernode/attachment", rootfs: "/private/btrfs/systems/workspace-id",
		workspace: "/private/btrfs/data/workspace-id", attachments: "/run/hypernode/attachment/attachments",
		principalHome: principalHome, principalUID: 20002, principalGID: 20002,
	}, 1234, ModeReadWrite)
	encoded := string(mustJSON(configuration))
	principalRuntimeHome := filepath.Join("/run/hypernode/attachment", "principal-home")
	for _, required := range []string{
		`"destination":"/workspace/.codex"`,
		`"source":"` + principalRuntimeHome + `/.codex"`,
		`"source":"` + principalRuntimeHome + `"`,
		`"destination":"/run/hypernode-users/alice-stable"`,
	} {
		if !strings.Contains(encoded, required) {
			t.Fatalf("missing principal Codex alias %s in %s", required, encoded)
		}
	}
	if strings.Contains(encoded, `"source":"`+principalHome) {
		t.Fatalf("runc configuration exposed the principal host path instead of its idmapped mount: %s", encoded)
	}
	for _, expected := range []string{
		`"uidMappings":[{"containerID":0,"hostID":100000,"size":65536}]`,
		`"gidMappings":[{"containerID":0,"hostID":100000,"size":65536}]`,
	} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("principal identity leaked into the outer user namespace; missing %s in %s", expected, encoded)
		}
	}
}

func TestRuncPrincipalHomeUsesIDMappedBindMount(t *testing.T) {
	root := t.TempDir()
	runner := &cleanupRuncRunner{}
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(root, "runtime"),
		AgentBinary: filepath.Join(root, "hypernode"),
		AgentPolicy: filepath.Join(root, "workspace-agent.js"),
		UIDBase:     100000,
		Runner:      runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	paths := runcBundlePaths{
		bundle:        filepath.Join(root, "runtime", "attachment"),
		principalHome: "/private/users/alice-stable",
		principalUID:  20002,
		principalGID:  20003,
	}
	if err := os.MkdirAll(paths.principalRuntimeHome(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := runtime.bindPrincipalHome(context.Background(), paths); err != nil {
		t.Fatal(err)
	}
	commands := strings.Join(runner.commands, "\n")
	expected := "mount --bind -o X-mount.idmap=u:20002:100000:1 g:20003:100000:1 " +
		paths.principalHome + " " + paths.principalRuntimeHome()
	if !strings.Contains(commands, expected) {
		t.Fatalf("missing idmapped principal mount %q in %s", expected, commands)
	}
}

func TestRuncPrincipalHomeMigratesLegacyRuntimeOwnership(t *testing.T) {
	root := t.TempDir()
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(root, "runtime"),
		AgentBinary: filepath.Join(root, "hypernode"),
		AgentPolicy: filepath.Join(root, "workspace-agent.js"),
		UIDBase:     100000,
		Runner:      &cleanupRuncRunner{},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	principalHome := filepath.Join(root, "principal-home")
	legacyDirectory := filepath.Join(principalHome, ".codex", "hypernode", "workspace-sqlite")
	legacyFile := filepath.Join(legacyDirectory, "state.sqlite")
	if err := os.MkdirAll(legacyDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyFile, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(principalHome, 20002, 20003); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{legacyDirectory, legacyFile} {
		if err := os.Chown(path, 100000, 100000); err != nil {
			t.Fatal(err)
		}
	}
	paths := runcBundlePaths{
		principalHome: principalHome,
		principalUID:  20002,
		principalGID:  20003,
	}
	if err := runtime.normalizePrincipalHomeOwnership(paths); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{legacyDirectory, legacyFile, filepath.Join(principalHome, principalHomeIDMapMarker)} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != 20002 || stat.Gid != 20003 {
			t.Fatalf("legacy entry was not migrated to the principal: %s is %d:%d", path, stat.Uid, stat.Gid)
		}
	}
}

func TestRuncRuntimeLiveAttach(t *testing.T) {
	if os.Getenv("HYPERNODE_RUNC_INTEGRATION") != "1" {
		t.Skip("set HYPERNODE_RUNC_INTEGRATION=1 to run the privileged live attach gate")
	}
	for _, executable := range []string{"runc", "setfacl"} {
		if _, err := exec.LookPath(executable); err != nil {
			t.Fatal(err)
		}
	}
	system := os.Getenv("HYPERNODE_RUNC_SYSTEM")
	data := os.Getenv("HYPERNODE_RUNC_DATA")
	agent := os.Getenv("HYPERNODE_RUNC_AGENT")
	policy := os.Getenv("HYPERNODE_RUNC_POLICY")
	for label, value := range map[string]string{"system": system, "data": data, "agent": agent, "policy": policy} {
		if value == "" {
			t.Fatalf("missing HYPERNODE_RUNC_%s", strings.ToUpper(label))
		}
	}
	temporaryRoot := t.TempDir()
	if err := os.Chmod(temporaryRoot, 0o711); err != nil {
		t.Fatal(err)
	}
	principalHome := filepath.Join(temporaryRoot, "principal-home")
	visualizationRoot := filepath.Join(principalHome, ".codex", "visualizations", "idmap-probe")
	if err := os.MkdirAll(visualizationRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := filepath.Walk(principalHome, func(path string, _ os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return os.Chown(path, 20002, 20002)
	}); err != nil {
		t.Fatal(err)
	}
	principalResolver := func(Principal) (string, error) { return principalHome, nil }
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(temporaryRoot, "runtime"), AgentBinary: agent, AgentPolicy: policy,
		PrincipalHomeResolver: principalResolver,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	attachment, err := runtime.Attach(ctx, Ref{ID: "integration", Driver: LocalBtrfsDriverName}, LocalPaths{System: system, Data: data}, AttachSpec{
		Principal: Principal{ID: "integration", Username: "integration"}, Mode: ModeReadWrite,
	})
	if err != nil {
		t.Fatal(err)
	}
	if attachment.Endpoint.Transport != "ssh" || attachment.Endpoint.Port == 0 {
		t.Fatalf("unexpected endpoint: %#v", attachment.Endpoint)
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(attachment.Endpoint.Host, strconv.Itoa(attachment.Endpoint.Port)), &ssh.ClientConfig{
		User: attachment.Endpoint.Username, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	gatePath := fmt.Sprintf("/workspace/.hypernode-live-gate-%d", time.Now().UnixNano())
	if response := liveWorkspaceCall(t, client, map[string]any{
		"op": "write", "path": gatePath, "data": []byte("workspace-v2-live"),
	}); response.Type != "result" {
		t.Fatalf("unexpected write response: %#v", response)
	}
	if response := liveWorkspaceCall(t, client, map[string]any{"op": "read", "path": gatePath}); string(response.Data) != "workspace-v2-live" {
		t.Fatalf("unexpected read response: %#v", response)
	}
	if response := liveWorkspaceCall(t, client, map[string]any{
		"op": "exec", "path": "/workspace",
		"command":   []string{"sh", "-c", `pwd; cat "$1"`, "sh", gatePath},
		"timeoutMs": 2000, "outputBytesCap": 4096,
	}); response.ExitCode != 0 || string(response.Stdout) != "/workspace\nworkspace-v2-live" {
		t.Fatalf("unexpected exec response: %#v", response)
	}
	containerVisualizationRoot := "/workspace/.codex/visualizations/idmap-probe"
	if response := liveWorkspaceCall(t, client, map[string]any{
		"op": "exec", "path": "/workspace",
		"command": []string{"bwrap", "--unshare-user", "--uid", "0", "--gid", "0",
			"--ro-bind", "/", "/", "--bind", containerVisualizationRoot, containerVisualizationRoot,
			"--proc", "/proc", "--dev", "/dev", "/bin/sh", "-c",
			`touch "$1/probe"; stat -c '%u:%g' "$1"`, "sh", containerVisualizationRoot},
		"timeoutMs": 2000, "outputBytesCap": 4096,
	}); response.ExitCode != 0 || string(response.Stdout) != "0:0\n" {
		t.Fatalf("nested bwrap could not write the idmapped Codex home: %#v", response)
	}
	if response := liveWorkspaceCall(t, client, map[string]any{
		"op": "remove", "path": gatePath, "force": true,
	}); response.Type != "result" {
		t.Fatalf("unexpected remove response: %#v", response)
	}
	if err := runtime.Detach(ctx, attachment); err != nil {
		t.Fatal(err)
	}
}

type cleanupRuncRunner struct {
	entries  []runcListEntry
	commands []string
}

func (r *cleanupRuncRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.commands = append(r.commands, name+" "+strings.Join(args, " "))
	if len(args) == 3 && args[0] == "list" && args[1] == "--format" && args[2] == "json" {
		return json.Marshal(r.entries)
	}
	return nil, nil
}

func TestRuncRuntimeCleanupRemovesOnlyOwnedOrphans(t *testing.T) {
	root := t.TempDir()
	runtimeRoot := filepath.Join(root, "runtime")
	ownedBundle := filepath.Join(runtimeRoot, "stale-id")
	unrelatedBundle := filepath.Join(root, "other", "foreign-id")
	if err := os.MkdirAll(ownedBundle, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(unrelatedBundle, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &cleanupRuncRunner{entries: []runcListEntry{
		{ID: "hypernode-stale-id", Bundle: ownedBundle},
		{ID: "hypernode-foreign-id", Bundle: unrelatedBundle},
		{ID: "another-runtime", Bundle: filepath.Join(runtimeRoot, "another-runtime")},
	}}
	runtime, err := NewRuncRuntime(RuncRuntimeConfig{
		RuntimeRoot: runtimeRoot,
		AgentBinary: filepath.Join(root, "hypernode"),
		AgentPolicy: filepath.Join(root, "workspace-agent.js"),
		Runner:      runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if err := runtime.ReconcileRuntimeRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ownedBundle); !os.IsNotExist(err) {
		t.Fatalf("owned stale bundle still exists: %v", err)
	}
	if _, err := os.Stat(unrelatedBundle); err != nil {
		t.Fatalf("unrelated bundle was removed: %v", err)
	}
	commands := strings.Join(runner.commands, "\n")
	for _, expected := range []string{
		"runc kill hypernode-stale-id KILL",
		"runc delete --force hypernode-stale-id",
	} {
		if !strings.Contains(commands, expected) {
			t.Fatalf("missing cleanup command %q in %s", expected, commands)
		}
	}
	if strings.Contains(commands, "foreign-id KILL") || strings.Contains(commands, "another-runtime KILL") {
		t.Fatalf("cleanup crossed its runtime ownership boundary: %s", commands)
	}
}

func TestRuncRuntimeRootHasOneExclusiveOwner(t *testing.T) {
	root := t.TempDir()
	config := RuncRuntimeConfig{
		RuntimeRoot: filepath.Join(root, "runtime"),
		AgentBinary: filepath.Join(root, "hypernode"),
		AgentPolicy: filepath.Join(root, "workspace-agent.js"),
	}
	first, err := NewRuncRuntime(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuncRuntime(config); err == nil {
		t.Fatal("second runtime unexpectedly acquired the same runtime root")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := NewRuncRuntime(config)
	if err != nil {
		t.Fatalf("runtime root remained locked after owner close: %v", err)
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}
}

type liveWorkspaceResponse struct {
	Type     string `json:"type"`
	Message  string `json:"message,omitempty"`
	Data     []byte `json:"data,omitempty"`
	ExitCode int    `json:"exitCode,omitempty"`
	Stdout   []byte `json:"stdout,omitempty"`
	Stderr   []byte `json:"stderr,omitempty"`
}

func liveWorkspaceCall(t *testing.T, client *ssh.Client, request any) liveWorkspaceResponse {
	t.Helper()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	input, err := session.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := session.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Start("@hypernode workspace-stdio hypernode-fs@v1"); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	header := [4]byte{}
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := input.Write(append(header[:], payload...)); err != nil {
		t.Fatal(err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(output, header[:]); err != nil {
		t.Fatal(err)
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 || length > 16<<20 {
		t.Fatalf("invalid workspace response frame length: %d", length)
	}
	payload = make([]byte, int(length))
	if _, err := io.ReadFull(output, payload); err != nil {
		t.Fatal(err)
	}
	var response liveWorkspaceResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if err := session.Wait(); err != nil && response.Type != "error" {
		t.Fatal(err)
	}
	if response.Type == "error" {
		t.Fatal(response.Message)
	}
	return response
}

func mustJSON(value any) []byte {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return bytes
}
