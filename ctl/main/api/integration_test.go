//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	popenclawgateway "ctl/pkg/adapter/openclawgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/config"
	instancelogic "ctl/pkg/instance"
	bundlelogic "ctl/pkg/logic/bundle"
	passlogic "ctl/pkg/logic/pass"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/model/operationhistory"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

type successEnvelope[T any] struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Data      T      `json:"data"`
}

type apiIntegrationHarness struct {
	server  *httptest.Server
	client  *http.Client
	sandbox *integrationSandboxAdapter
	aigw    *integrationAiGatewayAdapter
	userID  string
}

type integrationSandboxAdapter struct {
	mu      sync.Mutex
	counter int
}

func newAPIIntegrationHarness(t *testing.T) *apiIntegrationHarness {
	t.Helper()

	testutil.NewMySQLDB(t, "..", "..", "migrations")
	resource.ZapLogger = zap.NewNop()
	originalServerConf := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		APIConfig: &config.APIConfig{
			Instance: &config.InstanceAPIConfig{
				DefaultTemplateID:    "tpl-api-integration",
				CandidateTemplateIDs: []string{"tpl-api-integration"},
			},
		},
		AdapterConfig: &config.AdapterConfig{
			AiGateway: &config.AiGatewayConfig{
				DefaultGatewayPort: 18789,
			},
		},
		GlobalQuotaConfig: &config.GlobalQuotaConfig{
			ResourceDefaultQuotas: map[string]int64{
				"OPENCLAW_INSTANCE": 5,
			},
		},
	}
	config.ServerConf.MiscConfig.Region = "ap-beijing"
	t.Cleanup(func() {
		config.ServerConf = originalServerConf
	})

	userID := "usr_api_integration"
	ctx := testutil.NewContext(t, userID)
	sandbox := &integrationSandboxAdapter{}
	aigw := &integrationAiGatewayAdapter{}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		sandbox,
		aigw,
		modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx),
		zap.NewNop(),
		"tpl-api-integration",
	)

	originalFactory := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &apiIntegrationAdapterFactory{aigateway: aigw}
	t.Cleanup(func() {
		adapterfactory.DefaultAdapterFactory = originalFactory
	})

	server := httptest.NewServer(newRouter(
		&instanceHandler{logic: logic},
		&bundleHandler{logic: bundlelogic.NewLogic()},
		&passHandler{logic: passlogic.NewLogic()},
	))
	t.Cleanup(server.Close)

	return &apiIntegrationHarness{
		server:  server,
		client:  server.Client(),
		sandbox: sandbox,
		aigw:    aigw,
		userID:  userID,
	}
}

type apiIntegrationAdapterFactory struct {
	aigateway paigateway.Adapter
}

func (f *apiIntegrationAdapterFactory) SandboxAdapter() psandbox.Adapter                 { return nil }
func (f *apiIntegrationAdapterFactory) StsAdapter() sts.Adapter                          { return nil }
func (f *apiIntegrationAdapterFactory) WhitelistAdapter() whitelist.Adapter              { return nil }
func (f *apiIntegrationAdapterFactory) AiGatewayAdapter() paigateway.Adapter             { return f.aigateway }
func (f *apiIntegrationAdapterFactory) OpenClawGatewayAdapter() popenclawgateway.Adapter { return nil }
func (f *apiIntegrationAdapterFactory) ShadowAdapter() shadow.Adapter                    { return nil }

func (h *apiIntegrationHarness) request(t *testing.T, method, path string, body any, headers map[string]string) *http.Response {
	t.Helper()

	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		payload = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, h.server.URL+path, payload)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if _, ok := headers[headerUserID]; !ok {
		req.Header.Set(headerUserID, h.userID)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, path, err)
	}
	return resp
}

func decodeSuccessEnvelope[T any](t *testing.T, resp *http.Response) successEnvelope[T] {
	t.Helper()
	defer resp.Body.Close()

	var envelope successEnvelope[T]
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode success envelope: %v", err)
	}
	if envelope.Code != "OK" || envelope.Message != "success" {
		t.Fatalf("unexpected success envelope: %+v", envelope)
	}
	if envelope.RequestID == "" {
		t.Fatal("expected request_id in success envelope")
	}
	return envelope
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(body)
}

