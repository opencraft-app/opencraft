package bootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	"chatserver/internal/ent/computerruntimecredential"
	tencentimport "chatserver/internal/ports/tencentim"
)

const (
	computerAPIServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	computerAPIComputerID   = "01989c24-7540-7f12-a27b-c83243215dd5"
	computerAPICredentialID = "01989c24-7540-7f12-a27b-c83243215dd6"
	computerAPIEpoch        = "01989c24-7540-7f12-a27b-c83243215dd7"
	computerAPIAgentID      = "01989c24-7540-7f12-a27b-c83243215dd8"
	computerAPIMemberID     = "01989c24-7540-7f12-a27b-c83243215dd9"
	computerAPISecret       = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	computerAPICredential   = "crc_" + computerAPIServerID + "." +
		computerAPIComputerID + ".1." + computerAPISecret
)

func TestComputerAPIExchangesCredentialAndRejectsRevokedVersion(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	now := time.Now().UTC()
	digest := sha256.Sum256([]byte(computerAPISecret))
	if _, err := handle.Client().Computer.Create().
		SetID(computerAPIComputerID).
		SetServerID(computerAPIServerID).
		SetName("Canary Computer").
		SetTatRegion("ap-guangzhou").
		SetTatInstanceID("rins-canary").
		SetTatInstanceKind("managed").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetAssignmentEpoch(computerAPIEpoch).
		SetAssignmentRevision(3).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ComputerRuntimeCredential.Create().
		SetID(computerAPICredentialID).
		SetServerID(computerAPIServerID).
		SetComputerID(computerAPIComputerID).
		SetVersion(1).
		SetSecretHash(digest[:]).
		SetState("active").
		SetExpiresAt(now.Add(24 * time.Hour)).
		SetCreatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(computerAPIAgentID).
		SetServerID(computerAPIServerID).
		SetImUserID("a_computer_canary").
		SetComputerID(computerAPIComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("starting").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(computerAPIMemberID).
		SetRevision(2).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	agentCredentialDigest := sha256.Sum256([]byte("agent-runtime-credential"))
	if _, err := handle.Client().AgentRuntimeCredential.Create().
		SetID("01989c24-7540-7f12-a27b-c83243215dda").
		SetServerID(computerAPIServerID).
		SetAgentID(computerAPIAgentID).
		SetVersion(1).
		SetSecretHash(agentCredentialDigest[:]).
		SetState("active").
		SetCreatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler, err := NewComputerAPIHandler(ComputerAPIConfig{
		Database:       handle,
		AccessTokenKey: bytes.Repeat([]byte{0x74}, 32),
		AccessTTL:      15 * time.Minute,
		SDKAppID:       1600000000,
		UserSigTTL:     time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{result: tencentimport.UserSig{
			Value: "computer-agent-usersig", ExpiresAt: now.Add(time.Hour),
		}},
		RequestTimeout: 5 * time.Second,
		MaxBodyBytes:   16 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := performComputerRequest(handler, computerAPICredential)
	if response.Code != http.StatusCreated {
		t.Fatalf("computer session status=%d body=%s", response.Code, response.Body)
	}
	assertSensitiveHeaders(t, response)
	var session openapi.ComputerSession
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.AccessToken == nil || strings.TrimSpace(*session.AccessToken) == "" ||
		session.Computer.Id.String() != computerAPIComputerID ||
		session.Computer.ServerId.String() != computerAPIServerID ||
		session.Computer.CredentialVersion != 1 ||
		session.Computer.AssignmentEpoch.String() != computerAPIEpoch ||
		session.Computer.AssignmentRevision != 3 ||
		len(session.AssignmentVersions) != 1 || session.AssignmentVersions[0] != 1 {
		t.Fatalf("computer session = %#v", session)
	}
	rotateRequest := httptest.NewRequest(
		http.MethodPost,
		"/v1/computer/credential:rotate",
		nil,
	)
	rotateRequest.RemoteAddr = "127.0.0.1:12345"
	rotateRequest.Header.Set("Authorization", "Bearer "+*session.AccessToken)
	rotateRequest.Header.Set("Idempotency-Key", "computer-rotate-0001")
	rotateResponse := httptest.NewRecorder()
	handler.ServeHTTP(rotateResponse, rotateRequest)
	if rotateResponse.Code != http.StatusCreated {
		t.Fatalf("rotate status=%d body=%s", rotateResponse.Code, rotateResponse.Body)
	}
	assertSensitiveHeaders(t, rotateResponse)
	var rotatedCredential openapi.ComputerRuntimeCredential
	if err := json.Unmarshal(rotateResponse.Body.Bytes(), &rotatedCredential); err != nil {
		t.Fatal(err)
	}
	if rotatedCredential.Version != 2 || rotatedCredential.Secret == nil ||
		*rotatedCredential.Secret == "" || rotatedCredential.GraceExpiresAt == nil {
		t.Fatalf("rotated credential = %#v", rotatedCredential)
	}
	newSession := performComputerRequest(handler, *rotatedCredential.Secret)
	if newSession.Code != http.StatusCreated {
		t.Fatalf("new credential session status=%d body=%s", newSession.Code, newSession.Body)
	}
	var currentSession openapi.ComputerSession
	if err := json.Unmarshal(newSession.Body.Bytes(), &currentSession); err != nil {
		t.Fatal(err)
	}
	if currentSession.AccessToken == nil || *currentSession.AccessToken == "" {
		t.Fatalf("current Computer session = %#v", currentSession)
	}
	oldGraceSession := performComputerRequest(handler, computerAPICredential)
	if oldGraceSession.Code != http.StatusCreated {
		t.Fatalf(
			"old grace credential session status=%d body=%s",
			oldGraceSession.Code,
			oldGraceSession.Body,
		)
	}
	assignments := performComputerAssignmentsRequest(
		handler,
		*session.AccessToken,
		"?sinceEpoch="+computerAPIEpoch+"&sinceRevision=2&waitSeconds=0&forceFull=false",
	)
	if assignments.Code != http.StatusOK {
		t.Fatalf("assignments status=%d body=%s", assignments.Code, assignments.Body)
	}
	var snapshot openapi.ComputerAssignmentSnapshot
	if err := json.Unmarshal(assignments.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.ComputerId.String() != computerAPIComputerID ||
		snapshot.Epoch.String() != computerAPIEpoch || snapshot.Revision != 3 ||
		len(snapshot.Agents) != 1 ||
		snapshot.Agents[0].AgentId.String() != computerAPIAgentID ||
		snapshot.Agents[0].ConfigGeneration != 2 ||
		len(snapshot.SnapshotHash) != 43 {
		t.Fatalf("assignment snapshot=%#v", snapshot)
	}
	unchanged := performComputerAssignmentsRequest(
		handler,
		*session.AccessToken,
		"?sinceEpoch="+computerAPIEpoch+"&sinceRevision=3&waitSeconds=0&forceFull=false",
	)
	if unchanged.Code != http.StatusNoContent ||
		unchanged.Header().Get("X-Assignment-Revision") != "3" {
		t.Fatalf("unchanged status=%d headers=%v body=%s", unchanged.Code, unchanged.Header(), unchanged.Body)
	}
	launchID := "01989c24-7540-7f12-a27b-c83243215dde"
	agentSessionResponse := performComputerJSONRequest(
		handler,
		http.MethodPost,
		"/v1/computer/agents/"+computerAPIAgentID+"/launches",
		"Bearer "+*currentSession.AccessToken,
		`{"launchId":"`+launchID+`","predecessorLaunchId":null,"assignmentEpoch":"`+computerAPIEpoch+`","assignmentRevision":3,"configGeneration":2,"credentialVersion":1}`,
	)
	if agentSessionResponse.Code != http.StatusCreated {
		t.Fatalf("Agent launch status=%d body=%s", agentSessionResponse.Code, agentSessionResponse.Body)
	}
	var agentSession openapi.ComputerAgentLaunch
	if err := json.Unmarshal(agentSessionResponse.Body.Bytes(), &agentSession); err != nil {
		t.Fatal(err)
	}
	if agentSession.Session.AccessToken == nil || *agentSession.Session.AccessToken == "" ||
		agentSession.Session.Agent.Id.String() != computerAPIAgentID ||
		agentSession.Session.Im.UserSig == nil ||
		*agentSession.Session.Im.UserSig != "computer-agent-usersig" ||
		agentSession.Launch.LaunchId.String() != launchID ||
		agentSession.Launch.Attempt != 1 {
		t.Fatalf("Agent launch=%#v", agentSession)
	}
	observationID := "01989c24-7540-7f12-a27b-c83243215ddf"
	observationResponse := performComputerJSONRequest(
		handler,
		http.MethodPut,
		"/v1/computer/agents/"+computerAPIAgentID+"/observations/"+observationID,
		"Bearer "+*currentSession.AccessToken,
		`{"assignmentEpoch":"`+computerAPIEpoch+`","assignmentRevision":3,"configGeneration":2,"credentialVersion":1,"attempt":1,"sequence":1,"launchId":"`+launchID+`","state":"running","imTransportState":"connected","observedAt":"`+now.Format(time.RFC3339Nano)+`"}`,
	)
	if observationResponse.Code != http.StatusOK {
		t.Fatalf("observation status=%d body=%s", observationResponse.Code, observationResponse.Body)
	}
	var observationResult openapi.ComputerObservationResult
	if err := json.Unmarshal(observationResponse.Body.Bytes(), &observationResult); err != nil {
		t.Fatal(err)
	}
	if !observationResult.Accepted || observationResult.Reason != openapi.Accepted {
		t.Fatalf("observation result = %#v", observationResult)
	}
	heartbeatResponse := performComputerJSONRequest(
		handler,
		http.MethodPost,
		"/v1/computer/heartbeat",
		"Bearer "+*currentSession.AccessToken,
		`{"heartbeatId":"01989c24-7540-7f12-a27b-c83243215dd1","daemonVersion":"1.0.0","daemonBuildId":"build-test","assignmentEpoch":"`+computerAPIEpoch+`","assignmentRevision":3,"tatState":"online","reconcile":{"state":"healthy"},"agents":[{"agentId":"`+computerAPIAgentID+`","assignmentEpoch":"`+computerAPIEpoch+`","configGeneration":2,"credentialVersion":1,"attempt":1,"launchId":"`+launchID+`"}]}`,
	)
	if heartbeatResponse.Code != http.StatusNoContent {
		t.Fatalf("heartbeat status=%d body=%s", heartbeatResponse.Code, heartbeatResponse.Body)
	}
	observedAgent, err := handle.Client().Agent.Get(context.Background(), computerAPIAgentID)
	if err != nil || observedAgent.ObservedState != "running" ||
		observedAgent.ObservedLaunchID == nil || *observedAgent.ObservedLaunchID != launchID ||
		observedAgent.HostLastSeenAt == nil {
		t.Fatalf("observed agent=%#v err=%v", observedAgent, err)
	}
	credential, err := handle.Client().ComputerRuntimeCredential.Query().Where(
		computerruntimecredential.IDEQ(computerAPICredentialID),
	).Only(context.Background())
	if err != nil || credential.LastUsedAt == nil {
		t.Fatalf("credential lastUsedAt=%v err=%v", credential.LastUsedAt, err)
	}
	if _, err := handle.Client().ComputerRuntimeCredential.UpdateOne(credential).
		SetState("revoked").
		SetRevokedAt(time.Now().UTC()).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	revoked := performComputerRequest(handler, computerAPICredential)
	assertAPIError(t, revoked, http.StatusUnauthorized, "computer_credential_invalid")
}

func performComputerJSONRequest(
	handler http.Handler,
	method string,
	path string,
	authorization string,
	body string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func performComputerAssignmentsRequest(
	handler http.Handler,
	token string,
	query string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/v1/computer/assignments"+query, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Vela-Assignment-Version", "1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func performComputerRequest(handler http.Handler, credential string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/computer/session", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "ComputerCredential "+credential)
	request.Header.Set("X-Vela-Assignment-Version", "1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}
