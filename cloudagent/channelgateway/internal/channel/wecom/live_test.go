package wecom

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWeComLiveSubscribe(t *testing.T) {
	if strings.TrimSpace(os.Getenv("CHANNELGATEWAY_WECOM_LIVE")) != "1" {
		t.Skip("set CHANNELGATEWAY_WECOM_LIVE=1 to run live WeCom subscribe test")
	}
	botID := strings.TrimSpace(os.Getenv("WECOM_BOT_ID"))
	secret := strings.TrimSpace(os.Getenv("WECOM_SECRET"))
	if botID == "" || secret == "" {
		t.Fatal("WECOM_BOT_ID and WECOM_SECRET are required")
	}
	wsURL := strings.TrimSpace(os.Getenv("WECOM_WEBSOCKET_URL"))
	if wsURL == "" {
		wsURL = "wss://openws.work.weixin.qq.com"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, http.Header{})
	if err != nil {
		t.Fatalf("dial WeCom websocket: %v", err)
	}
	defer conn.Close()
	reqID := newReqID(cmdSubscribe)
	if err := conn.WriteJSON(subscribeFrame(reqID, botID, secret)); err != nil {
		t.Fatalf("send subscribe: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read subscribe response: %v", err)
		}
		var payload frame
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode subscribe response: %v", err)
		}
		if payload.Headers.ReqID != reqID {
			continue
		}
		if payload.ErrCode != 0 {
			t.Fatalf("subscribe failed errcode=%d errmsg=%s", payload.ErrCode, payload.ErrMsg)
		}
		return
	}
}