func waitForWeixinSession(t *testing.T, h *apiIntegrationHarness, instanceID, sessionID, expectedStatus string) transport.WeixinLoginSessionResponse {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp := h.request(t, http.MethodGet, "/v1/instances/"+instanceID+"/channels/weixin/login-sessions/"+sessionID, nil, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("unexpected weixin get status: %d", resp.StatusCode)
		}
		envelope := decodeSuccessEnvelope[transport.WeixinLoginSessionResponse](t, resp)
		if envelope.Data.Status == expectedStatus {
			return envelope.Data
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for weixin session status=%s", expectedStatus)
	return transport.WeixinLoginSessionResponse{}
}

func TestInstanceAPIIntegrationLifecycleAndAncillaryEndpoints(t *testing.T) {
	h := newAPIIntegrationHarness(t)

	healthResp := h.request(t, http.MethodGet, "/health", nil, map[string]string{headerUserID: ""})
	if healthResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected health status: %d", healthResp.StatusCode)
	}
	health := decodeSuccessEnvelope[map[string]string](t, healthResp)
	if health.Data["status"] != "ok" {
		t.Fatalf("unexpected health payload: %+v", health.Data)
	}

	soulResp := h.request(t, http.MethodGet, "/v1/soul-templates", nil, nil)
	if soulResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected soul templates status: %d", soulResp.StatusCode)
	}
	soulTemplates := decodeSuccessEnvelope[transport.ListSoulTemplatesResponse](t, soulResp)
	if len(soulTemplates.Data.Items) != 0 {
		t.Fatalf("expected no mounted soul templates in integration harness, got %+v", soulTemplates.Data.Items)
	}

	createResp := h.request(t, http.MethodPost, "/v1/instances", map[string]any{"timeout": 30, "name": "Integration Bot"}, nil)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected create status: %d", createResp.StatusCode)
	}
	create := decodeSuccessEnvelope[transport.InstanceResponse](t, createResp)
	if create.Data.InstanceID == "" || create.Data.SandboxID == "" {
		t.Fatalf("unexpected create payload: %+v", create.Data)
	}
	if create.Data.Status != "Running" {
		t.Fatalf("expected inline create to return Running, got %s", create.Data.Status)
	}
	if create.Data.Name != "Integration Bot" {
		t.Fatalf("expected persisted name, got %+v", create.Data)
	}
	instanceID := create.Data.InstanceID

	profile, err := modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(testutil.NewContext(t, h.userID)).GetByInstanceID(testutil.NewContext(t, h.userID), instanceID)
	if err != nil {
		t.Fatalf("expected birth profile to be projected after create, got error: %v", err)
	}
	if profile.BornDateForChina == "" || profile.BornNumberForChina != 1 {
		t.Fatalf("unexpected projected birth profile: %+v", profile)
	}

	listResp := h.request(t, http.MethodGet, "/v1/instances?page=1&page_size=20", nil, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected list status: %d", listResp.StatusCode)
	}
	list := decodeSuccessEnvelope[transport.ListInstancesResponse](t, listResp)
	if list.Data.Total < 1 || len(list.Data.Items) == 0 {
		t.Fatalf("unexpected list payload: %+v", list.Data)
	}
	found := false
	for _, item := range list.Data.Items {
		if item.InstanceID == instanceID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("instance %s missing from list response", instanceID)
	}

	updateResp := h.request(t, http.MethodPut, "/v1/instances/"+instanceID, map[string]any{"name": "Renamed Integration Bot"}, nil)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected update status: %d", updateResp.StatusCode)
	}
	updated := decodeSuccessEnvelope[transport.InstanceResponse](t, updateResp)
	if updated.Data.Name != "Renamed Integration Bot" {
		t.Fatalf("expected updated name, got %+v", updated.Data)
	}

	getResp := h.request(t, http.MethodGet, "/v1/instances/"+instanceID, nil, nil)
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected get status: %d", getResp.StatusCode)
	}
	got := decodeSuccessEnvelope[transport.InstanceResponse](t, getResp)
	if got.Data.InstanceID != instanceID || got.Data.Status != "Running" {
		t.Fatalf("unexpected get payload: %+v", got.Data)
	}
	if got.Data.Name != "Renamed Integration Bot" {
		t.Fatalf("expected get to return updated name, got %+v", got.Data)
	}

	debugResp := h.request(
		t,
		http.MethodPost,
		"/v1/instances/"+instanceID+"/debug/exec",
		map[string]any{"command": "openclaw_version"},
		nil,
	)
	if debugResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected debug status: %d", debugResp.StatusCode)
	}
	debug := decodeSuccessEnvelope[transport.ExecDebugCommandResponse](t, debugResp)
	if debug.Data.Status != "SUCCESS" || debug.Data.ExitCode != 0 {
		t.Fatalf("unexpected debug payload: %+v", debug.Data)
	}
	if !strings.Contains(strings.ToLower(debug.Data.Output), "openclaw version") {
		t.Fatalf("unexpected debug output: %q", debug.Data.Output)
	}

	configResp := h.request(
		t,
		http.MethodPost,
		"/v1/instances/"+instanceID+"/channels/config",
		map[string]any{"channel": "qqbot", "token": "123:secret", "account": "bot1"},
		nil,
	)
	if configResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected configure-channel status: %d", configResp.StatusCode)
	}
	channel := decodeSuccessEnvelope[transport.ConfigureChannelResponse](t, configResp)
	if channel.Data.Status != "Succeeded" || !channel.Data.GatewayRestarted {
		t.Fatalf("unexpected configure-channel payload: %+v", channel.Data)
	}
	if !strings.Contains(channel.Data.Output, "Added QQ Bot account") {
		t.Fatalf("unexpected configure-channel output: %q", channel.Data.Output)
	}

	pauseResp := h.request(t, http.MethodPost, "/v1/instances/"+instanceID+"/pause", nil, nil)
	if pauseResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected pause status: %d", pauseResp.StatusCode)
	}
	pause := decodeSuccessEnvelope[transport.InstanceResponse](t, pauseResp)
	if pause.Data.Status != "Paused" {
		t.Fatalf("unexpected pause payload: %+v", pause.Data)
	}

	logsResp := h.request(t, http.MethodGet, "/v1/instances/"+instanceID+"/logs?limit=50", nil, nil)
	if logsResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected logs status: %d", logsResp.StatusCode)
	}
	logs := decodeSuccessEnvelope[psandbox.SandboxLogs](t, logsResp)
	if len(logs.Data.Logs) != 1 {
		t.Fatalf("unexpected logs payload: %+v", logs.Data)
	}

	resumeResp := h.request(t, http.MethodPost, "/v1/instances/"+instanceID+"/resume", map[string]any{"timeout": 120}, nil)
	if resumeResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected resume status: %d", resumeResp.StatusCode)
	}
	resume := decodeSuccessEnvelope[transport.InstanceResponse](t, resumeResp)
	if resume.Data.Status != "Running" || resume.Data.TimeoutAt == nil {
		t.Fatalf("unexpected resume payload: %+v", resume.Data)
	}

	timeoutResp := h.request(t, http.MethodPost, "/v1/instances/"+instanceID+"/timeout", map[string]any{"timeout": 300}, nil)
	if timeoutResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected timeout status: %d", timeoutResp.StatusCode)
	}
	timeout := decodeSuccessEnvelope[transport.InstanceResponse](t, timeoutResp)
	if timeout.Data.Status != "Running" || timeout.Data.TimeoutAt == nil {
		t.Fatalf("unexpected timeout payload: %+v", timeout.Data)
	}

	opsResp := h.request(t, http.MethodGet, "/v1/instances/"+instanceID+"/operations?page=1&page_size=20", nil, nil)
	if opsResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected operations status: %d", opsResp.StatusCode)
	}
	ops := decodeSuccessEnvelope[transport.ListOperationsResponse](t, opsResp)
	if ops.Data.Total < 4 || len(ops.Data.Items) < 4 {
		t.Fatalf("unexpected operations payload: %+v", ops.Data)
	}
	seenTypes := map[string]bool{}
	for _, item := range ops.Data.Items {
		if item.InstanceID == instanceID {
			seenTypes[item.OperationType] = true
		}
	}
	for _, want := range []string{
		operationhistory.OperationTypeCreate,
		operationhistory.OperationTypePause,
		operationhistory.OperationTypeResume,
		operationhistory.OperationTypeSetTimeout,
	} {
		if !seenTypes[want] {
			t.Fatalf("missing operation type %s in %+v", want, ops.Data.Items)
		}
	}

	deleteResp := h.request(t, http.MethodDelete, "/v1/instances/"+instanceID, nil, nil)
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected delete status: %d", deleteResp.StatusCode)
	}
	deleted := decodeSuccessEnvelope[transport.InstanceResponse](t, deleteResp)
	if deleted.Data.Status != "Deleted" {
		t.Fatalf("unexpected delete payload: %+v", deleted.Data)
	}

	getAfterDeleteResp := h.request(t, http.MethodGet, "/v1/instances/"+instanceID, nil, nil)
	if getAfterDeleteResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected get after delete to return 404, got %d body=%s", getAfterDeleteResp.StatusCode, readBody(t, getAfterDeleteResp))
	}
}

