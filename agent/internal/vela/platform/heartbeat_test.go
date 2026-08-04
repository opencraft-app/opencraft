package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

func TestSendComputerHeartbeat(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/v1/computer/heartbeat" ||
				request.Method != http.MethodPost ||
				request.Header.Get("Authorization") !=
					"Bearer computer-access-test" {
				http.Error(response, "bad request", http.StatusBadRequest)
				return
			}
			var heartbeat ComputerHeartbeat
			if err := common.DecodeJson(request.Body, &heartbeat); err != nil {
				t.Error(err)
				return
			}
			if heartbeat.TATState != "online" ||
				heartbeat.DaemonBuildID != "sha256:test-build" ||
				len(heartbeat.Agents) != 1 ||
				heartbeat.Agents[0].Attempt != 2 ||
				heartbeat.Agents[0].AssignmentEpoch !=
					"018f0c9e-7b13-7abc-8def-0123456789ab" ||
				heartbeat.Agents[0].CredentialVersion != 3 {
				t.Errorf("heartbeat = %#v", heartbeat)
			}
			response.WriteHeader(http.StatusNoContent)
		},
	))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:               server.URL + "/v1",
		HTTPClient:            server.Client(),
		AllowInsecureLoopback: true,
		Now:                   time.Now,
		MaxSessionTTL:         24 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := newComputerAccessToken("computer-access-test")
	if err != nil {
		t.Fatal(err)
	}
	err = client.SendComputerHeartbeat(
		context.Background(),
		token,
		ComputerHeartbeat{
			HeartbeatID:        "018f0c9e-7b18-7abc-8def-0123456789ab",
			DaemonVersion:      "test-version",
			DaemonBuildID:      "sha256:test-build",
			AssignmentEpoch:    "018f0c9e-7b13-7abc-8def-0123456789ab",
			AssignmentRevision: 3,
			TATState:           "online",
			Reconcile: ComputerHeartbeatReconcile{
				State: "healthy",
			},
			Agents: []ComputerHeartbeatAgent{{
				AgentID:           "018f0c9e-7b14-7abc-8def-0123456789ab",
				AssignmentEpoch:   "018f0c9e-7b13-7abc-8def-0123456789ab",
				ConfigGeneration:  7,
				CredentialVersion: 3,
				Attempt:           2,
				LaunchID:          "018f0c9e-7b19-7abc-8def-0123456789ab",
			}},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
}
