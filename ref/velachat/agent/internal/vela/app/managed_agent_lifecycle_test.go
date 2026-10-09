//go:build darwin || linux

package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimecatalog"
	"velachat/agent/internal/vela/agentgateway"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/platform"
)

const managedLifecycleAgentID = "018f0c9e-7b14-7abc-8def-0123456789ab"

func TestManagedAgentWaitsForStartingObservationBeforeIM(t *testing.T) {
	now := time.Now().UTC()
	startingGate := make(chan struct{})
	var releaseStarting sync.Once
	observations := make(chan platform.ComputerAgentObservation, 8)
	server := newManagedLifecyclePlatformWithStartingGate(
		t, now, nil, startingGate, observations,
	)
	defer server.Close()
	defer releaseStarting.Do(func() { close(startingGate) })
	client, err := platform.NewClient(platform.Config{
		BaseURL: server.URL + "/v1", Now: func() time.Time { return now },
		MaxSessionTTL: 24 * time.Hour, AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := platform.NewComputerCredential(controllerCredential())
	if err != nil {
		t.Fatal(err)
	}
	sessions := &computerSessionManager{
		client: client, credential: credential, now: func() time.Time { return now },
	}
	if _, err := sessions.Current(context.Background()); err != nil {
		t.Fatal(err)
	}
	governor, err := daemon.NewLaunchGovernor(daemon.LaunchGovernorConfig{
		MinimumInterval: time.Nanosecond,
		Jitter:          func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer governor.Close()
	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	transports := newManagedLifecycleTransportFactory()
	registry, err := daemon.NewRegistry(daemon.RegistryConfig{
		Factory: &managedAgentFactory{
			root: t.TempDir(), stderr: testDiscardWriter{},
			runtimes: managedLifecycleRuntimes(t), governor: governor,
			sessions: sessions, client: client, transports: transports,
			gatewayHub: hub,
		},
		MaxConcurrent: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close(context.Background())
	if result, err := registry.Apply(
		context.Background(), managedLifecycleSnapshot(),
	); err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	starting := waitManagedObservationState(t, observations, "starting")
	if starting.Sequence != 1 {
		t.Fatalf("starting sequence = %d, want 1", starting.Sequence)
	}
	time.Sleep(100 * time.Millisecond)
	if starts := transports.starts.Load(); starts != 0 {
		t.Fatalf("IM started before starting observation was accepted: %d", starts)
	}
	releaseStarting.Do(func() { close(startingGate) })
	transport := waitManagedTransport(t, transports)
	waitManagedTransportStarted(t, transport)
	waitManagedAgentState(t, registry, daemon.AgentStateRunning)
}

func TestManagedAgentRemainsRunningAfterFactoryStartReturns(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	observations := make(chan platform.ComputerAgentObservation, 8)
	server := newManagedLifecyclePlatform(t, now, nil, observations)
	defer server.Close()
	client, err := platform.NewClient(platform.Config{
		BaseURL:               server.URL + "/v1",
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := platform.NewComputerCredential(controllerCredential())
	if err != nil {
		t.Fatal(err)
	}
	sessions := &computerSessionManager{
		client:     client,
		credential: credential,
		now:        func() time.Time { return now },
	}
	if _, err := sessions.Current(context.Background()); err != nil {
		t.Fatal(err)
	}
	runtimes := managedLifecycleRuntimes(t)
	governor, err := daemon.NewLaunchGovernor(daemon.LaunchGovernorConfig{
		MinimumInterval: time.Nanosecond,
		Jitter:          func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer governor.Close()
	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	transports := newManagedLifecycleTransportFactory()
	stateRoot := t.TempDir()
	registry, err := daemon.NewRegistry(daemon.RegistryConfig{
		Factory: &managedAgentFactory{
			root:       stateRoot,
			stderr:     testDiscardWriter{},
			runtimes:   runtimes,
			governor:   governor,
			sessions:   sessions,
			client:     client,
			transports: transports,
			gatewayHub: hub,
		},
		MaxConcurrent: 1,
		RetryDelay:    func(int) time.Duration { return time.Second },
	})
	if err != nil {
		t.Fatal(err)
	}

	snapshot := managedLifecycleSnapshot()
	result, err := registry.Apply(context.Background(), snapshot)
	if err != nil || !result.Accepted {
		t.Fatalf("Apply() = %#v, %v", result, err)
	}
	first := waitManagedTransport(t, transports)
	firstSession := waitManagedTransportStarted(t, first)
	waitManagedAgentState(t, registry, daemon.AgentStateRunning)
	waitManagedObservationState(t, observations, "running")
	firstStatus := registry.Status()[0]
	if firstStatus.Attempt != 7 || firstStatus.LaunchID == "" {
		t.Fatalf("first authoritative fence = %#v", firstStatus)
	}
	if _, err := os.Stat(filepath.Join(
		stateRoot, "agents", managedLifecycleAgentID, "launch-fence.json",
	)); !os.IsNotExist(err) {
		t.Fatalf("C-lite wrote a local Launch ledger: %v", err)
	}

	select {
	case <-first.closed:
		t.Fatal("managed Agent Host exited when Factory Start returned")
	case <-time.After(200 * time.Millisecond):
	}
	if starts := transports.starts.Load(); starts != 1 {
		t.Fatalf("IM starts = %d, want 1", starts)
	}
	first.events <- im.Event{
		ID:       "managed-stop-1",
		LaunchID: firstSession.LaunchID,
		Type:     im.EventStopped,
	}
	waitManagedAgentState(t, registry, daemon.AgentStateRetryWait)
	second := waitManagedTransport(t, transports)
	waitManagedTransportStarted(t, second)
	waitManagedAgentState(t, registry, daemon.AgentStateRunning)
	secondStatus := registry.Status()[0]
	if secondStatus.Attempt != firstStatus.Attempt ||
		secondStatus.LaunchID != firstStatus.LaunchID {
		t.Fatalf("IM reconnect replaced Runtime fence: %#v", secondStatus)
	}
	if starts := transports.starts.Load(); starts != 2 {
		t.Fatalf("IM starts after reconnect = %d, want 2", starts)
	}

	replacement := managedLifecycleSnapshot()
	replacement.Revision = 2
	replacement.Agents[0].ConfigGeneration = 2
	replacement.Agents[0].CredentialVersion = 2
	replacement.Agents[0].CurrentLaunch = &daemon.AssignmentLaunchFence{
		LaunchID: firstStatus.LaunchID, AssignmentEpoch: computerControllerEpoch,
		ConfigGeneration: 1, CredentialVersion: 1, Attempt: firstStatus.Attempt,
	}
	_, digest, err := daemon.CanonicalSnapshot(replacement)
	if err != nil {
		t.Fatal(err)
	}
	replacement.SnapshotHash = encodeRawURLBase64(digest[:])
	if result, applyErr := registry.Apply(
		context.Background(), replacement,
	); applyErr != nil || !result.Accepted {
		t.Fatalf("replacement Apply() = %#v, %v", result, applyErr)
	}
	third := waitManagedTransport(t, transports)
	waitManagedTransportStarted(t, third)
	waitManagedAgentState(t, registry, daemon.AgentStateRunning)
	thirdStatus := registry.Status()[0]
	if thirdStatus.Attempt != 8 || thirdStatus.LaunchID == "" ||
		thirdStatus.LaunchID == firstStatus.LaunchID {
		t.Fatalf("replacement authoritative fence = %#v", thirdStatus)
	}

	closeContext, cancelClose := context.WithTimeout(
		context.Background(),
		5*time.Second,
	)
	defer cancelClose()
	if err := registry.Close(closeContext); err != nil {
		t.Fatal(err)
	}
	select {
	case <-third.closed:
	case <-time.After(time.Second):
		t.Fatal("managed Agent IM did not close with Registry")
	}
	if closes := transports.closes.Load(); closes != 3 {
		t.Fatalf("IM closes = %d, want 3", closes)
	}
}

func TestManagedAgentCloseKeepsWaitingAfterEarlierTimeout(t *testing.T) {
	t.Parallel()

	runtimes := managedLifecycleRuntimes(t)
	governor, err := daemon.NewLaunchGovernor(daemon.LaunchGovernorConfig{
		MinimumInterval: time.Nanosecond,
		Jitter:          func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer governor.Close()
	actor, err := runtimeactor.New(runtimeactor.Options{
		AgentID: managedLifecycleAgentID,
		Runtimes: &governedResolver{
			next:     runtimes,
			governor: governor,
			timeout:  60 * time.Second,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	factory := &managedAgentFactory{root: t.TempDir(), gatewayHub: hub}
	gateway, err := factory.registerGateway(
		managedLifecycleSnapshot().Agents[0],
		daemon.Fence{LaunchID: "018f0c9e-7b17-7abc-8def-0123456789ab"},
		agentgateway.NewTransportSlot(),
	)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	instance := &managedAgentInstance{
		ready:   make(chan struct{}),
		health:  make(chan daemon.AgentHealth),
		done:    done,
		gateway: gateway,
		actor:   actor,
	}
	firstContext, cancelFirst := context.WithCancel(context.Background())
	cancelFirst()
	if err := instance.Close(firstContext); !errors.Is(err, context.Canceled) {
		t.Fatalf("first Close() error = %v, want context canceled", err)
	}
	secondContext, cancelSecond := context.WithTimeout(
		context.Background(),
		20*time.Millisecond,
	)
	defer cancelSecond()
	if err := instance.Close(secondContext); !errors.Is(
		err,
		context.DeadlineExceeded,
	) {
		t.Fatalf("second Close() error = %v, want deadline exceeded", err)
	}
	close(done)
	if err := instance.Close(context.Background()); err != nil {
		t.Fatalf("final Close() error = %v", err)
	}
}

func TestManagedAgentCleanupCanRetryAfterObserverTimeout(t *testing.T) {
	t.Parallel()

	runtimes := managedLifecycleRuntimes(t)
	governor, err := daemon.NewLaunchGovernor(daemon.LaunchGovernorConfig{
		MinimumInterval: time.Nanosecond,
		Jitter:          func() time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer governor.Close()
	actor, err := runtimeactor.New(runtimeactor.Options{
		AgentID: managedLifecycleAgentID,
		Runtimes: &governedResolver{
			next: runtimes, governor: governor, timeout: 60 * time.Second,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	hub, err := agentgateway.NewHub()
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close(context.Background())
	factory := &managedAgentFactory{root: t.TempDir(), gatewayHub: hub}
	gateway, err := factory.registerGateway(
		managedLifecycleSnapshot().Agents[0],
		daemon.Fence{LaunchID: "018f0c9e-7b17-7abc-8def-0123456789ab"},
		agentgateway.NewTransportSlot(),
	)
	if err != nil {
		t.Fatal(err)
	}
	observerContext, cancelObserver := context.WithCancel(context.Background())
	observerDone := make(chan struct{})
	observer := &managedAgentObserver{
		ctx: observerContext, cancel: cancelObserver,
		done: observerDone, wake: make(chan struct{}, 1), fatal: make(chan error, 1),
		now: time.Now,
	}
	done := make(chan struct{})
	close(done)
	instance := &managedAgentInstance{
		done: done, gateway: gateway, actor: actor,
		observer: observer,
	}
	firstContext, cancelFirst := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelFirst()
	if err := instance.Close(firstContext); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Close() error = %v, want deadline exceeded", err)
	}
	close(observerDone)
	if err := instance.Close(context.Background()); err != nil {
		t.Fatalf("retry Close() error = %v", err)
	}
}

func TestManagedAgentSessionsConsumeAllocatedSessionThenRefreshFence(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	revisions := make(chan int64, 2)
	server := newManagedLifecyclePlatform(t, now, revisions)
	defer server.Close()
	client, err := platform.NewClient(platform.Config{
		BaseURL:               server.URL + "/v1",
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := platform.NewComputerCredential(controllerCredential())
	if err != nil {
		t.Fatal(err)
	}
	sessions := &computerSessionManager{
		client:     client,
		credential: credential,
		now:        func() time.Time { return now },
	}
	assignment := managedLifecycleSnapshot().Agents[0]
	lease := daemon.NewAssignmentLease(
		computerControllerEpoch,
		1,
		assignment,
	)
	computerSession, err := sessions.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	launchID := "018f0c9e-7b17-7abc-8def-0123456789ab"
	allocated, err := client.CreateComputerAgentLaunch(
		context.Background(), computerSession.AccessToken,
		platform.ComputerAgentLaunchRequest{
			LaunchID: launchID, AssignmentEpoch: computerControllerEpoch,
			AssignmentRevision: 1, ConfigGeneration: 1,
			CredentialVersion: 1,
		},
		assignment,
	)
	if err != nil {
		t.Fatal(err)
	}
	provider := &managedAgentSessions{
		client: client, sessions: sessions, lease: lease,
		fence: allocated.Fence, initial: allocated.Session,
	}
	if _, err := provider.CreateRuntimeSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !lease.Advance(computerControllerEpoch, 2, assignment) {
		t.Fatal("AssignmentLease refused monotonic revision")
	}
	if _, err := provider.CreateRuntimeSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	for index, want := range []int64{1, -7} {
		select {
		case got := <-revisions:
			if got != want {
				t.Fatalf("launch request %d marker = %d, want %d", index+1, got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("session request %d was not observed", index+1)
		}
	}
}

func newManagedLifecyclePlatform(
	t *testing.T,
	now time.Time,
	revisions chan<- int64,
	observationSinks ...chan<- platform.ComputerAgentObservation,
) *httptest.Server {
	return newManagedLifecyclePlatformWithStartingGate(
		t, now, revisions, nil, observationSinks...,
	)
}

func newManagedLifecyclePlatformWithStartingGate(
	t *testing.T,
	now time.Time,
	revisions chan<- int64,
	startingGate <-chan struct{},
	observationSinks ...chan<- platform.ComputerAgentObservation,
) *httptest.Server {
	t.Helper()
	var launchMu sync.Mutex
	var currentLaunchID string
	var currentAttempt int64 = 6
	return httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/v1/computer/session":
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
			case "/v1/runtime/directory":
				if request.Method != http.MethodGet ||
					request.Header.Get("Authorization") != "Bearer agent-access-test" {
					http.Error(response, "bad runtime directory", http.StatusUnauthorized)
					return
				}
				writeControllerJSON(t, response, map[string]any{
					"server": map[string]any{
						"id": computerControllerServerID, "slug": "lifecycle", "name": "Lifecycle",
					},
					"self": map[string]any{
						"agentId": managedLifecycleAgentID, "memberId": managedLifecycleAgentID,
						"handle": "lifecycle-agent", "displayName": "Lifecycle Agent",
						"imUserId": "im_agent_lifecycle",
					},
					"channels": []any{},
					"members": []any{map[string]any{
						"memberId": managedLifecycleAgentID, "kind": "agent",
						"agentId": managedLifecycleAgentID, "handle": "lifecycle-agent",
						"displayName": "Lifecycle Agent", "imUserId": "im_agent_lifecycle",
					}},
					"revision":  "sha256:lifecycle",
					"expiresAt": now.Add(15 * time.Minute),
				})
			case "/v1/computer/agents/" + managedLifecycleAgentID + "/launches":
				var body platform.ComputerAgentLaunchRequest
				if err := common.DecodeJson(request.Body, &body); err != nil {
					http.Error(response, "bad request", http.StatusBadRequest)
					return
				}
				if revisions != nil {
					revisions <- body.AssignmentRevision
				}
				launchMu.Lock()
				if body.LaunchID != currentLaunchID {
					if currentLaunchID == "" {
						if body.PredecessorLaunchID != nil {
							launchMu.Unlock()
							http.Error(response, "bad predecessor", http.StatusConflict)
							return
						}
					} else if body.PredecessorLaunchID == nil ||
						*body.PredecessorLaunchID != currentLaunchID {
						launchMu.Unlock()
						http.Error(response, "bad predecessor", http.StatusConflict)
						return
					}
					currentLaunchID = body.LaunchID
					currentAttempt++
				}
				attempt := currentAttempt
				launchMu.Unlock()
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"launch": map[string]any{
						"launchId":          body.LaunchID,
						"assignmentEpoch":   body.AssignmentEpoch,
						"configGeneration":  body.ConfigGeneration,
						"credentialVersion": body.CredentialVersion,
						"attempt":           attempt,
						"issuedAt":          now,
					},
					"session": managedLifecycleSessionPayload(now),
				})
			default:
				refreshPrefix := "/v1/computer/agents/" +
					managedLifecycleAgentID + "/launches/"
				if strings.HasPrefix(request.URL.Path, refreshPrefix) &&
					strings.HasSuffix(request.URL.Path, "/session") {
					var body platform.ComputerAgentSessionRefreshRequest
					if err := common.DecodeJson(request.Body, &body); err != nil {
						http.Error(response, "bad request", http.StatusBadRequest)
						return
					}
					launchID := strings.TrimSuffix(
						strings.TrimPrefix(request.URL.Path, refreshPrefix),
						"/session",
					)
					launchMu.Lock()
					valid := launchID == currentLaunchID &&
						body.Attempt == currentAttempt
					launchMu.Unlock()
					if !valid {
						http.Error(response, "stale launch", http.StatusConflict)
						return
					}
					if revisions != nil {
						revisions <- -body.Attempt
					}
					writeControllerJSON(t, response, managedLifecycleSessionPayload(now))
					return
				}
				if !strings.HasPrefix(
					request.URL.Path,
					"/v1/computer/agents/"+managedLifecycleAgentID+"/observations/",
				) {
					http.NotFound(response, request)
					return
				}
				if request.Method != http.MethodPut ||
					request.Header.Get("Authorization") !=
						"Bearer computer-access-test" {
					http.Error(response, "bad observation", http.StatusBadRequest)
					return
				}
				var observation platform.ComputerAgentObservation
				if err := common.DecodeJson(request.Body, &observation); err != nil {
					http.Error(response, "bad observation", http.StatusBadRequest)
					return
				}
				if len(observationSinks) > 0 && observationSinks[0] != nil {
					observationSinks[0] <- observation
				}
				if observation.State == "starting" && startingGate != nil {
					<-startingGate
				}
				response.WriteHeader(http.StatusNoContent)
			}
		},
	))
}

func managedLifecycleSessionPayload(now time.Time) map[string]any {
	return map[string]any{
		"accessToken": "agent-access-test",
		"expiresAt":   now.Add(15 * time.Minute),
		"agent": map[string]any{
			"id": managedLifecycleAgentID, "serverId": computerControllerServerID,
			"userId":       "im_agent_lifecycle",
			"capabilities": []string{"read", "send", "server"},
			"replyPolicy":  "mention_and_dm",
			"runtime":      map[string]any{"kind": "hermes-gateway", "model": nil},
		},
		"im": map[string]any{
			"sdkAppId": 1600000000, "userId": "im_agent_lifecycle",
			"userSig": "user-sig-lifecycle", "expiresAt": now.Add(15 * time.Minute),
		},
	}
}

func waitManagedObservationState(
	t *testing.T,
	observations <-chan platform.ComputerAgentObservation,
	want string,
) platform.ComputerAgentObservation {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case observation := <-observations:
			if observation.State == want {
				return observation
			}
		case <-deadline:
			t.Fatalf("managed Agent observation %q was not reported", want)
		}
	}
}

func managedLifecycleSnapshot() daemon.Snapshot {
	snapshot := daemon.Snapshot{
		SchemaVersion: daemon.AssignmentSchemaVersion,
		ComputerID:    computerControllerID,
		Epoch:         computerControllerEpoch,
		Revision:      1,
		Agents: []daemon.AgentAssignment{{
			AgentID:           managedLifecycleAgentID,
			ServerID:          computerControllerServerID,
			DesiredState:      daemon.DesiredRunning,
			ConfigGeneration:  1,
			CredentialVersion: 1,
			Runtime:           daemon.RuntimeConfig{Kind: "hermes-gateway"},
			ReplyPolicy:       "mention_and_dm",
		}},
	}
	_, digest, _ := daemon.CanonicalSnapshot(snapshot)
	snapshot.SnapshotHash = encodeRawURLBase64(digest[:])
	return snapshot
}

func managedLifecycleRuntimes(t *testing.T) *runtimecatalog.Snapshot {
	t.Helper()
	catalog, err := runtimecatalog.New([]runtimeapi.Registration{{
		ID:          "hermes-gateway",
		DisplayName: "Fake Hermes",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return managedLifecycleRuntimeDriver{}, nil
		},
		Policy: runtimeapi.RuntimePolicy{
			BusyMode:   runtimeapi.BusyDeliveryGated,
			Completion: runtimeapi.CompletionEvent,
		},
		LaunchPlanner: runtimeapi.LaunchPlannerFunc(
			func(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
				return runtimeapi.LaunchPlan{}, nil
			},
		),
	}})
	if err != nil {
		t.Fatal(err)
	}
	return catalog.Snapshot(context.Background())
}

type managedLifecycleRuntimeDriver struct{}

func (managedLifecycleRuntimeDriver) Probe(
	context.Context,
) (runtimeapi.ProbeResult, error) {
	return runtimeapi.ProbeResult{Available: true}, nil
}

func (managedLifecycleRuntimeDriver) DetectModels(
	context.Context,
) (runtimeapi.ModelResult, error) {
	return runtimeapi.ModelResult{}, nil
}

func (managedLifecycleRuntimeDriver) Start(
	context.Context,
	runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	return nil, errors.New("fake Runtime must not start without a message")
}

type managedLifecycleTransportFactory struct {
	created chan *managedLifecycleTransport
	starts  atomic.Int64
	closes  atomic.Int64
}

func newManagedLifecycleTransportFactory() *managedLifecycleTransportFactory {
	return &managedLifecycleTransportFactory{
		created: make(chan *managedLifecycleTransport, 4),
	}
}

func (f *managedLifecycleTransportFactory) New() (im.Transport, error) {
	transport := &managedLifecycleTransport{
		factory: f,
		events:  make(chan im.Event),
		started: make(chan im.Session, 1),
		closed:  make(chan struct{}),
	}
	f.created <- transport
	return transport, nil
}

type managedLifecycleTransport struct {
	factory *managedLifecycleTransportFactory
	events  chan im.Event
	started chan im.Session
	closed  chan struct{}
	once    sync.Once
}

func (t *managedLifecycleTransport) Start(
	_ context.Context,
	session im.Session,
) error {
	t.factory.starts.Add(1)
	t.started <- session
	return nil
}

func (*managedLifecycleTransport) SendText(
	context.Context,
	im.SendTextRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (*managedLifecycleTransport) SendCustom(
	context.Context,
	im.SendCustomRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (t *managedLifecycleTransport) Events() <-chan im.Event {
	return t.events
}

func (*managedLifecycleTransport) UnreadConversations(
	context.Context,
) ([]im.UnreadConversation, error) {
	return nil, nil
}

func (*managedLifecycleTransport) History(
	context.Context,
	im.HistoryRequest,
) (im.HistoryPage, error) {
	return im.HistoryPage{Completed: true}, nil
}

func (*managedLifecycleTransport) MarkRead(
	context.Context,
	im.Conversation,
) error {
	return nil
}

func (t *managedLifecycleTransport) Close(context.Context) error {
	t.factory.closes.Add(1)
	t.once.Do(func() { close(t.closed) })
	return nil
}

func waitManagedTransport(
	t *testing.T,
	factory *managedLifecycleTransportFactory,
) *managedLifecycleTransport {
	t.Helper()
	select {
	case transport := <-factory.created:
		return transport
	case <-time.After(5 * time.Second):
		t.Fatal("managed Agent did not create IM Transport")
		return nil
	}
}

func waitManagedTransportStarted(
	t *testing.T,
	transport *managedLifecycleTransport,
) im.Session {
	t.Helper()
	select {
	case session := <-transport.started:
		return session
	case <-time.After(5 * time.Second):
		t.Fatal("managed Agent IM Transport did not start")
		return im.Session{}
	}
}

func waitManagedAgentState(
	t *testing.T,
	registry *daemon.Registry,
	want daemon.AgentState,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		statuses := registry.Status()
		if len(statuses) == 1 && statuses[0].State == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Agent state = %#v, want %s", statuses, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type testDiscardWriter struct{}

func (testDiscardWriter) Write(value []byte) (int, error) {
	return len(value), nil
}
