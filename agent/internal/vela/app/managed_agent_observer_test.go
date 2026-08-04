package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/daemon"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
)

func TestManagedAgentObserverCloseDropsPendingStateBeforeInitialization(
	t *testing.T,
) {
	t.Parallel()

	observer := newManagedAgentObserver(
		nil,
		nil,
		nil,
		daemon.Fence{
			Epoch:            "018f0c9e-7b17-7abc-8def-0123456789ab",
			ConfigGeneration: 1,
			Attempt:          1,
			LaunchID:         "018f0c9e-7b18-7abc-8def-0123456789ab",
		},
		time.Now,
	)
	observer.Publish("stopping", nil)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := observer.FlushAndClose(ctx); err != nil {
		t.Fatalf("FlushAndClose() before Initialize error = %v", err)
	}
}

func TestManagedAgentObserverFlushCanRetryAfterEarlierDeadline(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 14, 0, 0, 0, time.UTC)
	var accept atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/v1/computer/session" {
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"accessToken": "computer-access-test",
					"expiresAt":   now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id": computerControllerID, "serverId": computerControllerServerID,
						"credentialVersion": 1, "assignmentEpoch": computerControllerEpoch,
						"assignmentRevision": 1,
					},
					"assignmentVersions": []int{1},
				})
				return
			}
			if !accept.Load() {
				http.Error(response, "retry", http.StatusServiceUnavailable)
				return
			}
			response.WriteHeader(http.StatusNoContent)
		},
	))
	defer server.Close()
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
	assignment := managedLifecycleSnapshot().Agents[0]
	lease := daemon.NewAssignmentLease(computerControllerEpoch, 1, assignment)
	fence := daemon.Fence{
		Epoch: computerControllerEpoch, ConfigGeneration: 1, Attempt: 7,
		LaunchID: "018f0c9e-7b17-7abc-8def-0123456789ab",
	}
	observer := newManagedAgentObserver(client, sessions, lease, fence, func() time.Time {
		return now
	})
	observer.Initialize(platform.ObservationCursor{
		AssignmentEpoch: fence.Epoch, ConfigGeneration: 1, Attempt: 7,
	})
	observer.Publish("running", nil)

	firstContext, cancelFirst := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelFirst()
	if err := observer.FlushAndClose(firstContext); !errors.Is(
		err, context.DeadlineExceeded,
	) {
		t.Fatalf("first FlushAndClose() error = %v", err)
	}
	accept.Store(true)
	secondContext, cancelSecond := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelSecond()
	if err := observer.FlushAndClose(secondContext); err != nil {
		t.Fatalf("retry FlushAndClose() error = %v", err)
	}
}

func TestManagedAgentObserverSurfacesStaleLaunchAsTerminal(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 14, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/v1/computer/session":
				response.WriteHeader(http.StatusCreated)
				writeControllerJSON(t, response, map[string]any{
					"accessToken": "computer-access-test",
					"expiresAt":   now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id": computerControllerID, "serverId": computerControllerServerID,
						"credentialVersion": 1, "assignmentEpoch": computerControllerEpoch,
						"assignmentRevision": 1,
					},
					"assignmentVersions": []int{1},
				})
			default:
				response.Header().Set("Content-Type", "application/json")
				writeControllerJSON(t, response, map[string]any{
					"accepted": false, "reason": "stale_launch",
					"current": map[string]any{
						"launchId": "018f0c9e-7b18-7abc-8def-0123456789ab",
						"attempt":  8, "sequence": 1,
					},
				})
			}
		},
	))
	defer server.Close()
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
	assignment := managedLifecycleSnapshot().Agents[0]
	lease := daemon.NewAssignmentLease(computerControllerEpoch, 1, assignment)
	fence := daemon.Fence{
		Epoch: computerControllerEpoch, ConfigGeneration: 1, Attempt: 7,
		LaunchID: "018f0c9e-7b17-7abc-8def-0123456789ab",
	}
	observer := newManagedAgentObserver(client, sessions, lease, fence, func() time.Time {
		return now
	})
	observer.Initialize(platform.ObservationCursor{
		AssignmentEpoch: fence.Epoch, ConfigGeneration: 1, Attempt: 7,
	})
	observer.Publish("running", nil)

	select {
	case fatal := <-observer.Fatal():
		if !errors.Is(fatal, ErrManagedAgentObservationStale) {
			t.Fatalf("fatal error = %v", fatal)
		}
	case <-time.After(time.Second):
		t.Fatal("stale observation did not terminate observer")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := observer.FlushAndClose(ctx); err != nil {
		t.Fatal(err)
	}
}