func TestPassAPIIntegrationEnsureUserBeforeZeroCreditPass(t *testing.T) {
	h := newAPIIntegrationHarness(t)
	seedBundleForPass(t, "bundle_zero_credit", 0, "")

	resp := h.request(t, http.MethodPost, "/v1/passes", map[string]any{
		"bundle_id": "bundle_zero_credit",
	}, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected create pass status: %d body=%s", resp.StatusCode, readBody(t, resp))
	}
	created := decodeSuccessEnvelope[transport.PassResponse](t, resp)
	if created.Data.PassID == "" || created.Data.BundleID != "bundle_zero_credit" {
		t.Fatalf("unexpected pass response: %+v", created.Data)
	}

	h.aigw.mu.Lock()
	defer h.aigw.mu.Unlock()
	if h.aigw.ensureUserCalls != 1 {
		t.Fatalf("expected EnsureUser to be called once, got %d", h.aigw.ensureUserCalls)
	}
	if h.aigw.lastEnsureUserID != h.userID {
		t.Fatalf("expected EnsureUser user_id %s, got %s", h.userID, h.aigw.lastEnsureUserID)
	}
	if h.aigw.applySubscriptionCalls != 0 {
		t.Fatalf("expected zero-credit pass to skip ApplySubscription, got %d calls", h.aigw.applySubscriptionCalls)
	}
}

