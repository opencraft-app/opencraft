package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const (
	testOccurrenceID = "01900000-0000-7000-8000-0000000000ff"
	testReminderID   = "01900000-0000-7000-8000-000000000012"
)

func TestClientPagesRuntimeReminderOccurrences(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests++
		if request.Method != http.MethodGet ||
			request.URL.Path != "/v1/runtime/reminder-occurrences" ||
			request.Header.Get("Authorization") != "Bearer runtime-access-token" ||
			request.URL.Query().Get("limit") != "100" {
			t.Errorf("request = %s %s headers=%v", request.Method, request.URL.String(), request.Header)
		}
		cursor := request.URL.Query().Get("cursor")
		if requests == 1 && cursor != "" {
			t.Errorf("first cursor = %q", cursor)
		}
		if requests == 2 && cursor != testOccurrenceID {
			t.Errorf("second cursor = %q", cursor)
		}
		values := []map[string]any{}
		if requests == 1 {
			for index := 0; index < 100; index++ {
				id := testOccurrenceID
				if index < 99 {
					id = occurrenceIDForIndex(index)
				}
				values = append(values, validOccurrence(id, "due"))
			}
		}
		data, err := common.Marshal(values)
		if err != nil {
			t.Fatal(err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(data)
	}))
	defer server.Close()

	client := newReminderTestClient(t, server)
	token, err := newAccessToken("runtime-access-token")
	if err != nil {
		t.Fatal(err)
	}
	values, err := client.ListAllReminderOccurrences(
		context.Background(), token,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 100 || requests != 2 || values[99].ID != testOccurrenceID {
		t.Fatalf("values=%d requests=%d last=%#v", len(values), requests, values[len(values)-1])
	}
}

func TestClientAcknowledgesOccurrenceWithStableKey(t *testing.T) {
	t.Parallel()

	wantKey := ReminderOccurrenceAckKey(testOccurrenceID)
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests++
		if request.Method != http.MethodPost ||
			request.URL.Path != "/v1/runtime/reminder-occurrences/"+testOccurrenceID+"/ack" ||
			request.Header.Get("Authorization") != "Bearer runtime-access-token" ||
			request.Header.Get("Idempotency-Key") != wantKey {
			t.Errorf("request = %s %s headers=%v", request.Method, request.URL.String(), request.Header)
		}
		var body struct {
			ResultCode string `json:"resultCode"`
		}
		if err := common.DecodeJson(request.Body, &body); err != nil || body.ResultCode != "completed" {
			t.Errorf("body=%#v err=%v", body, err)
		}
		data, err := common.Marshal(validOccurrence(testOccurrenceID, "acknowledged"))
		if err != nil {
			t.Fatal(err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(data)
	}))
	defer server.Close()

	client := newReminderTestClient(t, server)
	token, err := newAccessToken("runtime-access-token")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		value, err := client.AcknowledgeReminderOccurrence(
			context.Background(), token, testOccurrenceID,
		)
		if err != nil {
			t.Fatal(err)
		}
		if value.State != ReminderOccurrenceAcknowledged {
			t.Fatalf("ack = %#v", value)
		}
	}
	if requests != 2 || wantKey == "" {
		t.Fatalf("requests=%d key=%q", requests, wantKey)
	}
}

func newReminderTestClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL:               server.URL,
		HTTPClient:            server.Client(),
		AllowInsecureLoopback: true,
		Now:                   func() time.Time { return testNow },
		MaxSessionTTL:         2 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func validOccurrence(id, state string) map[string]any {
	value := map[string]any{
		"id":              id,
		"serverId":        "01900000-0000-7000-8000-000000000001",
		"reminderId":      testReminderID,
		"agentId":         "01900000-0000-7000-8000-000000000002",
		"scheduledFireAt": testNow.Add(-time.Minute).Format(time.RFC3339),
		"state":           state,
		"text":            "检查构建状态",
	}
	if state == "acknowledged" {
		value["acknowledgedAt"] = testNow.Format(time.RFC3339)
		value["resultCode"] = "completed"
	}
	return value
}

func occurrenceIDForIndex(index int) string {
	const alphabet = "0123456789abcdef"
	return "01900000-0000-7000-8000-0000000000" +
		string(alphabet[(index/16)%16]) + string(alphabet[index%16])
}
