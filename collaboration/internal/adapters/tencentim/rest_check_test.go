package tencentim

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRESTIdentityProvisionerChecksAccountsInBatches(t *testing.T) {
	var batches []int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !strings.HasSuffix(request.URL.Path, accountCheckPath) {
			t.Errorf("path = %s", request.URL.Path)
		}
		var body struct {
			CheckItem []struct{ UserID string } `json:"CheckItem"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		batches = append(batches, len(body.CheckItem))
		items := make([]map[string]any, 0, len(body.CheckItem))
		for _, item := range body.CheckItem {
			status := "NotImported"
			if strings.HasSuffix(item.UserID, "0") {
				status = "Imported"
			}
			items = append(items, map[string]any{"UserID": item.UserID, "ResultCode": 0, "AccountStatus": status})
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"ActionStatus": "OK", "ErrorCode": 0, "ResultItem": items})
	}))
	t.Cleanup(server.Close)

	userIDs := make([]string, 150)
	for index := range userIDs {
		userIDs[index] = fmt.Sprintf("a_check_%03d", index)
	}
	imported, err := newTestRESTIdentityProvisioner(t, server).CheckIdentities(context.Background(), userIDs)
	if err != nil {
		t.Fatal(err)
	}
	if len(batches) != 2 || batches[0] != 100 || batches[1] != 50 {
		t.Fatalf("batches = %v", batches)
	}
	if len(imported) != 150 || !imported["a_check_010"] || imported["a_check_011"] {
		t.Fatalf("imported = %v", imported)
	}
}

func TestRESTIdentityProvisionerRejectsIncompleteCheckResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ActionStatus":"OK","ErrorCode":0,"ResultItem":[]}`))
	}))
	t.Cleanup(server.Close)
	if _, err := newTestRESTIdentityProvisioner(t, server).CheckIdentities(context.Background(), []string{"u_x"}); err == nil {
		t.Fatal("incomplete account_check response accepted")
	}
}
