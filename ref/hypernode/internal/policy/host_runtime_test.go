package policy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	goja "hypernode/internal/policy/jsvm"
)

func TestHostRuntimeFilesystemAndCodexStdio(t *testing.T) {
	root := t.TempDir()
	fakeCodex := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(fakeCodex, []byte("#!/bin/sh\nexec /bin/cat\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	host, err := installHostRuntime(vm, RuntimeConfig{
		LocalhostRoot:   root,
		CodexExecutable: fakeCodex,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	value, err := vm.RunString(`
		hostFilesystem.createDirectory("project", true);
		hostFilesystem.writeFile("project/value.txt", [104, 101, 108, 108, 111]);
		Array.from(hostFilesystem.readFile("project/value.txt")).map((byte) => String.fromCharCode(byte)).join("");
	`)
	if err != nil || value.String() != "hello" {
		t.Fatalf("host filesystem value=%q err=%v", value, err)
	}
	if _, err := vm.RunString(`hostFilesystem.readFile("../escape")`); err == nil {
		t.Fatal("host filesystem allowed root escape")
	}

	if _, err := vm.RunString(`
		hostProcess.spawnCodexAppServer("test", ".");
	`); err != nil {
		t.Fatal(err)
	}
	wake, cancelWake := host.wakes.subscribe()
	defer cancelWake()
	if _, err := vm.RunString(`hostProcess.write("test", "stdio-sentinel\n")`); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var observed []string
	for time.Now().Before(deadline) {
		select {
		case <-wake:
		case <-time.After(time.Until(deadline)):
			t.Fatalf("host process did not emit a wake notification; observed=%v", observed)
		}
		value, err = vm.RunString(`JSON.stringify(hostProcess.drain("test"))`)
		if err != nil {
			t.Fatal(err)
		}
		if value.String() != "" {
			observed = append(observed, value.String())
		}
		if strings.Contains(value.String(), "stdio-sentinel") {
			return
		}
	}
	t.Fatalf("host process stdio was not drained; observed=%v", observed)
}

func TestHostRuntimeWakeAfterCoalescesOntoEarliestDeadline(t *testing.T) {
	root := t.TempDir()
	vm := goja.New()
	host, err := installHostRuntime(vm, RuntimeConfig{LocalhostRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	before, err := vm.RunString(`hostEvents.monotonicNowMs()`)
	if err != nil {
		t.Fatal(err)
	}
	defer before.Free()
	time.Sleep(2 * time.Millisecond)
	after, err := vm.RunString(`hostEvents.monotonicNowMs()`)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Free()
	beforeMs, beforeOK := before.Export().(int64)
	afterMs, afterOK := after.Export().(int64)
	if !beforeOK || !afterOK || afterMs < beforeMs {
		t.Fatalf("monotonic clock moved backwards: before=%#v after=%#v", before.Export(), after.Export())
	}

	tickWake, cancelTickWake := host.tickWakes.subscribe()
	defer cancelTickWake()
	startedAt := time.Now()
	if _, err := vm.RunString(`hostEvents.wakeAfter(80); hostEvents.wakeAfter(15); hostEvents.wakeAfter(120)`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-tickWake:
		elapsed := time.Since(startedAt)
		if elapsed < 8*time.Millisecond || elapsed > 100*time.Millisecond {
			t.Fatalf("wakeAfter elapsed=%s, want earliest scheduled deadline", elapsed)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("wakeAfter did not wake policy Tick")
	}
}

func TestHostProcessExitIsPublishedAfterOutputIsCaptured(t *testing.T) {
	vm := goja.New()
	host, err := installHostRuntime(vm, RuntimeConfig{LocalhostRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	// No trailing newline forces Scanner to publish the token only after EOF.
	// This used to expose a race where `exited` became visible before stdout.
	for index := 0; index < 100; index++ {
		id := fmt.Sprintf("short-output-%d", index)
		sentinel := fmt.Sprintf("sentinel-%d", index)
		if err := host.spawnShell(id, ".", "printf %s "+sentinel, nil); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(2 * time.Second)
		var stdout strings.Builder
		for {
			result, err := host.drainProcess(id)
			if err != nil {
				t.Fatal(err)
			}
			for _, line := range result["stdoutLines"].([]string) {
				stdout.WriteString(line)
			}
			if result["exited"].(bool) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("process %s did not exit", id)
			}
			time.Sleep(time.Millisecond)
		}
		if stdout.String() != sentinel {
			t.Fatalf("process %s exited before stdout was captured: got %q want %q", id, stdout.String(), sentinel)
		}
		if err := host.killProcess(id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTerminateProcessStopsAndReapsAProcessGroup(t *testing.T) {
	host := &hostRuntime{
		processes: make(map[string]*hostProcess),
		wakes:     newWakeBroadcaster(),
	}
	cmd := exec.Command("/bin/sh", "-c", `trap 'exit 0' TERM; while :; do sleep 1; done`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := host.startProcess("thread-runtime", cmd); err != nil {
		t.Fatal(err)
	}
	process, err := host.getProcess("thread-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if err := host.terminateProcess("thread-runtime", 2*time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.done:
	default:
		t.Fatal("terminated process was not reaped")
	}
	if _, err := host.getProcess("thread-runtime"); err == nil {
		t.Fatal("terminated process remained addressable")
	}
}

func TestPerUserFilesystemCreatesOwnedWritablePaths(t *testing.T) {
	root := t.TempDir()
	usersRoot := t.TempDir()
	home := filepath.Join(usersRoot, userHomeSegment("alice"))
	unmanagedCache := filepath.Join(home, ".cache", "tool", "payload.bin")
	if err := os.MkdirAll(filepath.Dir(unmanagedCache), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unmanagedCache, []byte("cached"), 0o644); err != nil {
		t.Fatal(err)
	}
	cacheBefore, err := os.Lstat(unmanagedCache)
	if err != nil {
		t.Fatal(err)
	}
	cacheOwnerBefore := cacheBefore.Sys().(*syscall.Stat_t)

	vm := goja.New()
	host, err := installHostRuntime(vm, RuntimeConfig{LocalhostRoot: root, UsersRoot: usersRoot})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if host.dshPersistenceRoot != filepath.Join(filepath.Dir(usersRoot), "dsh-sessions") {
		t.Fatalf("unexpected DSH persistence root %q", host.dshPersistenceRoot)
	}
	if info, err := os.Stat(host.dshPersistenceRoot); err != nil || !info.IsDir() {
		t.Fatalf("DSH persistence root was not created: info=%v err=%v", info, err)
	}
	if host.dshHomeRoot != filepath.Join(filepath.Dir(usersRoot), "dsh-home") {
		t.Fatalf("unexpected DSH home root %q", host.dshHomeRoot)
	}
	if info, err := os.Stat(host.dshHomeRoot); err != nil || !info.IsDir() {
		t.Fatalf("DSH home root was not created: info=%v err=%v", info, err)
	}

	if _, err := vm.RunString(`
		hostIdentity.ensureUser("alice", 20041, 20041, "11111111-1111-4111-8111-111111111111");
		hostFilesystem.createDirectoryForUser("alice", "project/src", true, 20041, 20041);
		hostFilesystem.writeFileForUser("alice", "project/src/value.txt", [104, 105], 20041, 20041);
	`); err != nil {
		t.Fatal(err)
	}

	for _, relative := range []string{"project", "project/src", "project/src/value.txt"} {
		info, err := os.Lstat(filepath.Join(home, relative))
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != 20041 || stat.Gid != 20041 {
			t.Fatalf("%s ownership=%d:%d", relative, stat.Uid, stat.Gid)
		}
	}
	cacheAfter, err := os.Lstat(unmanagedCache)
	if err != nil {
		t.Fatal(err)
	}
	cacheOwnerAfter := cacheAfter.Sys().(*syscall.Stat_t)
	if cacheOwnerAfter.Uid != cacheOwnerBefore.Uid || cacheOwnerAfter.Gid != cacheOwnerBefore.Gid {
		t.Fatalf("ensureUser rewrote unmanaged cache ownership from %d:%d to %d:%d",
			cacheOwnerBefore.Uid, cacheOwnerBefore.Gid, cacheOwnerAfter.Uid, cacheOwnerAfter.Gid)
	}
	passwd, err := os.ReadFile(filepath.Join(home, ".nss", "passwd"))
	if err != nil {
		t.Fatal(err)
	}
	wantPasswd := "alice:x:20041:20000:alice:/run/hypernode-users/alice-2bd806c97f:/bin/bash"
	if !strings.Contains(string(passwd), wantPasswd) {
		t.Fatalf("NSS passwd missing %q: %q", wantPasswd, passwd)
	}
	group, err := os.ReadFile(filepath.Join(home, ".nss", "group"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(group), "hypernode:x:20000:alice") {
		t.Fatalf("NSS group did not project workspace membership: %q", group)
	}
}
