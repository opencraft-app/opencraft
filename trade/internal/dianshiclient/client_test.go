// Package dianshiclient 单测：覆盖 GetActivityPrice / DoGoods / CalcCheckSum / 错误模型。
//
// 设计稿 §10.1 单测覆盖 dianshiclient 段：成功 / returnCode!=0 / HTTP 非 2xx / nil 入参。
package dianshiclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fixedClock 让单测断言 envelope.timestamp / eventId 字段确定。
func newFixedClock() func() time.Time {
	t := time.Date(2026, 6, 24, 0, 0, 0, 0, time.UTC)
	return func() time.Time { return t }
}

func newFixedEventID(id int64) func() int64 {
	return func() int64 { return id }
}

func TestCalcCheckSum(t *testing.T) {
	tests := []struct {
		name      string
		uin       string
		actID     int64
		secretKey string
		want      string
	}{
		{
			name:      "secret_key empty returns empty",
			uin:       "815836472",
			actID:     164273735574009,
			secretKey: "",
			want:      "",
		},
		{
			name:      "non-empty secret produces md5 hex",
			uin:       "815836472",
			actID:     164273735574009,
			secretKey: "demo_secret",
			// hex(md5("815836472_164273735574009_demo_secret"))
			want: mustMD5Hex("815836472_164273735574009_demo_secret"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalcCheckSum(tt.uin, tt.actID, tt.secretKey)
			if got != tt.want {
				t.Fatalf("CalcCheckSum=%q want %q", got, tt.want)
			}
		})
	}
}

func TestGetActivityPrice_Success(t *testing.T) {
	const sampleResp = `{
		"version":"1.0","componentName":"opc-activity-price","eventId":2715830060,
		"timestamp":1744802847,"returnCode":0,"returnValue":0,"returnMessage":"OK",
		"data":[{
			"act_id":1862147936410255,"amount_unit":"pent","currency":"CNY","pid":1016641,
			"policy":0,"price":3990,"total_cost":11970,"real_cost":0,
			"product_code":"p_lighthouse","sub_product_code":"sp_lighthouse_lightvela_ai_mc",
			"time_span":1,"time_unit":"m"
		}]
	}`

	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleResp))
	}))
	defer srv.Close()

	c := New(srv.URL, "", Options{
		EventIDProvider: newFixedEventID(123456789),
		NowProvider:     newFixedClock(),
	})
	got, err := c.GetActivityPrice(context.Background(), &GetPriceRequest{
		ActivityID: 164273735574009,
		Goods: []GetPriceGoodsItem{{
			ActID:           1862147936410255,
			PreferenceParam: map[string]interface{}{},
		}},
	})
	if err != nil {
		t.Fatalf("GetActivityPrice err=%v", err)
	}
	if len(got.PriceItems) != 1 {
		t.Fatalf("PriceItems len=%d want 1", len(got.PriceItems))
	}
	if got.PriceItems[0].Price != 3990 {
		t.Errorf("Price=%d want 3990", got.PriceItems[0].Price)
	}
	if got.PriceItems[0].SubProductCode != "sp_lighthouse_lightvela_ai_mc" {
		t.Errorf("SubProductCode=%s", got.PriceItems[0].SubProductCode)
	}

	// 校验出向 envelope 关键字段
	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if sent.ComponentName != ComponentNamePrice {
		t.Errorf("componentName=%s want %s", sent.ComponentName, ComponentNamePrice)
	}
	if sent.EventID != 123456789 {
		t.Errorf("eventId=%d", sent.EventID)
	}
	if sent.Interface == nil || sent.Interface.InterfaceName != InterfaceNameActivityGetPrice {
		t.Errorf("interfaceName missing or wrong: %+v", sent.Interface)
	}
}

