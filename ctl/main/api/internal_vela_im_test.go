package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
)

type velaIMLogicStub struct {
	instancelogic.Logic
	users     []string
	delivered []instancelogic.VelaIMDelivery
	verifyErr error
}

func (stub *velaIMLogicStub) VerifyVelaIMBot(ctx pctx.Context, instanceID, botID string) (*instancelogic.VelaIMBot, error) {
	stub.users = append(stub.users, ctx.GetUserID())
	if stub.verifyErr != nil {
		return nil, stub.verifyErr
	}
	return &instancelogic.VelaIMBot{BotID: botID, ProfileID: "main", Name: "研究助手"}, nil
}

func (stub *velaIMLogicStub) DeliverVelaIMBot(ctx pctx.Context, delivery instancelogic.VelaIMDelivery) error {
	stub.users = append(stub.users, ctx.GetUserID())
	stub.delivered = append(stub.delivered, delivery)
	return nil
}

func (stub *velaIMLogicStub) RevokeVelaIMBot(ctx pctx.Context, instanceID, botID string) error {
	stub.users = append(stub.users, ctx.GetUserID())
	return nil
}

func velaIMRequestFor(path, token, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func TestInternalVelaIMRequiresConfiguredInternalToken(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "")
	t.Setenv("CTL_INTERNAL_TOKEN", "")
	handler := &instanceHandler{logic: &velaIMLogicStub{}}
	response := httptest.NewRecorder()
	handler.handleInternalVelaIM(response, velaIMRequestFor("/internal/vela-im/bots:verify", "anything",
		`{"accountSubject":"usr_a","instanceId":"ins-1","botId":"ins-1"}`))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unconfigured token status = %d", response.Code)
	}
}

func TestInternalVelaIMVerifyScopesOwnershipToSubject(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token-for-tests")
	stub := &velaIMLogicStub{}
	handler := &instanceHandler{logic: stub}

	response := httptest.NewRecorder()
	handler.handleInternalVelaIM(response, velaIMRequestFor("/internal/vela-im/bots:verify", "internal-token-for-tests",
		`{"action":"verify","accountSubject":"usr_owner","instanceId":"ins-1","botId":"ins-1","displayName":"x"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"owned":true`) ||
		!strings.Contains(response.Body.String(), "研究助手") {
		t.Fatalf("verify = %d %s", response.Code, response.Body)
	}
	if len(stub.users) != 1 || stub.users[0] != "usr_owner" {
		t.Fatalf("users = %#v", stub.users)
	}

	stub.verifyErr = errcode.ErrInstanceNotFound
	response = httptest.NewRecorder()
	handler.handleInternalVelaIM(response, velaIMRequestFor("/internal/vela-im/bots:verify", "internal-token-for-tests",
		`{"accountSubject":"usr_other","instanceId":"ins-1","botId":"ins-1"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"owned":false`) {
		t.Fatalf("foreign verify = %d %s", response.Code, response.Body)
	}
}

func TestInternalVelaIMDeliverForwardsDeliveryAndRejectsBadSubject(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token-for-tests")
	stub := &velaIMLogicStub{}
	handler := &instanceHandler{logic: stub}

	response := httptest.NewRecorder()
	handler.handleInternalVelaIM(response, velaIMRequestFor("/internal/vela-im/bots:deliver", "internal-token-for-tests",
		`{"action":"deliver","accountSubject":"usr_owner","instanceId":"ins-1","botId":"bot-a","botAgentId":"b","imUserId":"a_X","sdkAppId":1600000000,"apiBaseUrl":"https://api.example.com/v1/collaboration","credential":"vbc_secret"}`))
	if response.Code != http.StatusOK || len(stub.delivered) != 1 ||
		stub.delivered[0].BotID != "bot-a" || stub.delivered[0].Credential != "vbc_secret" {
		t.Fatalf("deliver = %d %s %#v", response.Code, response.Body, stub.delivered)
	}

	response = httptest.NewRecorder()
	handler.handleInternalVelaIM(response, velaIMRequestFor("/internal/vela-im/bots:deliver", "internal-token-for-tests",
		`{"accountSubject":"not-a-user","instanceId":"ins-1","botId":"bot-a"}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad subject status = %d", response.Code)
	}
}