func TestPassAPIIntegrationEnsureUserFailureIsFailClosed(t *testing.T) {
	h := newAPIIntegrationHarness(t)
	seedBundleForPass(t, "bundle_zero_credit_failclosed", 0, "")

	h.aigw.mu.Lock()
	h.aigw.ensureUserErr = fmt.Errorf("aigateway unavailable")
	h.aigw.mu.Unlock()

	resp := h.request(t, http.MethodPost, "/v1/passes", map[string]any{
		"bundle_id": "bundle_zero_credit_failclosed",
	}, nil)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 when EnsureUser fails, got %d body=%s", resp.StatusCode, readBody(t, resp))
	}
	_ = readBody(t, resp)

	var passCount int64
	if err := resource.GormDB.Table("pass").Where("user_id = ? AND bundle_id = ?", h.userID, "bundle_zero_credit_failclosed").Count(&passCount).Error; err != nil {
		t.Fatalf("count pass rows: %v", err)
	}
	if passCount != 0 {
		t.Fatalf("expected no pass row after EnsureUser failure, got %d", passCount)
	}

	var bundle bundlemodel.Entity
	if err := resource.GormDB.Table(bundlemodel.TableName).Where("bundle_id = ?", "bundle_zero_credit_failclosed").First(&bundle).Error; err != nil {
		t.Fatalf("load bundle after failure: %v", err)
	}
	if bundle.BundleSalesAvailCount != 10 {
		t.Fatalf("expected bundle available count to remain 10, got %d", bundle.BundleSalesAvailCount)
	}
}

