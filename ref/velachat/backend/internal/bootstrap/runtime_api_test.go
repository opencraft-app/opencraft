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

	tokenadapter "chatserver/internal/adapters/token"
	"chatserver/internal/api/openapi"
	"chatserver/internal/database"
	"chatserver/internal/ent/agentruntimecredential"
	clockport "chatserver/internal/ports/clock"
	tencentimport "chatserver/internal/ports/tencentim"
	tokenport "chatserver/internal/ports/token"
)

const (
	runtimeAPIServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	runtimeAPIAgentID      = "01989c24-7540-7f12-a27b-c83243215dd4"
	runtimeAPIComputerID   = "01989c24-7540-7f12-a27b-c83243215dda"
	runtimeAPICredentialID = "01989c24-7540-7f12-a27b-c83243215ddb"
	runtimeAPIReminderID   = "01989c24-7540-7f12-a27b-c83243215ddc"
	runtimeAPIOccurrenceID = "01989c24-7540-7f12-a27b-c83243215ddd"
	runtimeAPITaskID       = "01989c24-7540-7f12-a27b-c83243215dde"
	runtimeAPIEpoch        = "01989c24-7540-7f12-a27b-c83243215ddf"
	runtimeAPILaunchID     = "01989c24-7540-7f12-a27b-c83243215df0"
	runtimeAPICredential   = "arc_" + runtimeAPIServerID + "." +
		runtimeAPIAgentID + ".7." +
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

func TestRuntimeAPIAcceptsLaunchBoundRuntimeBearer(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	seedRuntimeAPIFacts(t, handle)
	key := bytes.Repeat([]byte{0x54}, 32)
	issuer := &recordingUserSigIssuer{
		result: tencentimport.UserSig{
			Value:     "short-agent-usersig",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	}
	handler, err := NewRuntimeAPIHandler(RuntimeAPIConfig{
		Database:       handle,
		AccessTokenKey: key,
		AccessTTL:      15 * time.Minute,
		SDKAppID:       1600000000,
		UserSigTTL:     time.Hour,
		UserSigIssuer:  issuer,
		RequestTimeout: 5 * time.Second,
		MaxBodyBytes:   16 * 1024,
	})
	if err != nil {
		t.Fatalf("NewRuntimeAPIHandler() error = %v", err)
	}

	accessToken := signRuntimeAPILaunchToken(t, key)

	meResponse := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/me",
		"Bearer "+accessToken,
	)
	if meResponse.Code != http.StatusOK {
		t.Fatalf("runtime me status = %d body=%s", meResponse.Code, meResponse.Body)
	}
	var identity openapi.RuntimeIdentity
	if err := json.Unmarshal(meResponse.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	if identity.Id.String() != runtimeAPIAgentID ||
		identity.ServerId.String() != runtimeAPIServerID ||
		identity.UserId != "a_OPAQUE" ||
		identity.ReplyPolicy != "mention_and_dm" {
		t.Fatalf("runtime identity = %#v", identity)
	}
	assertRuntimeCapabilities(t, meResponse.Body.Bytes(), false)
	directoryV2Response := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/directory-v2",
		"Bearer "+accessToken,
	)
	if directoryV2Response.Code != http.StatusNotFound {
		t.Fatalf("runtime directory v2 status = %d body=%s", directoryV2Response.Code, directoryV2Response.Body)
	}
	var directoryError openapi.ErrorEnvelope
	if err := json.Unmarshal(directoryV2Response.Body.Bytes(), &directoryError); err != nil {
		t.Fatal(err)
	}
	if directoryError.Error.Code != "runtime_directory_not_found" {
		t.Fatalf("runtime directory v2 error = %#v", directoryError)
	}
	now := time.Now().UTC()
	if _, err := handle.Client().Task.Create().
		SetID(runtimeAPITaskID).
		SetServerID(runtimeAPIServerID).
		SetNumber(1).
		SetTitle("处理 Runtime Canary").
		SetStatus("todo").
		SetOwnerMemberID(runtimeAPIAgentID).
		SetAssignmentRevision(1).
		SetCreatedByMemberID(runtimeAPIAgentID).
		SetUpdatedByMemberID(runtimeAPIAgentID).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	taskListResponse := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/tasks",
		"Bearer "+accessToken,
	)
	if taskListResponse.Code != http.StatusOK {
		t.Fatalf("runtime tasks status = %d body=%s", taskListResponse.Code, taskListResponse.Body)
	}
	var runtimeTasks openapi.TaskPage
	if err := json.Unmarshal(taskListResponse.Body.Bytes(), &runtimeTasks); err != nil {
		t.Fatal(err)
	}
	if len(runtimeTasks.Items) != 1 || runtimeTasks.Items[0].Id.String() != runtimeAPITaskID || runtimeTasks.NextCursor != nil {
		t.Fatalf("runtime tasks = %#v", runtimeTasks)
	}
	claimResponse := performRuntimeJSONRequest(
		handler,
		http.MethodPost,
		"/v1/runtime/tasks/"+runtimeAPITaskID+"/claim",
		"Bearer "+accessToken,
		"",
		map[string]string{"Idempotency-Key": "runtime-task-claim-1"},
	)
	if claimResponse.Code != http.StatusOK {
		t.Fatalf("runtime task claim status = %d body=%s", claimResponse.Code, claimResponse.Body)
	}
	var claimedTask openapi.Task
	if err := json.Unmarshal(claimResponse.Body.Bytes(), &claimedTask); err != nil {
		t.Fatal(err)
	}
	if claimedTask.Status != "in_progress" || claimedTask.Revision != 2 {
		t.Fatalf("claimed task = %#v", claimedTask)
	}
	updateTaskResponse := performRuntimeJSONRequest(
		handler,
		http.MethodPatch,
		"/v1/runtime/tasks/"+runtimeAPITaskID,
		"Bearer "+accessToken,
		`{"status":"done"}`,
		map[string]string{
			"Idempotency-Key":     "runtime-task-update-1",
			"X-Resource-Revision": "2",
		},
	)
	if updateTaskResponse.Code != http.StatusOK {
		t.Fatalf("runtime task update status = %d body=%s", updateTaskResponse.Code, updateTaskResponse.Body)
	}
	var completedTask openapi.Task
	if err := json.Unmarshal(updateTaskResponse.Body.Bytes(), &completedTask); err != nil {
		t.Fatal(err)
	}
	if completedTask.Status != "done" || completedTask.Revision != 3 {
		t.Fatalf("completed task = %#v", completedTask)
	}
	fireAt := time.Now().UTC().Add(-time.Minute)
	if _, err := handle.Client().ReminderOccurrence.Create().
		SetID(runtimeAPIOccurrenceID).
		SetServerID(runtimeAPIServerID).
		SetReminderID(runtimeAPIReminderID).
		SetAgentID(runtimeAPIAgentID).
		SetScheduledFireAt(fireAt).
		SetState("due").
		SetTextSnapshot("运行时提醒").
		SetCreatedAt(fireAt).
		SetUpdatedAt(fireAt).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	listResponse := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/reminder-occurrences?limit=10",
		"Bearer "+accessToken,
	)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("runtime reminders status = %d body=%s", listResponse.Code, listResponse.Body)
	}
	var occurrences openapi.ReminderOccurrencePage
	if err := json.Unmarshal(listResponse.Body.Bytes(), &occurrences); err != nil {
		t.Fatal(err)
	}
	if len(occurrences.Items) != 1 ||
		occurrences.Items[0].Id.String() != runtimeAPIOccurrenceID ||
		occurrences.Items[0].Text != "运行时提醒" || occurrences.NextCursor != nil {
		t.Fatalf("runtime occurrences = %#v", occurrences)
	}
	ackResponse := performRuntimeJSONRequest(
		handler,
		http.MethodPost,
		"/v1/runtime/reminder-occurrences/"+runtimeAPIOccurrenceID+"/ack",
		"Bearer "+accessToken,
		`{"resultCode":"handled"}`,
		map[string]string{"Idempotency-Key": "runtime-ack-1"},
	)
	if ackResponse.Code != http.StatusOK {
		t.Fatalf("runtime reminder ack status = %d body=%s", ackResponse.Code, ackResponse.Body)
	}
	var acknowledged openapi.ReminderOccurrence
	if err := json.Unmarshal(ackResponse.Body.Bytes(), &acknowledged); err != nil {
		t.Fatal(err)
	}
	if acknowledged.State != "acknowledged" ||
		acknowledged.ResultCode == nil ||
		*acknowledged.ResultCode != "handled" {
		t.Fatalf("acknowledged occurrence = %#v", acknowledged)
	}
}

