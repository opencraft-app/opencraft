package contentaudit

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestLiveCreateTextTask(t *testing.T) {
	if os.Getenv("CONTENT_AUDIT_LIVE_TEST") != "1" {
		t.Skip("set CONTENT_AUDIT_LIVE_TEST=1 to hit the real content audit proxy")
	}
	endpoint := os.Getenv("CONTENT_AUDIT_ENDPOINT")
	proxyToken := os.Getenv("CONTENT_AUDIT_PROXY_TOKEN")
	productID := os.Getenv("CONTENT_AUDIT_PRODUCT_ID")
	sid := os.Getenv("CONTENT_AUDIT_USER_SID")
	if endpoint == "" || proxyToken == "" || productID == "" || sid == "" {
		t.Fatal("CONTENT_AUDIT_ENDPOINT, CONTENT_AUDIT_PROXY_TOKEN, CONTENT_AUDIT_PRODUCT_ID and CONTENT_AUDIT_USER_SID are required")
	}

	client, err := New(Config{Endpoint: endpoint, ProxyToken: proxyToken})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	requestID := fmt.Sprintf("lightclaw-live-test-%d", time.Now().Unix())
	text := "本地审核测试昵称"
	resp, err := client.CreateTextTask(context.Background(), CreateTextTaskRequest{
		ProductID: productID,
		SID:       sid,
		RequestID: requestID,
		Data: CreateTextTaskRequestData{
			Comm: RequestComm{UlUin: 0},
			ID:   RequestID{StrMsgID: requestID},
			Content: RequestContent{
				User:  RequestUser{StrUin: "local-test-user", UiAcntType: 7, StrNick: text},
				Msg:   RequestMsg{UiPostTime: uint64(time.Now().Unix())},
				Media: RequestMedia{Text: []RequestText{{StrContent: base64.StdEncoding.EncodeToString([]byte(text))}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("CreateTextTask returned error: %v", err)
	}
	if resp.Response.RequestID == "" {
		t.Fatalf("expected response request id, got %+v", resp)
	}
	t.Logf("request_id=%s response_request_id=%s data=%+v", requestID, resp.Response.RequestID, resp.Response.Data)
}
