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
	platformTaskID       = "0198f4c2-7a34-7e45-913c-6baf30401a83"
	platformTaskServerID = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	platformTaskAgentID  = "0198f4c2-7a33-7e45-913c-6baf30401a82"
)

func TestTaskClientListsClaimsAndUpdatesRuntimeTask(t *testing.T) {
	requests := make([]*http.Request, 0, 3)
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
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/tasks":
			_, _ = response.Write([]byte("[" + taskPayload("todo", 1) + "]"))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/tasks/"+platformTaskID+"/claim":
			if request.Header.Get("Idempotency-Key") != "claim-key" {
				t.Fatalf("claim Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
			}
			_, _ = response.Write([]byte(taskPayload("in_progress", 2)))
		case request.Method == http.MethodPatch && request.URL.Path == "/v1/runtime/tasks/"+platformTaskID:
			if request.Header.Get("If-Match") != "2" || request.Header.Get("Idempotency-Key") != "update-key" {
				t.Fatalf("update headers = %#v", request.Header)
			}
			_, _ = response.Write([]byte(taskPayload("done", 3)))
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
	tasks, err := client.ListRuntimeTasks(context.Background(), token)
	if err != nil || len(tasks) != 1 || tasks[0].ID != platformTaskID {
		t.Fatalf("ListRuntimeTasks() = (%#v, %v)", tasks, err)
	}
	claimed, err := client.ClaimRuntimeTask(
		context.Background(), token, platformTaskID, "claim-key",
	)
	if err != nil || claimed.Status != TaskInProgress || claimed.Revision != 2 {
		t.Fatalf("ClaimRuntimeTask() = (%#v, %v)", claimed, err)
	}
	done, err := client.UpdateRuntimeTaskStatus(
		context.Background(), token, platformTaskID, 2, TaskDone, "update-key",
	)
	if err != nil || done.Status != TaskDone || done.Revision != 3 {
		t.Fatalf("UpdateRuntimeTaskStatus() = (%#v, %v)", done, err)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d", len(requests))
	}
}

func newTaskTestClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL: baseURL + "/v1", HTTPClient: http.DefaultClient,
		AllowInsecureLoopback: true, Now: time.Now,
		MaxSessionTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func taskPayload(status string, revision int) string {
	return `{"id":"` + platformTaskID +
		`","serverId":"` + platformTaskServerID +
		`","number":1,"title":"处理告警","status":"` + status +
		`","ownerMemberId":"` + platformTaskAgentID +
		`","assignmentRevision":1,"createdByMemberId":"` + platformTaskAgentID +
		`","updatedByMemberId":"` + platformTaskAgentID +
		`","revision":` + strconv.Itoa(revision) + `}`
}