func TestInternalBotsEndpointListsInstancesAcrossUsers(t *testing.T) {
	h := newAPIIntegrationHarness(t)

	alphaCreated := time.Date(2026, 3, 29, 16, 0, 0, 0, time.UTC)
	betaCreated := time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC)
	if err := resource.GormDB.Table(modelinstance.TableName).Create(&modelinstance.Entity{
		InstanceId: "ins-bot-a",
		UserId:     "usr_alpha",
		SandboxId:  "sbx-alpha",
		Status:     modelinstance.InstanceStatusRunning,
		TimeoutAt:  alphaCreated.Add(time.Hour),
		CreatedAt:  alphaCreated,
		UpdatedAt:  alphaCreated.Add(10 * time.Minute),
	}).Error; err != nil {
		t.Fatalf("seed bot alpha: %v", err)
	}
	if err := resource.GormDB.Table(modelinstance.TableName).Create(&modelinstance.Entity{
		InstanceId: "ins-bot-b",
		UserId:     "usr_beta",
		SandboxId:  "sbx-beta",
		Status:     modelinstance.InstanceStatusPaused,
		TimeoutAt:  betaCreated.Add(2 * time.Hour),
		CreatedAt:  betaCreated,
		UpdatedAt:  betaCreated.Add(10 * time.Minute),
	}).Error; err != nil {
		t.Fatalf("seed bot beta: %v", err)
	}

	resp := h.request(t, http.MethodGet, "/internal/bots?page=1&page_size=10&user_id=usr_beta", nil, map[string]string{headerUserID: ""})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected bots status: %d body=%s", resp.StatusCode, readBody(t, resp))
	}

	defer resp.Body.Close()
	var payload transport.ListBotsResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode bots payload: %v", err)
	}
	if payload.Total != 1 {
		t.Fatalf("expected total=1, got %d", payload.Total)
	}
	if len(payload.Items) != 1 {
		t.Fatalf("expected one bot, got %d", len(payload.Items))
	}
	item := payload.Items[0]
	if item.InstanceID != "ins-bot-b" || item.UserID != "usr_beta" || item.SandboxID != "sbx-beta" {
		t.Fatalf("unexpected bot payload: %+v", item)
	}
	if item.BornDateForChina != "2026-03-30" {
		t.Fatalf("expected china birth date, got %+v", item)
	}
	if item.BornNumberForChina == nil || *item.BornNumberForChina != 2 {
		t.Fatalf("expected beta to be second birth of china day, got %+v", item)
	}
}

func TestInternalBotBornCardEndpointReturnsChinaBirthInfo(t *testing.T) {
	h := newAPIIntegrationHarness(t)

	alphaCreated := time.Date(2026, 3, 29, 16, 0, 0, 0, time.UTC)
	betaCreated := time.Date(2026, 3, 29, 16, 1, 0, 0, time.UTC)
	entities := []modelinstance.Entity{
		{
			InstanceId: "ins-borncard-a",
			UserId:     "usr_alpha",
			SandboxId:  "sbx-alpha",
			Status:     modelinstance.InstanceStatusRunning,
			TimeoutAt:  alphaCreated.Add(time.Hour),
			CreatedAt:  alphaCreated,
			UpdatedAt:  alphaCreated.Add(5 * time.Minute),
		},
		{
			InstanceId: "ins-borncard-b",
			UserId:     "usr_beta",
			SandboxId:  "sbx-beta",
			Status:     modelinstance.InstanceStatusRunning,
			TimeoutAt:  betaCreated.Add(time.Hour),
			CreatedAt:  betaCreated,
			UpdatedAt:  betaCreated.Add(5 * time.Minute),
		},
	}
	if err := resource.GormDB.Table(modelinstance.TableName).Create(&entities).Error; err != nil {
		t.Fatalf("seed borncard instances: %v", err)
	}

	resp := h.request(t, http.MethodGet, "/internal/bots/ins-borncard-b/borncard", nil, map[string]string{headerUserID: ""})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected borncard status: %d body=%s", resp.StatusCode, readBody(t, resp))
	}

	defer resp.Body.Close()
	var payload transport.BotBornCardResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode borncard payload: %v", err)
	}
	if payload.InstanceID != "ins-borncard-b" || payload.UserID != "usr_beta" {
		t.Fatalf("unexpected borncard payload: %+v", payload)
	}
	if payload.BornDateForChina != "2026-03-30" || payload.BornNumberForChina != 2 {
		t.Fatalf("unexpected borncard birth fields: %+v", payload)
	}
}

