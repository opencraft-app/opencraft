package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/daemon"
)

const (
	computerTestServerID = "018f0c9e-7b10-7abc-8def-0123456789ab"
	computerTestID       = "018f0c9e-7b12-7abc-8def-0123456789ab"
	computerTestEpoch    = "018f0c9e-7b13-7abc-8def-0123456789ab"
	computerTestAgentID  = "018f0c9e-7b14-7abc-8def-0123456789ab"
)

func TestComputerClientSessionAndAssignment(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 31, 0, 0, 0, 0, time.UTC)
	snapshot := daemon.Snapshot{
		SchemaVersion: 1,
		ComputerID:    computerTestID,
		Epoch:         computerTestEpoch,
		Revision:      2,
		Agents: []daemon.AgentAssignment{{
			AgentID:           computerTestAgentID,
			ServerID:          computerTestServerID,
			DesiredState:      daemon.DesiredRunning,
			ConfigGeneration:  3,
			CredentialVersion: 1,
			Runtime: daemon.RuntimeConfig{
				Kind: "codex",
			},
			ReplyPolicy: "mention_and_dm",
		}},
	}
	_, digest, err := daemon.CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SnapshotHash = rawURLBase64(digest[:])
	var calls int
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			calls++
			response.Header().Set("Content-Type", "application/json")
			switch request.URL.Path {
			case "/v1/computer/session":
				if request.Method != http.MethodPost ||
					request.Header.Get("Authorization") !=
						"ComputerCredential "+computerCredentialFixture() ||
					request.Header.Get("X-Vela-Assignment-Version") != "1" {
					http.Error(response, "bad computer session", http.StatusBadRequest)
					return
				}
				response.WriteHeader(http.StatusCreated)
				writeComputerJSON(t, response, map[string]any{
					"accessToken": "computer-short-token",
					"expiresAt":   now.Add(15 * time.Minute),
					"computer": map[string]any{
						"id":                 computerTestID,
						"serverId":           computerTestServerID,
						"credentialVersion":  1,
						"assignmentEpoch":    computerTestEpoch,
						"assignmentRevision": 2,
					},
					"assignmentVersions": []int{1},
				})
			case "/v1/computer/assignments":
				if request.Method != http.MethodGet ||
					request.Header.Get("Authorization") !=
						"Bearer computer-short-token" {
					http.Error(response, "bad assignment auth", http.StatusBadRequest)
					return
				}
				assertAssignmentQuery(t, request.URL.Query())
				writeComputerJSON(t, response, snapshot)
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:               server.URL + "/v1",
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := NewComputerCredential(computerCredentialFixture())
	if err != nil {
		t.Fatal(err)
	}
	computerSession, err := client.CreateComputerSession(
		context.Background(),
		credential,
	)
	if err != nil {
		t.Fatal(err)
	}
	if computerSession.Computer.ID != computerTestID ||
		computerSession.AccessToken.Reveal() != "computer-short-token" {
		t.Fatalf("computer session = %#v", computerSession)
	}
	result, err := client.GetComputerAssignments(
		context.Background(),
		computerSession.AccessToken,
		ComputerAssignmentQuery{
			SinceEpoch:    computerTestEpoch,
			SinceRevision: 1,
			WaitSeconds:   25,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.NoChange || result.Snapshot == nil ||
		result.Snapshot.Revision != 2 {
		t.Fatalf("assignment result = %#v", result)
	}
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestComputerAssignmentsNoChange(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("X-Assignment-Revision", "7")
			response.WriteHeader(http.StatusNoContent)
		},
	))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:               server.URL,
		Now:                   time.Now,
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := newComputerAccessToken("computer-short-token")
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.GetComputerAssignments(
		context.Background(),
		token,
		ComputerAssignmentQuery{
			SinceEpoch:    computerTestEpoch,
			SinceRevision: 7,
			WaitSeconds:   25,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.NoChange || result.Revision != 7 || result.Snapshot != nil {
		t.Fatalf("result = %#v", result)
	}
}

func TestPutComputerAgentObservationAcceptsCurrentAndSurfacesStale(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 1, 12, 30, 0, 0, time.UTC)
	observationID := "018f0c9e-7b19-7abc-8def-0123456789ab"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			calls++
			if request.Method != http.MethodPut ||
				request.URL.Path != "/v1/computer/agents/"+
					computerTestAgentID+"/observations/"+observationID ||
				request.Header.Get("Authorization") !=
					"Bearer computer-short-token" {
				http.Error(response, "bad observation request", http.StatusBadRequest)
				return
			}
			var body ComputerAgentObservation
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body.AssignmentEpoch != computerTestEpoch ||
				body.AssignmentRevision != 4 ||
				body.ConfigGeneration != 7 ||
				body.CredentialVersion != 2 ||
				body.Attempt != 2 || body.Sequence != 5 ||
				body.LaunchID != "018f0c9e-7b17-7abc-8def-0123456789ab" ||
				body.State != "running" || body.IMTransportState != "connected" ||
				!body.ObservedAt.Equal(now) {
				t.Fatalf("observation body = %#v", body)
			}
			response.Header().Set("Content-Type", "application/json")
			if calls == 1 {
				writeComputerJSON(t, response, map[string]any{
					"accepted": true, "reason": "accepted",
					"current": map[string]any{
						"launchId": body.LaunchID, "attempt": 2, "sequence": 5,
					},
				})
				return
			}
			if calls == 3 {
				writeComputerJSON(t, response, map[string]any{
					"accepted": false, "reason": "older_sequence",
					"current": map[string]any{
						"launchId": body.LaunchID, "attempt": 2, "sequence": 6,
					},
				})
				return
			}
			writeComputerJSON(t, response, map[string]any{
				"accepted": false, "reason": "stale_launch",
				"current": map[string]any{
					"launchId": "018f0c9e-7b18-7abc-8def-0123456789ab",
					"attempt":  3, "sequence": 1,
				},
			})
		},
	))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:               server.URL + "/v1",
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := newComputerAccessToken("computer-short-token")
	if err != nil {
		t.Fatal(err)
	}
	observation := ComputerAgentObservation{
		AssignmentEpoch:    computerTestEpoch,
		AssignmentRevision: 4,
		ConfigGeneration:   7,
		CredentialVersion:  2,
		Attempt:            2,
		Sequence:           5,
		LaunchID:           "018f0c9e-7b17-7abc-8def-0123456789ab",
		State:              "running",
		IMTransportState:   "connected",
		ObservedAt:         now,
	}
	result, err := client.PutComputerAgentObservation(
		context.Background(), token, computerTestAgentID, observationID,
		observation,
	)
	if err != nil || result.Stale || !result.Accepted ||
		result.Current.Attempt != 2 || result.Current.Sequence != 5 {
		t.Fatalf("current observation = (%#v, %v)", result, err)
	}
	result, err = client.PutComputerAgentObservation(
		context.Background(), token, computerTestAgentID, observationID,
		observation,
	)
	if err != nil || !result.Stale || result.Accepted ||
		result.Reason != "stale_launch" || result.Current.Attempt != 3 {
		t.Fatalf("stale observation = (%#v, %v)", result, err)
	}
	result, err = client.PutComputerAgentObservation(
		context.Background(), token, computerTestAgentID, observationID,
		observation,
	)
	if err != nil || result.Stale || result.Accepted ||
		result.Reason != "older_sequence" || result.Current.Sequence != 6 {
		t.Fatalf("older observation = (%#v, %v)", result, err)
	}
}

func computerCredentialFixture() string {
	return "crc_" + computerTestServerID + "." + computerTestID +
		".1.abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678"
}

func assertAssignmentQuery(t *testing.T, query url.Values) {
	t.Helper()
	if query.Get("sinceEpoch") != computerTestEpoch ||
		query.Get("sinceRevision") != "1" ||
		query.Get("waitSeconds") != "25" ||
		query.Get("forceFull") != "false" {
		t.Fatalf("assignment query = %s", query.Encode())
	}
}

func writeComputerJSON(
	t *testing.T,
	response http.ResponseWriter,
	value any,
) {
	t.Helper()
	encoded, err := common.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = response.Write(encoded)
}

func rawURLBase64(value []byte) string {
	return base64RawURLEncode(value)
}

func base64RawURLEncode(value []byte) string {
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
