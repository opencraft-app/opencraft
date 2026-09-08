package jifeiclient

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/cloudladderauth"
)

func TestGetPriceAddsOptionalCloudLadderHMAC(t *testing.T) {
	var capturedHeader http.Header
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Clone()
		capturedBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	client := New(server.URL+"/v1/proxy/jifei-prod/interfaces/interface.php", "", Options{
		CloudLadderHMACSecret: "secret",
		EventIDProvider:       fixedEventIDProvider,
		NowProvider:           fixedNowProvider,
	})
	if _, err := client.GetPrice(context.Background(), &GetPriceRequest{}); err != nil {
		t.Fatalf("GetPrice() error = %v", err)
	}

	if got := capturedHeader.Get(cloudladderauth.HeaderCaller); got != "lightvela-trade" {
		t.Fatalf("caller = %q", got)
	}
	expected := make(http.Header)
	requestURL, err := http.NewRequest(http.MethodPost, server.URL+"/v1/proxy/jifei-prod/interfaces/interface.php", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := cloudladderauth.SignProxyURLHeaders(
		"secret", "lightvela-trade", expected, http.MethodPost, requestURL.URL, capturedBody, fixedNowProvider(),
	); err != nil {
		t.Fatal(err)
	}
	if got, want := capturedHeader.Get(cloudladderauth.HeaderSignature), expected.Get(cloudladderauth.HeaderSignature); got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestGetPriceWithoutCloudLadderSecretRemainsUnsigned(t *testing.T) {
	var capturedHeader http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Clone()
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	client := New(server.URL, "", Options{
		EventIDProvider: fixedEventIDProvider,
		NowProvider:     fixedNowProvider,
	})
	if _, err := client.GetPrice(context.Background(), &GetPriceRequest{}); err != nil {
		t.Fatalf("GetPrice() error = %v", err)
	}
	if got := capturedHeader.Get(cloudladderauth.HeaderSignature); got != "" {
		t.Fatalf("signature = %q, want empty", got)
	}
}

func TestGetPriceRejectsUnsignedFallbackWhenCloudLadderURLIsInvalid(t *testing.T) {
	client := New("https://trade.tencentyun.com/interfaces/interface.php", "", Options{
		CloudLadderHMACSecret: "secret",
	})
	if _, err := client.GetPrice(context.Background(), &GetPriceRequest{}); err == nil {
		t.Fatal("GetPrice() error = nil, want invalid CloudLadder URL error")
	}
}