func TestPublicBotBornCardEndpointRequiresOwnerAndReturnsChinaBirthInfo(t *testing.T) {
	h := newAPIIntegrationHarness(t)

	createResp := h.request(t, http.MethodPost, "/v1/instances", map[string]any{"timeout": 30}, nil)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected create status: %d", createResp.StatusCode)
	}
	create := decodeSuccessEnvelope[transport.InstanceResponse](t, createResp)

	resp := h.request(t, http.MethodGet, "/v1/instances/"+create.Data.InstanceID+"/borncard", nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected public borncard status: %d body=%s", resp.StatusCode, readBody(t, resp))
	}

	envelope := decodeSuccessEnvelope[transport.BotBornCardResponse](t, resp)
	if envelope.Data.InstanceID != create.Data.InstanceID || envelope.Data.UserID != h.userID {
		t.Fatalf("unexpected public borncard payload: %+v", envelope.Data)
	}
	if envelope.Data.BornDateForChina == "" || envelope.Data.BornNumberForChina <= 0 {
		t.Fatalf("unexpected public borncard birth fields: %+v", envelope.Data)
	}

	forbiddenResp := h.request(t, http.MethodGet, "/v1/instances/"+create.Data.InstanceID+"/borncard", nil, map[string]string{headerUserID: "usr_other"})
	if forbiddenResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected not found for non-owner borncard, got %d body=%s", forbiddenResp.StatusCode, readBody(t, forbiddenResp))
	}
}

func TestInstanceAPIIntegrationWeixinSessionEndpoints(t *testing.T) {
	h := newAPIIntegrationHarness(t)

	createResp := h.request(t, http.MethodPost, "/v1/instances", map[string]any{"timeout": 30}, nil)
	create := decodeSuccessEnvelope[transport.InstanceResponse](t, createResp)
	instanceID := create.Data.InstanceID

	createSessionResp := h.request(
		t,
		http.MethodPost,
		"/v1/instances/"+instanceID+"/channels/weixin/login-sessions",
		map[string]any{},
		nil,
	)
	if createSessionResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected create weixin session status: %d", createSessionResp.StatusCode)
	}
	session := decodeSuccessEnvelope[transport.CreateWeixinLoginSessionResponse](t, createSessionResp)
	if session.Data.SessionID == "" || session.Data.Status != "starting" {
		t.Fatalf("unexpected create weixin session payload: %+v", session.Data)
	}

	snapshot := waitForWeixinSession(t, h, instanceID, session.Data.SessionID, "waiting_qr")
	if snapshot.QRURL == "" {
		t.Fatalf("expected qr url, got %+v", snapshot)
	}

	cancelResp := h.request(
		t,
		http.MethodPost,
		"/v1/instances/"+instanceID+"/channels/weixin/login-sessions/"+session.Data.SessionID+"/cancel",
		nil,
		nil,
	)
	if cancelResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected cancel weixin session status: %d", cancelResp.StatusCode)
	}
	cancelled := decodeSuccessEnvelope[transport.WeixinLoginSessionResponse](t, cancelResp)
	if cancelled.Data.Status != "cancelled" {
		t.Fatalf("unexpected cancelled payload: %+v", cancelled.Data)
	}

	eventsResp := h.request(
		t,
		http.MethodGet,
		"/v1/instances/"+instanceID+"/channels/weixin/login-sessions/"+session.Data.SessionID+"/events",
		nil,
		map[string]string{"Accept": "text/event-stream"},
	)
	if eventsResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected events status: %d", eventsResp.StatusCode)
	}
	eventsBody := readBody(t, eventsResp)
	if !strings.Contains(eventsBody, "event: snapshot") || !strings.Contains(eventsBody, "event: finished") {
		t.Fatalf("unexpected events body: %q", eventsBody)
	}

	deleteResp := h.request(t, http.MethodDelete, "/v1/instances/"+instanceID, nil, nil)
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected delete status: %d", deleteResp.StatusCode)
	}
	_ = decodeSuccessEnvelope[transport.InstanceResponse](t, deleteResp)
}