func performRuntimeJSONRequest(
	handler http.Handler,
	method string,
	path string,
	authorization string,
	body string,
	headers map[string]string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestRuntimeAPIReturnsHermesGatewayIdentity(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	seedRuntimeAPIFactsWithKind(t, handle, "hermes-gateway")
	key := bytes.Repeat([]byte{0x54}, 32)
	handler, err := NewRuntimeAPIHandler(RuntimeAPIConfig{
		Database:       handle,
		AccessTokenKey: key,
		AccessTTL:      15 * time.Minute,
		SDKAppID:       1600000000,
		UserSigTTL:     time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{
			result: tencentimport.UserSig{
				Value:     "short-agent-usersig",
				ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
		},
		RequestTimeout: 5 * time.Second,
		MaxBodyBytes:   16 * 1024,
	})
	if err != nil {
		t.Fatalf("NewRuntimeAPIHandler() error = %v", err)
	}

	response := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/me",
		"Bearer "+signRuntimeAPILaunchToken(t, key),
	)
	if response.Code != http.StatusOK {
		t.Fatalf(
			"Hermes runtime identity status = %d body=%s",
			response.Code,
			response.Body,
		)
	}
	var identity openapi.RuntimeIdentity
	if err := json.Unmarshal(response.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	if identity.Runtime.Kind != "hermes-gateway" {
		t.Fatalf("Hermes runtime kind = %q", identity.Runtime.Kind)
	}
}

func assertRuntimeCapabilities(t *testing.T, body []byte, nested bool) {
	t.Helper()
	var payload struct {
		Capabilities []string `json:"capabilities"`
		Agent        *struct {
			Capabilities []string `json:"capabilities"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	capabilities := payload.Capabilities
	if nested {
		if payload.Agent == nil {
			t.Fatalf("runtime session lacks agent: %s", body)
		}
		capabilities = payload.Agent.Capabilities
	}
	want := []string{
		"read", "send", "server", "channels", "threads", "tasks",
		"reactions", "attachments", "reminders",
	}
	if len(capabilities) != len(want) {
		t.Fatalf("runtime capabilities = %#v, want %#v", capabilities, want)
	}
	for index := range want {
		if capabilities[index] != want[index] {
			t.Fatalf("runtime capabilities = %#v, want %#v", capabilities, want)
		}
	}
}

func TestRuntimeAPIRejectsWrongSchemeAndRevokedLaunchCredential(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	seedRuntimeAPIFacts(t, handle)
	key := bytes.Repeat([]byte{0x54}, 32)
	handler, err := NewRuntimeAPIHandler(RuntimeAPIConfig{
		Database:       handle,
		AccessTokenKey: key,
		AccessTTL:      15 * time.Minute,
		SDKAppID:       1600000000,
		UserSigTTL:     time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{
			result: tencentimport.UserSig{
				Value:     "short-agent-usersig",
				ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
		},
		RequestTimeout: 5 * time.Second,
		MaxBodyBytes:   16 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	wrongScheme := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/me",
		"AgentCredential "+runtimeAPICredential,
	)
	assertAPIError(
		t,
		wrongScheme,
		http.StatusUnauthorized,
		"runtime_credential_invalid",
	)
	if _, err := handle.Client().AgentRuntimeCredential.Update().
		Where(
			agentruntimecredential.IDEQ(runtimeAPICredentialID),
		).
		SetState("revoked").
		SetRevokedAt(time.Now().UTC()).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	revoked := performRuntimeRequest(
		handler,
		http.MethodGet,
		"/v1/runtime/me",
		"Bearer "+signRuntimeAPILaunchToken(t, key),
	)
	assertAPIError(
		t,
		revoked,
		http.StatusUnauthorized,
		"runtime_credential_revoked",
	)
}

func signRuntimeAPILaunchToken(t *testing.T, key []byte) string {
	t.Helper()
	now := time.Now().UTC()
	claims, err := tokenport.NewRuntimeLaunchClaims(
		runtimeAPIServerID,
		runtimeAPIComputerID,
		runtimeAPIAgentID,
		runtimeAPILaunchID,
		runtimeAPIEpoch,
		1,
		7,
		1,
		now.Add(-time.Minute),
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := tokenadapter.NewHMACJWT(key, clockport.System{})
	if err != nil {
		t.Fatal(err)
	}
	value, err := signer.Sign(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func performRuntimeRequest(
	handler http.Handler,
	method string,
	path string,
	authorization string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func seedRuntimeAPIFacts(t *testing.T, handle *database.Handle) {
	t.Helper()
	seedRuntimeAPIFactsWithKind(t, handle, "codex")
}

func seedRuntimeAPIFactsWithKind(
	t *testing.T,
	handle *database.Handle,
	runtimeKind string,
) {
	t.Helper()
	now := time.Now().UTC()
	if _, err := handle.Client().Computer.Create().
		SetID(runtimeAPIComputerID).
		SetServerID(runtimeAPIServerID).
		SetName("Runtime API 测试机").
		SetTatRegion("ap-beijing").
		SetTatInstanceID("ins-test-only").
		SetTatInstanceKind("cvm").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetAssignmentEpoch(runtimeAPIEpoch).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(runtimeAPIAgentID).
		SetServerID(runtimeAPIServerID).
		SetImUserID("a_OPAQUE").
		SetComputerID(runtimeAPIComputerID).
		SetRuntimeKind(runtimeKind).
		SetRuntimeModel("default").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("starting").
		SetCredentialVersion(7).
		SetImState("ready").
		SetCurrentLaunchID(runtimeAPILaunchID).
		SetCurrentLaunchAssignmentEpoch(runtimeAPIEpoch).
		SetCurrentLaunchGeneration(1).
		SetCurrentLaunchCredentialVersion(7).
		SetCurrentLaunchAttempt(1).
		SetCurrentLaunchUpdatedAt(now).
		SetCreatedByMemberID("01989c24-7540-7f12-a27b-c83243215dd8").
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(runtimeAPICredential))
	if _, err := handle.Client().AgentRuntimeCredential.Create().
		SetID(runtimeAPICredentialID).
		SetServerID(runtimeAPIServerID).
		SetAgentID(runtimeAPIAgentID).
		SetVersion(7).
		SetSecretHash(digest[:]).
		SetState("active").
		SetCreatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}
