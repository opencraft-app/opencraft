package resourcebillingclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestSendResourcePostsBillingPayloadAndAcceptsDuplicate(t *testing.T) {
	var got Request
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Host != "qbilling.itd.com" {
			t.Fatalf("host=%q", r.Host)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		body := `{"retCode":0,"returnCode":0,"msg":"suc","data":{"resourceCnt":{"receivedCount":1,"totalCount":1,"succCount":0,"duplicateCount":1}}}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	client := New("http://9.139.137.40/feev2/sendResource.php", "qbilling.itd.com", httpClient)

	resp, err := client.SendResource(context.Background(), Request{
		CID: "101433", CalcDate: "20260904",
		Data: map[string][]Resource{"700000164995": {{SerialID: "cpkg-1", Uin: "700000164995", AppID: 1300000001}}},
	})
	if err != nil {
		t.Fatalf("send resource: %v", err)
	}
	if resp.Data.ResourceCount.DuplicateCount != 1 || got.CID != "101433" || got.CalcDate != "20260904" {
		t.Fatalf("unexpected request/response: got=%+v resp=%+v", got, resp)
	}
}