func (a *integrationSandboxAdapter) CreateSandbox(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.counter++
	return &psandbox.Sandbox{
		SandboxID:       "sbx-api-integration-" + transportInt(a.counter),
		TemplateID:      req.TemplateID,
		EnvdVersion:     "1.0.0",
		EnvdAccessToken: "token",
	}, nil
}

func (a *integrationSandboxAdapter) GetSandbox(_ context.Context, _ string) (*psandbox.SandboxDetail, error) {
	return nil, nil
}

func (a *integrationSandboxAdapter) ListSandboxes(_ context.Context, _ *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	return nil, nil
}

func (a *integrationSandboxAdapter) ListPools(_ context.Context) ([]psandbox.Pool, error) {
	return []psandbox.Pool{
		{
			ID:     "tpl-api-integration",
			Name:   "integration-pool",
			Status: "active",
		},
	}, nil
}

func (a *integrationSandboxAdapter) ListPoolInstances(_ context.Context, _ string) ([]psandbox.PoolInstance, error) {
	return nil, nil
}

func (a *integrationSandboxAdapter) DeleteSandbox(_ context.Context, _ string) error {
	return nil
}

func (a *integrationSandboxAdapter) PauseSandbox(_ context.Context, _ string) error {
	return nil
}

func (a *integrationSandboxAdapter) ResumeSandbox(_ context.Context, sandboxID string, _ *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	return &psandbox.Sandbox{
		SandboxID:   sandboxID,
		TemplateID:  "tpl-api-integration",
		EnvdVersion: "1.0.0",
	}, nil
}

func (a *integrationSandboxAdapter) SetTimeout(_ context.Context, _ string, _ int32) error {
	return nil
}

func (a *integrationSandboxAdapter) Refresh(_ context.Context, _ string, _ int32) error {
	return nil
}

func (a *integrationSandboxAdapter) GetLogs(_ context.Context, sandboxID string, _ *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	return &psandbox.SandboxLogs{
		Logs: []psandbox.SandboxLog{
			{Timestamp: time.Now(), Line: "log line for " + sandboxID},
		},
	}, nil
}

func (a *integrationSandboxAdapter) ExecCommand(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{
		Status:   "SUCCESS",
		ExitCode: 0,
		Output:   "gateway restarted",
	}, nil
}

func (a *integrationSandboxAdapter) GetCommandResult(_ context.Context, _ string, _ string) (*psandbox.ExecCommandResult, error) {
	return nil, nil
}

func (a *integrationSandboxAdapter) StartProcessStream(ctx context.Context, _ string, req *psandbox.ProcessStartRequest, onEvent func(psandbox.ProcessStreamEvent) error) error {
	command := req.Cmd + " " + strings.Join(req.Args, " ")
	switch {
	case strings.Contains(command, "openclaw --version"):
		if err := onEvent(psandbox.ProcessStreamEvent{PID: 1001}); err != nil {
			return err
		}
		return onEvent(psandbox.ProcessStreamEvent{
			Stdout:   "openclaw version 1.0.0\n",
			ExitCode: 0,
			Status:   "exit status 0",
			Ended:    true,
		})
	case strings.Contains(command, "channels login --channel openclaw-weixin"):
		if err := onEvent(psandbox.ProcessStreamEvent{PID: 2002}); err != nil {
			return err
		}
		if err := onEvent(psandbox.ProcessStreamEvent{
			Stdout: "Scan QR: https://weixin.qq.com/x/mock-qr\n[qr ascii]\n",
		}); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	case strings.Contains(command, "openclaw plugins"):
		return onEvent(psandbox.ProcessStreamEvent{
			Stdout:   "plugin ready\n",
			ExitCode: 0,
			Status:   "exit status 0",
			Ended:    true,
		})
	case strings.Contains(command, "channels add --channel"):
		return onEvent(psandbox.ProcessStreamEvent{
			Stdout:   "Added QQ Bot account\n",
			ExitCode: 0,
			Status:   "exit status 0",
			Ended:    true,
		})
	case strings.Contains(command, "gateway restart"):
		return onEvent(psandbox.ProcessStreamEvent{
			Stdout:   "gateway restarted\n",
			ExitCode: 0,
			Status:   "exit status 0",
			Ended:    true,
		})
	default:
		return onEvent(psandbox.ProcessStreamEvent{
			Stdout:   "ok\n",
			ExitCode: 0,
			Status:   "exit status 0",
			Ended:    true,
		})
	}
}

