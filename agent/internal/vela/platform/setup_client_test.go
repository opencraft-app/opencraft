package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

func TestManagedComputerSetupAPI(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Truncate(time.Second)
	serverID := "018f0c9e-7b10-7abc-8def-0123456789ab"
	computerID := "018f0c9e-7b12-7abc-8def-0123456789ab"
	credential := "crc_" + serverID + "." + computerID +
		".1.abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678"
	var calls int
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			calls++
			if request.Header.Get("Authorization") != "Bearer human-test" {
				http.Error(response, "bad auth", http.StatusUnauthorized)
				return
			}
			switch request.URL.Path {
			case "/v1/servers/" + serverID + "/computers":
				if request.Method != http.MethodPost ||
					request.Header.Get("Idempotency-Key") == "" {
					http.Error(response, "bad create request", 400)
					return
				}
				var payload map[string]any
				if err := common.DecodeJson(request.Body, &payload); err != nil {
					t.Error(err)
					return
				}
				if payload["tatInstanceKind"] != "managed" ||
					payload["osType"] != "macos" {
					t.Errorf("create payload = %#v", payload)
				}
				if _, exists := payload["tatRegion"]; exists {
					t.Errorf("managed create must not select region: %#v", payload)
				}
				writeSetupJSON(t, response, http.StatusCreated, map[string]any{
					"id": computerID, "serverId": serverID,
					"name": "开发机", "tatRegion": "ap-guangzhou",
					"tatInstanceId": nil, "tatInstanceKind": "managed",
					"osType": "macos", "lifecycleState": "provisioning",
					"tatAgentState": "unknown", "lastObservedAt": nil,
					"lastErrorCode": nil, "revision": 1,
				})
			case "/v1/servers/" + serverID + "/computers/" +
				computerID + "/registration":
				writeSetupJSON(t, response, http.StatusCreated, map[string]any{
					"computerId":        computerID,
					"protocol":          "tencent-tat-register-v1",
					"region":            "ap-guangzhou",
					"registerCodeId":    "register-id",
					"registerCodeValue": "register-value",
					"tags": []map[string]string{
						{"key": "VelaComputerID", "value": computerID},
					},
					"expiresAt": now.Add(10 * time.Minute),
				})
			case "/v1/servers/" + serverID + "/computers/" + computerID:
				writeSetupJSON(t, response, http.StatusOK, map[string]any{
					"id": computerID, "serverId": serverID,
					"name": "开发机", "tatRegion": "ap-guangzhou",
					"tatInstanceId":   "rins-test",
					"tatInstanceKind": "managed", "osType": "macos",
					"lifecycleState": "active", "tatAgentState": "online",
					"lastObservedAt": now, "lastErrorCode": nil,
					"revision": 2,
				})
			case "/v1/servers/" + serverID + "/computers/" +
				computerID + "/runtime-credentials":
				var payload struct {
					Mode string `json:"mode"`
				}
				if err := common.DecodeJson(request.Body, &payload); err != nil {
					t.Error(err)
					return
				}
				if payload.Mode != "bootstrap" {
					t.Errorf("credential mode = %q", payload.Mode)
				}
				writeSetupJSON(t, response, http.StatusCreated, map[string]any{
					"credentialId":   "018f0c9e-7b14-7abc-8def-0123456789ab",
					"version":        1,
					"secret":         credential,
					"expiresAt":      now.Add(365 * 24 * time.Hour),
					"graceExpiresAt": nil,
				})
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer server.Close()

	client, err := NewClient(Config{
		BaseURL:               server.URL + "/v1",
		HTTPClient:            server.Client(),
		AllowInsecureLoopback: true,
		Now:                   func() time.Time { return now },
		MaxSessionTTL:         24 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := NewHumanAccessToken([]byte("human-test"))
	if err != nil {
		t.Fatal(err)
	}
	defer token.Clear()
	computer, err := client.CreateManagedComputer(
		context.Background(),
		token,
		CreateManagedComputerRequest{
			ServerID:       serverID,
			Name:           "开发机",
			IdempotencyKey: "018f0c9e-7b15-7abc-8def-0123456789ab",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	registration, err := client.CreateComputerRegistration(
		context.Background(),
		token,
		serverID,
		computer.ID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(registration.Tags) != 1 ||
		registration.Tags[0].Key != "VelaComputerID" {
		t.Fatalf("registration = %#v", registration)
	}
	active, err := client.GetManagedComputer(
		context.Background(),
		token,
		serverID,
		computer.ID,
	)
	if err != nil || active.LifecycleState != "active" {
		t.Fatalf("active = %#v, %v", active, err)
	}
	issued, err := client.CreateComputerRuntimeCredential(
		context.Background(),
		token,
		serverID,
		computer.ID,
		"bootstrap",
		"018f0c9e-7b16-7abc-8def-0123456789ab",
	)
	if err != nil {
		t.Fatal(err)
	}
	if issued.Credential.Reveal() != credential {
		t.Fatal("credential mismatch")
	}
	if calls != 4 {
		t.Fatalf("calls = %d", calls)
	}
}

func writeSetupJSON(
	t *testing.T,
	response http.ResponseWriter,
	status int,
	value any,
) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	data, err := common.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = response.Write(data)
}
