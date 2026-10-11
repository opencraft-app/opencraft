package tencentim

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tencentimport "chatserver/internal/ports/tencentim"
)

func TestRESTAgentNotificationSenderSendsStableCustomElement(t *testing.T) {
	type messageBody struct {
		SyncOtherMachine int      `json:"SyncOtherMachine"`
		ToAccount        string   `json:"To_Account"`
		MsgSeq           uint32   `json:"MsgSeq"`
		MsgRandom        uint32   `json:"MsgRandom"`
		SendMsgControl   []string `json:"SendMsgControl"`
		MsgBody          []struct {
			MsgType    string `json:"MsgType"`
			MsgContent struct {
				Data string `json:"Data"`
				Desc string `json:"Desc"`
			} `json:"MsgContent"`
		} `json:"MsgBody"`
	}
	var received []messageBody
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPost || request.URL.Path != "/v4/openim/sendmsg" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		query := request.URL.Query()
		if query.Get("sdkappid") != "1600000000" ||
			query.Get("identifier") != "platform_admin" ||
			query.Get("usersig") != "admin-sig" ||
			query.Get("contenttype") != "json" || query.Get("random") == "" {
			t.Fatalf("query = %#v", query)
		}
		var body messageBody
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		received = append(received, body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","MsgKey":"test"}`,
		)
	}))
	t.Cleanup(server.Close)
	sender, err := NewRESTAgentNotificationSender(RESTConfig{
		SDKAppID:        1600000000,
		AdminUserID:     "platform_admin",
		BaseURL:         server.URL,
		HTTPClient:      server.Client(),
		Random:          strings.NewReader("\x00\x00\x00\x01\x00\x00\x00\x02"),
		AdminSignatures: &fixedSigIssuer{value: tencentimport.UserSig{Value: "admin-sig"}},
		AdminSigTTL:     5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	notification := tencentimport.AgentNotification{
		ToUserID:   "a_AGENT",
		Type:       "reminder.due",
		ServerID:   "01989c24-7540-7f12-a27b-c83243215dd3",
		AgentID:    "01989c24-7540-7f12-a27b-c83243215dd8",
		ResourceID: "01989c24-7540-7f12-a27b-c83243215dde",
		Revision:   1,
		EventID:    "01989c24-7540-7f12-a27b-c83243215ddf",
	}
	if err := sender.SendAgentNotification(context.Background(), notification); err != nil {
		t.Fatal(err)
	}
	if err := sender.SendAgentNotification(context.Background(), notification); err != nil {
		t.Fatal(err)
	}
	if len(received) != 2 {
		t.Fatalf("received = %d", len(received))
	}
	first := received[0]
	if first.SyncOtherMachine != 2 || first.ToAccount != "a_AGENT" ||
		first.MsgSeq == 0 || first.MsgRandom == 0 || len(first.MsgBody) != 1 ||
		first.MsgBody[0].MsgType != "TIMCustomElem" ||
		first.MsgBody[0].MsgContent.Desc != "platform.reminder.v1" ||
		len(first.SendMsgControl) != 2 ||
		first.SendMsgControl[0] != "NoUnread" ||
		first.SendMsgControl[1] != "NoLastMsg" {
		t.Fatalf("message body = %#v", first)
	}
	if first.MsgSeq != received[1].MsgSeq ||
		first.MsgRandom != received[1].MsgRandom ||
		first.MsgBody[0].MsgContent.Data != received[1].MsgBody[0].MsgContent.Data {
		t.Fatalf("retry changed message: %#v %#v", first, received[1])
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(first.MsgBody[0].MsgContent.Data), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["schema"] != "chatserver.agent-notification/v1" ||
		payload["type"] != "reminder.due" ||
		payload["serverId"] != notification.ServerID ||
		payload["agentId"] != notification.AgentID ||
		payload["resourceId"] != notification.ResourceID ||
		payload["eventId"] != notification.EventID || payload["revision"] != float64(1) {
		t.Fatalf("payload = %#v", payload)
	}
}