func (a *integrationSandboxAdapter) RunProcessWithStdin(_ context.Context, _ string, _ *psandbox.ProcessStartRequest, _ []byte) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

func (a *integrationSandboxAdapter) SendProcessSignal(_ context.Context, _ string, _ uint32, _ string) error {
	return nil
}

type integrationAiGatewayAdapter struct {
	mu                     sync.Mutex
	ensureUserCalls        int
	lastEnsureUserID       string
	lastEnsureUserNickname string
	ensureUserErr          error
	applySubscriptionCalls int
}

func (a *integrationAiGatewayAdapter) CreateApiKey(_ context.Context, _ string, _ string) (*paigateway.CreateApiKeyResponse, error) {
	return nil, nil
}

func (a *integrationAiGatewayAdapter) EnsureUser(_ context.Context, userID string, nickname string) (*paigateway.EnsureUserResponse, error) {
	a.mu.Lock()
	a.ensureUserCalls++
	a.lastEnsureUserID = userID
	a.lastEnsureUserNickname = nickname
	err := a.ensureUserErr
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &paigateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (a *integrationAiGatewayAdapter) RevokeApiKey(_ context.Context, _ string) error {
	return nil
}

func (a *integrationAiGatewayAdapter) GetUserUsage(_ context.Context, _ string) (*paigateway.UserUsageResponse, error) {
	return &paigateway.UserUsageResponse{}, nil
}

func (a *integrationAiGatewayAdapter) GetPlan(_ context.Context, planID string) (*paigateway.Plan, error) {
	return &paigateway.Plan{ID: planID, IsActive: true}, nil
}

func (a *integrationAiGatewayAdapter) ApplySubscription(_ context.Context, userID string, planID string) (*paigateway.Subscription, error) {
	a.mu.Lock()
	a.applySubscriptionCalls++
	a.mu.Unlock()
	return &paigateway.Subscription{UserID: userID, PlanID: planID, Status: "active"}, nil
}

func (a *integrationAiGatewayAdapter) CancelSubscription(_ context.Context, _ string) error {
	return nil
}

func (a *integrationAiGatewayAdapter) GetActiveSubscription(_ context.Context, _ string) (*paigateway.Subscription, error) {
	return nil, nil
}

func transportInt(v int) string {
	return strconv.Itoa(v)
}

func seedBundleForPass(t *testing.T, bundleID string, credit int64, aiGatewayPlanID string) {
	t.Helper()
	err := resource.GormDB.Table(bundlemodel.TableName).Create(&bundlemodel.Entity{
		BundleID:              bundleID,
		BundleName:            bundleID,
		Description:           "[]",
		BundleState:           bundlemodel.StateOnline,
		AgentQuota:            1,
		Credit:                credit,
		TimeSpan:              30,
		TimeUnit:              bundlemodel.TimeUnitDay,
		AiGatewayPlanID:       aiGatewayPlanID,
		StaticSoldOut:         false,
		BundleSalesAvailCount: 10,
		BundleSalesTotalCount: 10,
	}).Error
	if err != nil {
		t.Fatalf("seed bundle: %v", err)
	}
}
