package main

import (
	"ctl/pkg/instance"
	"ctl/pkg/transport"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWeixinAccountConflictExposesOwnerName(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/instances/instance-test/bots/bot-b/channel-bindings/weixin", nil)
	writeHTTPError(rec, req, &instance.WeixinAccountOccupiedError{Owner: &transport.InstanceChannelBindingResponse{Channel: "weixin", BotID: "bot-a", BotName: "工作助手", ProfileID: "default", Status: "connected"}})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status: %d", rec.Code)
	}
	var payload struct {
		Code    string `json:"code"`
		Details struct {
			Owner transport.InstanceChannelBindingResponse `json:"occupied_by_bot"`
		} `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != "WEIXIN_ACCOUNT_OCCUPIED" || payload.Details.Owner.BotID != "bot-a" || payload.Details.Owner.BotName != "工作助手" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestDeleteBotChannelConflictHTTPContract(t *testing.T) {
	for _, channel := range []string{"weixin", "whatsapp"} {
		t.Run(channel, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodDelete, "/v1/instances/test/bots/bot-b", nil)
			writeHTTPError(rec, req, &instance.BotChannelOccupiedError{Channel: channel})
			var payload struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Details struct {
					Channel string `json:"channel"`
				} `json:"details"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if rec.Code != 409 || payload.Code != "CHANNEL_OCCUPIED" || payload.Message != "channel is already connected to another bot" || payload.Details.Channel != channel {
				t.Fatalf("contract: %+v", payload)
			}
		})
	}
}
