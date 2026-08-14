package paymentmethod

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestListUsesTemporaryCredentialsAndServerPlatform(t *testing.T) {
	t.Parallel()

	var captured *http.Request
	var capturedBody map[string]any
	client, err := NewTencentCloudClient(Config{
		Endpoint: "billing.test.tencentcloudapi.com",
		Region:   "ap-guangzhou",
		Platform: "intlSaaSLightvela",
		HTTPTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			captured = req.Clone(req.Context())
			if err := json.NewDecoder(req.Body).Decode(&capturedBody); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			return jsonResponse(req, `{
				"Response": {
					"Total": 1,
					"SignList": [{
						"ContractCode": "contract-1",
						"Extend": "555555****4444",
						"IsDefault": 1,
						"PayerName": "Jane Doe",
						"Type": "CREDIT_CARD"
					}],
					"RequestId": "request-1"
				}
			}`), nil
		}),
	})
	if err != nil {
		t.Fatalf("NewTencentCloudClient: %v", err)
	}

	result, err := client.List(context.Background(), TemporaryCredentials{
		SecretID:  "tmp-secret-id",
		SecretKey: "tmp-secret-key",
		Token:     "tmp-token",
		ExpiresAt: time.Now().Add(time.Hour),
	}, ListInput{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if captured == nil {
		t.Fatal("expected request")
	}
	if got := exactHeader(captured.Header, "X-TC-Action"); got != "DescribeSignInfo" {
		t.Fatalf("X-TC-Action = %q", got)
	}
	if auth := captured.Header.Get("Authorization"); !strings.Contains(auth, "Credential=tmp-secret-id/") {
		t.Fatalf("Authorization = %q, want temporary secret id", auth)
	}
	if got := exactHeader(captured.Header, "X-TC-Token"); got != "tmp-token" {
		t.Fatalf("X-TC-Token = %q", got)
	}
	if got := capturedBody["Platform"]; got != "intlSaaSLightvela" {
		t.Fatalf("Platform = %#v", got)
	}
	if got := int(capturedBody["Page"].(float64)); got != 1 {
		t.Fatalf("Page = %d", got)
	}
	if got := int(capturedBody["PageSize"].(float64)); got != 20 {
		t.Fatalf("PageSize = %d", got)
	}
	if result.Total != 1 || len(result.Items) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	card := result.Items[0]
	if card.ContractCode != "contract-1" || card.MaskedNumber != "555555****4444" || !card.IsDefault {
		t.Fatalf("unexpected card: %+v", card)
	}
}

func TestCreateSignOrderReturnsPaymentLink(t *testing.T) {
	t.Parallel()

	client, err := NewTencentCloudClient(Config{
		Endpoint:          "billing.test.tencentcloudapi.com",
		Region:            "ap-guangzhou",
		Platform:          "intlSaaSLightvela",
		Source:            "REGISTER",
		ChannelMerchantID: "76317828081018416",
		HTTPTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			var body map[string]any
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if got := exactHeader(req.Header, "X-TC-Action"); got != "CreateSignOrder" {
				t.Fatalf("X-TC-Action = %q", got)
			}
			if body["Source"] != "REGISTER" || body["Platform"] != "intlSaaSLightvela" || body["ChannelMerchantId"] != "76317828081018416" {
				t.Fatalf("unexpected server parameters: %+v", body)
			}
			if body["ReturnUrl"] != "https://lightvela.ai/account/?payment-method=success" {
				t.Fatalf("ReturnUrl = %#v", body["ReturnUrl"])
			}
			return jsonResponse(req, `{
				"Response": {
					"ContractCode": "contract-2",
					"SignOrder": "{\"links\":[{\"method\":\"GET\",\"rel\":\"SELF\",\"href\":\"https://example.invalid/self\"},{\"method\":\"GET\",\"rel\":\"PAYMENT\",\"href\":\"https://sandbox-card.example/sign?token=opaque\"}]}",
					"RequestId": "request-2"
				}
			}`), nil
		}),
	})
	if err != nil {
		t.Fatalf("NewTencentCloudClient: %v", err)
	}

	result, err := client.CreateSignOrder(context.Background(), TemporaryCredentials{
		SecretID:  "tmp-secret-id",
		SecretKey: "tmp-secret-key",
		Token:     "tmp-token",
		ExpiresAt: time.Now().Add(time.Hour),
	}, CreateSignOrderInput{
		ReturnURL:    "https://lightvela.ai/account/?payment-method=success",
		CancelURL:    "https://lightvela.ai/account/?payment-method=cancelled",
		LanguageCode: "en",
	})
	if err != nil {
		t.Fatalf("CreateSignOrder: %v", err)
	}
	if result.ContractCode != "contract-2" || result.RedirectURL != "https://sandbox-card.example/sign?token=opaque" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestModifyAndDeleteUseContractCode(t *testing.T) {
	t.Parallel()

	actions := make([]string, 0, 2)
	client, err := NewTencentCloudClient(Config{
		Endpoint: "billing.test.tencentcloudapi.com",
		Region:   "ap-guangzhou",
		Platform: "intlSaaSLightvela",
		HTTPTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			actions = append(actions, exactHeader(req.Header, "X-TC-Action"))
			var body map[string]any
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if body["ContractCode"] != "contract-3" || body["Platform"] != "intlSaaSLightvela" {
				t.Fatalf("unexpected request: %+v", body)
			}
			return jsonResponse(req, `{"Response":{"RequestId":"request-ok"}}`), nil
		}),
	})
	if err != nil {
		t.Fatalf("NewTencentCloudClient: %v", err)
	}
	creds := TemporaryCredentials{SecretID: "tmp-id", SecretKey: "tmp-key", Token: "tmp-token", ExpiresAt: time.Now().Add(time.Hour)}
	if err := client.SetDefault(context.Background(), creds, "contract-3"); err != nil {
		t.Fatalf("SetDefault: %v", err)
	}
	if err := client.Delete(context.Background(), creds, "contract-3"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := strings.Join(actions, ","); got != "ModifySignInfo,DeleteSignInfo" {
		t.Fatalf("actions = %q", got)
	}
}

func TestDefaultCardDeleteErrorIsRecognized(t *testing.T) {
	t.Parallel()

	err := &CloudError{Code: "FailedOperation.DefaultCardNoDelete", Message: "default card cannot be deleted"}
	if !IsDefaultCardDeleteError(err) {
		t.Fatalf("expected default-card delete error, got %v", err)
	}
}

func jsonResponse(req *http.Request, body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func exactHeader(header http.Header, key string) string {
	values := header[key]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
