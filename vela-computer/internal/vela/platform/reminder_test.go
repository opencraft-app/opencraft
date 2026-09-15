package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

const (
	platformReminderID      = "0198f4c2-7a36-7e45-913c-6baf30401a85"
	platformReminderChannel = "0198f4c2-7a37-7e45-913c-6baf30401a86"
	platformOccurrenceID    = "0198f4c2-7a38-7e45-913c-6baf30401a87"
)

func TestReminderClientProvidesCRUDSnoozeAndAnchoredLog(t *testing.T) {
	now := time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)
	fireAt := now.Add(time.Hour)
	requests := make([]*http.Request, 0, 6)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		requests = append(requests, request.Clone(request.Context()))
		if request.Header.Get("Authorization") != "Bearer short-runtime-token" {
			t.Fatalf("Authorization = %q", request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/reminders":
			_, _ = response.Write([]byte("[" + reminderPayload(fireAt, "active", 1) + "]"))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/reminders":
			if request.Header.Get("Idempotency-Key") != "create-key" {
				t.Fatalf("create headers = %#v", request.Header)
			}
			response.WriteHeader(http.StatusCreated)
			_, _ = response.Write([]byte(reminderPayload(fireAt, "active", 1)))
		case request.Method == http.MethodPatch && request.URL.Path == "/v1/runtime/reminders/"+platformReminderID:
			if request.Header.Get("If-Match") != "1" || request.Header.Get("Idempotency-Key") != "update-key" {
				t.Fatalf("update headers = %#v", request.Header)
			}
			_, _ = response.Write([]byte(reminderPayload(fireAt, "paused", 2)))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/reminders/"+platformReminderID+"/snooze":
			if request.Header.Get("If-Match") != "2" || request.Header.Get("Idempotency-Key") != "snooze-key" {
				t.Fatalf("snooze headers = %#v", request.Header)
			}
			_, _ = response.Write([]byte(reminderPayload(fireAt.Add(90*time.Second), "active", 3)))
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/reminders/"+platformReminderID+"/log":
			if request.URL.Query().Get("limit") != "20" || request.URL.Query().Get("cursor") != platformOccurrenceID {
				t.Fatalf("log query = %q", request.URL.RawQuery)
			}
			_, _ = response.Write([]byte(`[{
				"id":"` + platformOccurrenceID + `","serverId":"` + platformTaskServerID + `",
				"reminderId":"` + platformReminderID + `","agentId":"` + platformTaskAgentID + `",
				"scheduledFireAt":"` + fireAt.Format(time.RFC3339) + `","state":"acknowledged",
				"text":"处理这条消息"
			}]`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v1/runtime/reminders/"+platformReminderID:
			if request.Header.Get("If-Match") != "3" || request.Header.Get("Idempotency-Key") != "cancel-key" {
				t.Fatalf("cancel headers = %#v", request.Header)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	client := newTaskTestClient(t, server.URL)
	token, err := newAccessToken("short-runtime-token")
	if err != nil {
		t.Fatal(err)
	}
	anchor := &ReminderAnchor{
		Kind: ReminderAnchorMessage, ChannelID: platformReminderChannel,
		MessageRef: ThreadMessageRef{
			Kind: "group", MessageID: "message-44", GroupID: "community-1",
			TopicID: "topic-general", Sequence: 44, Timestamp: now.Unix(),
		},
	}
	values, err := client.ListRuntimeReminders(
		context.Background(), token, platformTaskServerID, platformTaskAgentID,
	)
	if err != nil || len(values) != 1 || values[0].Anchor == nil ||
		values[0].Anchor.MessageRef.MessageID != "message-44" {
		t.Fatalf("ListRuntimeReminders() = (%#v, %v)", values, err)
	}
	created, err := client.CreateRuntimeReminder(
		context.Background(), token, platformTaskServerID, platformTaskAgentID,
		ReminderDraft{
			ScheduleKind: ReminderOnce, Schedule: fireAt.Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "处理这条消息", Anchor: anchor,
		},
		"create-key",
	)
	if err != nil || created.ID != platformReminderID {
		t.Fatalf("CreateRuntimeReminder() = (%#v, %v)", created, err)
	}
	paused := ReminderPaused
	updated, err := client.UpdateRuntimeReminder(
		context.Background(), token, platformTaskServerID, platformTaskAgentID,
		platformReminderID, 1, ReminderPatch{Status: &paused}, "update-key",
	)
	if err != nil || updated.Status != ReminderPaused || updated.Revision != 2 {
		t.Fatalf("UpdateRuntimeReminder() = (%#v, %v)", updated, err)
	}
	snoozed, err := client.SnoozeRuntimeReminder(
		context.Background(), token, platformTaskServerID, platformTaskAgentID,
		platformReminderID, 2, 90*time.Second, "snooze-key",
	)
	if err != nil || snoozed.Revision != 3 {
		t.Fatalf("SnoozeRuntimeReminder() = (%#v, %v)", snoozed, err)
	}
	log, err := client.ListRuntimeReminderLog(
		context.Background(), token, platformTaskServerID, platformTaskAgentID,
		platformReminderID, platformOccurrenceID, 20,
	)
	if err != nil || len(log) != 1 || log[0].ID != platformOccurrenceID {
		t.Fatalf("ListRuntimeReminderLog() = (%#v, %v)", log, err)
	}
	if err := client.CancelRuntimeReminder(
		context.Background(), token, platformReminderID, 3, "cancel-key",
	); err != nil {
		t.Fatalf("CancelRuntimeReminder() error = %v", err)
	}
	if len(requests) != 6 {
		t.Fatalf("request count = %d", len(requests))
	}
}

func reminderPayload(fireAt time.Time, status string, revision int) string {
	return `{"id":"` + platformReminderID +
		`","serverId":"` + platformTaskServerID +
		`","agentId":"` + platformTaskAgentID +
		`","scheduleKind":"once","schedule":"` + fireAt.Format(time.RFC3339) +
		`","timezone":"Asia/Shanghai","text":"处理这条消息","status":"` + status +
		`","nextFireAt":"` + fireAt.Format(time.RFC3339) +
		`","revision":` + strconv.Itoa(revision) +
		`,"createdAt":"2026-08-02T10:00:00Z","updatedAt":"2026-08-02T10:00:00Z",
		"anchor":{"kind":"message","channelId":"` + platformReminderChannel +
		`","messageRef":{"kind":"group","messageId":"message-44","groupId":"community-1","topicId":"topic-general","sequence":44,"timestamp":` +
		strconv.FormatInt(time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC).Unix(), 10) + `}}}`
}
