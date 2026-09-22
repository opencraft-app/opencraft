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

func TestGetPriceDoesNotUseBillingOnlyCloudLadderSecret(t *testing.T) {
	var capturedHeader http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Clone()
		_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
	}))
	defer server.Close()

	client := New(server.URL, "", Options{
		BillingCloudLadderHMACSecret: "billing-secret",
		EventIDProvider:              fixedEventIDProvider,
		NowProvider:                  fixedNowProvider,
	})
	if _, err := client.GetPrice(context.Background(), &GetPriceRequest{}); err != nil {
		t.Fatalf("GetPrice() error = %v", err)
	}
	if got := capturedHeader.Get(cloudladderauth.HeaderSignature); got != "" {
		t.Fatalf("signature = %q, want empty for non-billing route", got)
	}
}

func TestModifyResourceStatusUsesBillingCloudLadderSecret(t *testing.T) {
	var capturedHeader http.Header
	var capturedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Clone()
		capturedBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write(envelopeForSuccess(t, ModifyResourceStatusResponse{
			OperationSet: []ModifyResourceStatusOperation{{Status: 0}},
		}))
	}))
	defer server.Close()

	const routePath = "/v1/proxy/jifei-billing-apigw-test/resource-center/interface"
	client := New(server.URL+"/v1/proxy/jifei-test/interfaces/interface.php", "", Options{
		CloudLadderHMACSecret:        "general-secret",
		BillingCloudLadderHMACSecret: "billing-secret",
		BillingAPIGWBaseURL:          server.URL + routePath,
		BillingAppID:                 "test_v0",
		BillingAppSecret:             "billing-app-secret",
		BillingNonceProvider:         func() string { return "billing-nonce" },
		EventIDProvider:              fixedEventIDProvider,
		NowProvider:                  fixedNowProvider,
	})
	_, err := client.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:    ClientTypeProduct,
		SubmitByUser:  SubmitByUserYes,
		ReferenceID:   "pass-test_1",
		ProductCode:   "p_lighthouse",
		OwnerUIN:      "100012345678",
		UIN:           "100012345678",
		SubAccountUIN: "100012345678",
		AppID:         1300012345,
		RegionID:      9,
		PayMode:       PayModePrepaid,
		OperateName:   OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{{
			SubProductCode: "sp_lighthouse_lightvela_ai_intl",
			ResourceIDs:    []string{"pass-test"},
		}},
	})
	if err != nil {
		t.Fatalf("ModifyResourceStatus() error = %v", err)
	}

	requestURL, err := http.NewRequest(http.MethodPost, server.URL+routePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	expected := make(http.Header)
	if err := cloudladderauth.SignProxyURLHeaders(
		"billing-secret", "lightvela-trade", expected, http.MethodPost,
		requestURL.URL, capturedBody, fixedNowProvider(),
	); err != nil {
		t.Fatal(err)
	}
	if got, want := capturedHeader.Get(cloudladderauth.HeaderSignature), expected.Get(cloudladderauth.HeaderSignature); got != want {
		t.Fatalf("billing route signature = %q, want %q", got, want)
	}

	general := make(http.Header)
	if err := cloudladderauth.SignProxyURLHeaders(
		"general-secret", "lightvela-trade", general, http.MethodPost,
		requestURL.URL, capturedBody, fixedNowProvider(),
	); err != nil {
		t.Fatal(err)
	}
	if capturedHeader.Get(cloudladderauth.HeaderSignature) == general.Get(cloudladderauth.HeaderSignature) {
		t.Fatal("billing route unexpectedly used the general CloudLadder secret")
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
