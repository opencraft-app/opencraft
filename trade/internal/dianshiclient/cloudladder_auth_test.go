package dianshiclient

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/cloudladderauth"
)

func TestGetActivityPriceAddsOptionalCloudLadderHMAC(t *testing.T) {
	var capturedHeader http.Header
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Clone()
		capturedBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"data":[]}`))
	}))
	defer server.Close()

	targetURL := server.URL + "/v1/proxy/dianshi-price/activity_price/activity/get_price"
	client := New(targetURL, "", Options{
		CloudLadderHMACSecret: "secret",
		EventIDProvider:       newFixedEventID(123),
		NowProvider:           newFixedClock(),
	})
	_, err := client.GetActivityPrice(context.Background(), &GetPriceRequest{
		ActivityID: 1,
		Goods:      []GetPriceGoodsItem{},
	})
	if err != nil {
		t.Fatalf("GetActivityPrice() error = %v", err)
	}
	if got := capturedHeader.Get(cloudladderauth.HeaderCaller); got != "lightvela-trade" {
		t.Fatalf("caller = %q", got)
	}
	expected := make(http.Header)
	req, err := http.NewRequest(http.MethodPost, targetURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := cloudladderauth.SignProxyURLHeaders(
		"secret", "lightvela-trade", expected, http.MethodPost, req.URL, capturedBody, newFixedClock()(),
	); err != nil {
		t.Fatal(err)
	}
	if got, want := capturedHeader.Get(cloudladderauth.HeaderSignature), expected.Get(cloudladderauth.HeaderSignature); got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestGetActivityPriceRejectsUnsignedFallbackWhenCloudLadderURLIsInvalid(t *testing.T) {
	client := New("https://price.example/activity_price/activity/get_price", "", Options{
		CloudLadderHMACSecret: "secret",
	})
	_, err := client.GetActivityPrice(context.Background(), &GetPriceRequest{ActivityID: 1})
	if err == nil {
		t.Fatal("GetActivityPrice() error = nil, want invalid CloudLadder URL error")
	}
}
