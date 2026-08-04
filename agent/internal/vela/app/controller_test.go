//go:build darwin || linux

package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"velachat/agent/internal/common"
	rootstate "velachat/agent/internal/state"
	velacli "velachat/agent/internal/vela/cli"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/platform"
	"velachat/agent/internal/vela/tat"
)

func TestWriteRuntimeCatalogStatusIsStableAndPathFree(t *testing.T) {
	var output bytes.Buffer
	writeRuntimeCatalogStatus(
		&output,
		[]string{"pi", "codex"},
		true,
	)
	if got, want := output.String(),
		"Vela Runtime Catalog: available=codex,pi codex_configured=true\n"; got != want {
		t.Fatalf("status = %q, want %q", got, want)
	}
	if strings.Contains(output.String(), "/Users/") {
		t.Fatalf("status exposed a local path: %q", output.String())
	}
}

func TestDefaultControllerRunsComputerSessionAndAssignmentLoop(
	t *testing.T,
) {
	t.Parallel()

	now := time.Now().UTC()
	snapshot := daemon.Snapshot{
		SchemaVersion: 1,
		ComputerID:    computerControllerID,
		Epoch:         computerControllerEpoch,
		Revision:      1,
		Agents:        []daemon.AgentAssignment{},
	}
	_, digest, err := daemon.CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = encodeRawURLBase64(digest[:])
	var sessionCalls atomic.Int64
	var assignmentCalls atomic.Int64
	var heartbeatCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/v1/computer/session":
				sessionCalls.Add(1)
				if request.Header.Get("Authorization") !=
					"ComputerCredential "+controllerCredential() {
					http.Error(response, "bad auth", http.StatusUnauthorized)
					return
				}
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"accessToken": "computer-access-test",
					"expiresAt":   now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id":                 computerControllerID,
						"serverId":           computerControllerServerID,
						"credentialVersion":  1,
						"assignmentEpoch":    computerControllerEpoch,
						"assignmentRevision": 1,
					},
					"assignmentVersions": []int{1},
				})
			case "/v1/computer/assignments":
				call := assignmentCalls.Add(1)
				if request.Header.Get("Authorization") !=
					"Bearer computer-access-test" {
					http.Error(response, "bad auth", http.StatusUnauthorized)
					return
				}
				if call == 1 {
					writeControllerJSON(t, response, snapshot)
					return
				}
				<-request.Context().Done()
			case "/v1/computer/heartbeat":
				heartbeatCalls.Add(1)
				response.WriteHeader(http.StatusNoContent)
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()

	root := shortAppRoot(t)
	store := rootstate.New(root)
	if err := store.Write("config.json", managedComputerConfig{
		SchemaVersion: 1,
		PlatformURL:   server.URL + "/v1",
		ServerID:      computerControllerServerID,
		ComputerID:    computerControllerID,
		Name:          "测试 Computer",
		Region:        "ap-guangzhou",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteFile(
		"computer.credential",
		[]byte(controllerCredential()),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	var output synchronizedBuffer
	tatRuntime := &fakeTATRuntime{}
	actions, err := NewActions(Config{
		Version:               "test-version",
		Stdout:                &output,
		Stderr:                io.Discard,
		Now:                   func() time.Time { return now },
		AllowInsecureLoopback: true,
		TAT:                   tatRuntime,
		HeartbeatInterval:     10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- actions.DaemonRun(ctx, velacli.DaemonRunOptions{
			StateOptions: velacli.StateOptions{StateDir: root},
		})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		output.Reset()
		callCtx, callCancel := context.WithTimeout(
			context.Background(),
			100*time.Millisecond,
		)
		err = actions.Status(callCtx, velacli.StatusOptions{
			StateOptions: velacli.StateOptions{StateDir: root},
			JSON:         true,
		})
		callCancel()
		if err == nil &&
			bytes.Contains(output.Bytes(), []byte(`"revision":1`)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon status unavailable: %v %s", err, output.Bytes())
		}
		time.Sleep(10 * time.Millisecond)
	}
	for assignmentCalls.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("assignment long-poll did not resume")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for heartbeatCalls.Load() < 1 {
		if time.Now().After(deadline) {
			t.Fatal("Computer heartbeat was not sent")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("default controller daemon did not stop")
	}
	if sessionCalls.Load() != 1 {
		t.Fatalf("session calls = %d", sessionCalls.Load())
	}
	if assignmentCalls.Load() < 2 {
		t.Fatalf("assignment calls = %d", assignmentCalls.Load())
	}
	if tatRuntime.startCalls.Load() != 1 ||
		tatRuntime.closeCalls.Load() != 1 {
		t.Fatalf(
			"TAT lifecycle = start:%d close:%d",
			tatRuntime.startCalls.Load(),
			tatRuntime.closeCalls.Load(),
		)
	}
	if err := rootstate.New(root).Read(
		filepath.Base("assignment.cursor.json"),
		&map[string]any{},
	); err != nil {
		t.Fatalf("assignment cursor missing: %v", err)
	}
}

func TestDefaultControllerStartsTatBeforeFirstComputerSession(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	snapshot := daemon.Snapshot{
		SchemaVersion: 1,
		ComputerID:    computerControllerID,
		Epoch:         computerControllerEpoch,
		Revision:      1,
		Agents:        []daemon.AgentAssignment{},
	}
	_, digest, err := daemon.CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = encodeRawURLBase64(digest[:])
	tatRuntime := &fakeTATRuntime{}
	var sessionCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/v1/computer/session":
				sessionCalls.Add(1)
				if tatRuntime.startCalls.Load() == 0 {
					http.Error(response, "computer is still provisioning", http.StatusUnauthorized)
					return
				}
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"accessToken": "computer-access-test",
					"expiresAt":   now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id":                 computerControllerID,
						"serverId":           computerControllerServerID,
						"credentialVersion":  1,
						"assignmentEpoch":    computerControllerEpoch,
						"assignmentRevision": 1,
					},
					"assignmentVersions": []int{1},
				})
			case "/v1/computer/assignments":
				writeControllerJSON(t, response, snapshot)
			case "/v1/computer/heartbeat":
				response.WriteHeader(http.StatusNoContent)
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()

	root := shortAppRoot(t)
	store := rootstate.New(root)
	if err := store.Write("config.json", managedComputerConfig{
		SchemaVersion: 1,
		PlatformURL:   server.URL + "/v1",
		ServerID:      computerControllerServerID,
		ComputerID:    computerControllerID,
		Name:          "测试 Computer",
		Region:        "ap-guangzhou",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteFile(
		"computer.credential",
		[]byte(controllerCredential()),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	actions, err := NewActions(Config{
		Version:               "test-version",
		Stdout:                io.Discard,
		Stderr:                io.Discard,
		Now:                   func() time.Time { return now },
		AllowInsecureLoopback: true,
		TAT:                   tatRuntime,
		HeartbeatInterval:     10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- actions.DaemonRun(ctx, velacli.DaemonRunOptions{
			StateOptions: velacli.StateOptions{StateDir: root},
		})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for tatRuntime.startCalls.Load() == 0 || sessionCalls.Load() == 0 {
		select {
		case runErr := <-done:
			t.Fatalf("daemon stopped before TAT activation: %v", runErr)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("daemon did not start TAT and establish a Computer session")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatal(runErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon did not stop")
	}
}

func TestDefaultControllerSetupCompletesManagedComputer(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	var createCalls atomic.Int64
	var registrationCalls atomic.Int64
	var getCalls atomic.Int64
	var credentialCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.Header.Get("Authorization") != "Bearer human-test" {
				http.Error(response, "bad auth", http.StatusUnauthorized)
				return
			}
			switch request.URL.Path {
			case "/v1/servers/" + computerControllerServerID + "/computers":
				createCalls.Add(1)
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"id":       computerControllerID,
					"serverId": computerControllerServerID,
					"name":     "开发机", "tatRegion": "ap-guangzhou",
					"tatInstanceId": nil, "tatInstanceKind": "managed",
					"osType": "macos", "lifecycleState": "provisioning",
					"tatAgentState": "unknown", "lastObservedAt": nil,
					"lastErrorCode": nil, "revision": 1,
				})
			case "/v1/servers/" + computerControllerServerID +
				"/computers/" + computerControllerID + "/registration":
				registrationCalls.Add(1)
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"computerId":        computerControllerID,
					"protocol":          "tencent-tat-register-v1",
					"region":            "ap-guangzhou",
					"registerCodeId":    "register-id",
					"registerCodeValue": "register-value",
					"tags": []map[string]string{
						{"key": "VelaComputerID", "value": computerControllerID},
					},
					"expiresAt": now.Add(10 * time.Minute),
				})
			case "/v1/servers/" + computerControllerServerID +
				"/computers/" + computerControllerID:
				getCalls.Add(1)
				writeControllerJSON(t, response, map[string]any{
					"id":       computerControllerID,
					"serverId": computerControllerServerID,
					"name":     "开发机", "tatRegion": "ap-guangzhou",
					"tatInstanceId":   "rins-test",
					"tatInstanceKind": "managed", "osType": "macos",
					"lifecycleState": "active", "tatAgentState": "online",
					"lastObservedAt": now, "lastErrorCode": nil,
					"revision": 2,
				})
			case "/v1/servers/" + computerControllerServerID +
				"/computers/" + computerControllerID +
				"/runtime-credentials":
				credentialCalls.Add(1)
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"credentialId":   "018f0c9e-7b14-7abc-8def-0123456789ab",
					"version":        1,
					"secret":         controllerCredential(),
					"expiresAt":      now.Add(365 * 24 * time.Hour),
					"graceExpiresAt": nil,
				})
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()

	root := shortAppRoot(t)
	tokenPath := filepath.Join(root, "human.token")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("human-test"), 0o600); err != nil {
		t.Fatal(err)
	}
	tatRuntime := &fakeTATRuntime{}
	actions, err := NewActions(Config{
		Version:               "test-version",
		Stdout:                &bytes.Buffer{},
		Stderr:                &bytes.Buffer{},
		Now:                   func() time.Time { return now },
		AllowInsecureLoopback: true,
		TAT:                   tatRuntime,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = actions.Setup(context.Background(), velacli.SetupOptions{
		StateOptions:    velacli.StateOptions{StateDir: root},
		PlatformURL:     server.URL + "/v1",
		AccessTokenFile: tokenPath,
		ServerID:        computerControllerServerID,
		Name:            "开发机",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := actions.Setup(context.Background(), velacli.SetupOptions{
		StateOptions:    velacli.StateOptions{StateDir: root},
		PlatformURL:     server.URL + "/v1",
		AccessTokenFile: tokenPath,
		ServerID:        computerControllerServerID,
		Name:            "开发机",
	}); err != nil {
		t.Fatalf("idempotent setup: %v", err)
	}
	config, err := loadManagedComputerConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if config.ComputerID != computerControllerID {
		t.Fatalf("config = %#v", config)
	}
	credential, err := loadComputerCredential(
		filepath.Join(root, "computer.credential"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Reveal() != controllerCredential() {
		t.Fatal("saved credential mismatch")
	}
	if createCalls.Load() != 1 ||
		registrationCalls.Load() != 1 ||
		getCalls.Load() != 1 ||
		credentialCalls.Load() != 1 {
		t.Fatalf(
			"calls = create:%d registration:%d get:%d credential:%d",
			createCalls.Load(),
			registrationCalls.Load(),
			getCalls.Load(),
			credentialCalls.Load(),
		)
	}
	if tatRuntime.registerCalls.Load() != 1 ||
		tatRuntime.startCalls.Load() != 1 ||
		tatRuntime.closeCalls.Load() != 1 {
		t.Fatalf(
			"TAT = register:%d start:%d close:%d",
			tatRuntime.registerCalls.Load(),
			tatRuntime.startCalls.Load(),
			tatRuntime.closeCalls.Load(),
		)
	}
}

func TestAssignmentSourceRefreshesRejectedComputerSession(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	snapshot := daemon.Snapshot{
		SchemaVersion: 1,
		ComputerID:    computerControllerID,
		Epoch:         computerControllerEpoch,
		Revision:      1,
		Agents:        []daemon.AgentAssignment{},
	}
	_, digest, err := daemon.CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = encodeRawURLBase64(digest[:])
	var sessionCalls atomic.Int64
	var assignmentCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/v1/computer/session":
				call := sessionCalls.Add(1)
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"accessToken": "computer-access-" +
						strconv.FormatInt(call, 10),
					"expiresAt": now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id":                 computerControllerID,
						"serverId":           computerControllerServerID,
						"credentialVersion":  1,
						"assignmentEpoch":    computerControllerEpoch,
						"assignmentRevision": 1,
					},
					"assignmentVersions": []int{1},
				})
			case "/v1/computer/assignments":
				assignmentCalls.Add(1)
				if request.Header.Get("Authorization") ==
					"Bearer computer-access-1" {
					http.Error(response, "expired", http.StatusUnauthorized)
					return
				}
				writeControllerJSON(t, response, snapshot)
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()
	client, err := platform.NewClient(platform.Config{
		BaseURL:               server.URL + "/v1",
		AllowInsecureLoopback: true,
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := platform.NewComputerCredential(
		controllerCredential(),
	)
	if err != nil {
		t.Fatal(err)
	}
	manager := &computerSessionManager{
		client: client, credential: credential,
		now: func() time.Time { return now },
	}
	source := &computerAssignmentSource{
		computerID: computerControllerID,
		sessions:   manager,
		client:     client,
	}
	result, err := source.Poll(context.Background(), daemon.PollRequest{
		WaitSeconds: 25,
		ForceFull:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Snapshot == nil ||
		sessionCalls.Load() != 2 ||
		assignmentCalls.Load() != 2 {
		t.Fatalf(
			"result=%#v session=%d assignment=%d",
			result,
			sessionCalls.Load(),
			assignmentCalls.Load(),
		)
	}
}

type fakeTATRuntime struct {
	registerCalls atomic.Int64
	startCalls    atomic.Int64
	closeCalls    atomic.Int64
}

func (r *fakeTATRuntime) Register(
	_ context.Context,
	registration tat.Registration,
) error {
	if filepath.Base(registration.StateRoot) != "tat" ||
		registration.RegisterCodeID == "" ||
		len(registration.Tags) != 1 {
		return errors.New("unexpected TAT registration")
	}
	r.registerCalls.Add(1)
	return nil
}

func (r *fakeTATRuntime) Start(
	_ context.Context,
	stateRoot string,
) (tat.Handle, error) {
	if filepath.Base(stateRoot) != "tat" {
		return nil, errors.New("unexpected TAT state root")
	}
	r.startCalls.Add(1)
	return fakeTATHandle{closeCalls: &r.closeCalls}, nil
}

type fakeTATHandle struct {
	closeCalls *atomic.Int64
}

func (h fakeTATHandle) Close(context.Context) error {
	h.closeCalls.Add(1)
	return nil
}

const (
	computerControllerServerID = "018f0c9e-7b10-7abc-8def-0123456789ab"
	computerControllerID       = "018f0c9e-7b12-7abc-8def-0123456789ab"
	computerControllerEpoch    = "018f0c9e-7b13-7abc-8def-0123456789ab"
)

func controllerCredential() string {
	return "crc_" + computerControllerServerID + "." +
		computerControllerID +
		".1.abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678"
}

func writeControllerJSON(
	t *testing.T,
	response http.ResponseWriter,
	value any,
) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	encoded, err := common.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = response.Write(encoded)
}

func encodeRawURLBase64(value []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	result := make([]byte, 0, (len(value)*8+5)/6)
	var accumulator uint32
	var bits uint
	for _, item := range value {
		accumulator = accumulator<<8 | uint32(item)
		bits += 8
		for bits >= 6 {
			bits -= 6
			result = append(result, alphabet[(accumulator>>bits)&0x3f])
		}
	}
	if bits > 0 {
		result = append(result, alphabet[(accumulator<<(6-bits))&0x3f])
	}
	return string(result)
}

// synchronizedBuffer keeps the daemon's asynchronous diagnostic writes from
// racing with status assertions. Bytes returns a copy so callers never retain
// the buffer's internal storage after the lock is released.
type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *synchronizedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(value)
}

func (b *synchronizedBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buffer.Reset()
}

func (b *synchronizedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buffer.Bytes()...)
}