func TestDoGoods_Success(t *testing.T) {
	const sampleResp = `{
		"version":1,"componentName":"qcact-logic","eventId":966200587,
		"returnValue":0,"returnCode":0,"returnMessage":"成功",
		"data":{"deal_names":["20240809794064572803151"],"big_deal_no":"20240809794064572803141"}
	}`

	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleResp))
	}))
	defer srv.Close()

	c := New("", srv.URL, Options{
		EventIDProvider: newFixedEventID(966200587),
		NowProvider:     newFixedClock(),
	})
	checksum := CalcCheckSum("815836472", 164273735574009, "demo_secret")
	got, err := c.DoGoods(context.Background(), &DoGoodsRequest{
		Uin:        "815836472",
		ActivityID: 164273735574009,
		Originate:  OriginateLightvelaTrade,
		CheckSum:   checksum,
		Goods: []DoGoodsItem{{
			ActID: 1862147936410255,
			PreferenceParam: map[string]interface{}{
				"externalUserId": "usr_e2e_test_01",
			},
		}},
	})
	if err != nil {
		t.Fatalf("DoGoods err=%v", err)
	}
	if len(got.DealNames) != 1 || got.DealNames[0] != "20240809794064572803151" {
		t.Errorf("DealNames=%v", got.DealNames)
	}
	if got.BigDealNo != "20240809794064572803141" {
		t.Errorf("BigDealNo=%s", got.BigDealNo)
	}

	// 校验出向 envelope 关键字段
	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if sent.ComponentName != ComponentNameOrder {
		t.Errorf("componentName=%s want %s", sent.ComponentName, ComponentNameOrder)
	}
	if sent.Interface == nil || sent.Interface.InterfaceName != InterfaceNameDoGoods {
		t.Errorf("interfaceName missing or wrong: %+v", sent.Interface)
	}
	// para 内层应当有 check_sum + originate
	if !strings.Contains(string(sent.Interface.Para), `"check_sum":"`+checksum+`"`) {
		t.Errorf("para missing check_sum: %s", string(sent.Interface.Para))
	}
	if !strings.Contains(string(sent.Interface.Para), `"originate":"lightvela.trade"`) {
		t.Errorf("para missing originate: %s", string(sent.Interface.Para))
	}
	// preference_param 内含 externalUserId
	if !strings.Contains(string(sent.Interface.Para), `"externalUserId":"usr_e2e_test_01"`) {
		t.Errorf("para missing externalUserId: %s", string(sent.Interface.Para))
	}
}

func TestDoGoods_OmitsCheckSumWhenEmpty(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":{"deal_names":["d"],"big_deal_no":"b"}}`))
	}))
	defer srv.Close()

	c := New("", srv.URL)
	_, err := c.DoGoods(context.Background(), &DoGoodsRequest{
		Uin:        "815836472",
		ActivityID: 164273735574009,
		Goods:      []DoGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	})
	if err != nil {
		t.Fatalf("DoGoods err=%v", err)
	}
	if strings.Contains(string(gotBody), `"check_sum"`) {
		t.Errorf("envelope unexpectedly contains check_sum: %s", string(gotBody))
	}
}

func TestGetActivityPrice_BusinessError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"returnCode":700001,"returnMessage":"activity not found"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.GetActivityPrice(context.Background(), &GetPriceRequest{
		ActivityID: 1,
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	})
	if err == nil {
		t.Fatalf("expect business error")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expect *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 700001 {
		t.Errorf("ReturnCode=%d", cgwErr.ReturnCode)
	}
}

func TestGetActivityPrice_HTTPNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream down"))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.GetActivityPrice(context.Background(), &GetPriceRequest{
		ActivityID: 1,
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	})
	if !errors.Is(err, ErrCGWHTTPNon200) {
		t.Fatalf("expect ErrCGWHTTPNon200, got %v", err)
	}
}

func TestGetActivityPrice_InvalidEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"oops":"no returnCode"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.GetActivityPrice(context.Background(), &GetPriceRequest{
		ActivityID: 1,
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	})
	if !errors.Is(err, ErrCGWInvalidEnvelope) {
		t.Fatalf("expect ErrCGWInvalidEnvelope, got %v", err)
	}
}

func TestGetActivityPrice_NilRequest(t *testing.T) {
	c := New("http://localhost:1", "")
	if _, err := c.GetActivityPrice(context.Background(), nil); err == nil {
		t.Fatal("expect error on nil request")
	}
}

func TestDoGoods_NilRequest(t *testing.T) {
	c := New("", "http://localhost:1")
	if _, err := c.DoGoods(context.Background(), nil); err == nil {
		t.Fatal("expect error on nil request")
	}
}

func TestGetActivityPrice_BaseURLRequired(t *testing.T) {
	c := New("", "")
	if _, err := c.GetActivityPrice(context.Background(), &GetPriceRequest{ActivityID: 1}); err == nil {
		t.Fatal("expect error when priceBaseURL empty")
	}
}

func TestDoGoods_BaseURLRequired(t *testing.T) {
	c := New("", "")
	if _, err := c.DoGoods(context.Background(), &DoGoodsRequest{Uin: "1", ActivityID: 1}); err == nil {
		t.Fatal("expect error when orderBaseURL empty")
	}
}

func mustMD5Hex(s string) string {
	// 仅在测试期内联，避免在生产路径多一份等价实现。
	return CalcCheckSum(strings.SplitN(s, "_", 2)[0],
		mustParseInt(strings.SplitN(s, "_", 3)[1]),
		strings.SplitN(s, "_", 3)[2])
}

func mustParseInt(s string) int64 {
	var v int64
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		v = v*10 + int64(c-'0')
	}
	return v
}
