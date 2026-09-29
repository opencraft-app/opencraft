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
		Preview:         1,
	})
	request := &GetPriceRequest{
		ActivityID: 164273735574009,
		Goods: []GetPriceGoodsItem{{
			ActID:           1862147936410255,
			PreferenceParam: map[string]interface{}{},
		}},
	}
	got, err := c.GetActivityPrice(context.Background(), request)
	if err != nil {
		t.Fatalf("GetActivityPrice err=%v", err)
	}
	if request.Preview != 0 {
		t.Fatalf("request Preview=%d, want 0", request.Preview)
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
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if got := para["preview"]; got != float64(1) {
		t.Fatalf("preview = %#v, want 1", got)
	}
}

func TestGetRenewPrice_UsesStagingOrderRouteAndRenewPayload(t *testing.T) {
	var gotPath string
	var gotBody []byte
	purchaseCalls := 0
	purchase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		purchaseCalls++
		http.Error(w, "renew request reached purchase upstream", http.StatusBadGateway)
	}))
	defer purchase.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"data":[{"act_id":1975812517099088,"price":100,"total_cost":100,"real_cost":50,"currency":"CNY","time_span":1,"time_unit":"m"}]}`))
	}))
	defer srv.Close()

	c := New("", purchase.URL+"/v1/proxy/dianshi-order/activity_web/activity/do_goods", Options{
		EventIDProvider: newFixedEventID(123),
		NowProvider:     newFixedClock(),
		RenewBaseURL:    srv.URL + "/v1/proxy/dianshi-order/activity_web/activity",
	})
	resp, err := c.GetRenewPrice(context.Background(), &GetRenewPriceRequest{
		Uin:        "330500000004",
		ActivityID: 166165503931688,
		Preview:    1,
		ClientInfo: map[string]string{"uin": "330500000004", "ownerUin": "330500000004"},
		GoodsRenew: []RenewPriceGoodsItem{{
			GoodsID:      1975812517099088,
			ResourceID:   "pass-90qg3c8q",
			TimeSpanUnit: "1m",
			BundleID:     "bundle_launch_01",
			RegionID:     8,
		}},
	})
	if err != nil {
		t.Fatalf("GetRenewPrice: %v", err)
	}
	if len(resp.PriceItems) != 1 || resp.PriceItems[0].RealCost != 50 {
		t.Fatalf("response=%+v", resp)
	}
	if gotPath != "/v1/proxy/dianshi-order/activity_web/activity/get_price_renew" {
		t.Fatalf("path=%q", gotPath)
	}
	if purchaseCalls != 0 {
		t.Fatalf("purchase upstream calls=%d, want 0", purchaseCalls)
	}
	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if sent.ComponentName != ComponentNamePrice || sent.Interface == nil || sent.Interface.InterfaceName != InterfaceNameActivityGetPrice {
		t.Fatalf("envelope=%+v", sent)
	}
	var para map[string]json.RawMessage
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if _, ok := para["goods"]; ok {
		t.Fatalf("renew request must not include purchase goods: %s", sent.Interface.Para)
	}
	var goods []map[string]any
	if err := json.Unmarshal(para["goods_renew"], &goods); err != nil {
		t.Fatalf("decode goods_renew: %v", err)
	}
	if len(goods) != 1 || goods[0]["goods_id"] != float64(1975812517099088) || goods[0]["resourceId"] != "pass-90qg3c8q" || goods[0]["timeSpanUnit"] != "1m" || goods[0]["bundleId"] != "bundle_launch_01" || goods[0]["regionId"] != float64(8) {
		t.Fatalf("goods_renew=%v", goods)
	}
	if _, ok := para["client_info"]; !ok {
		t.Fatalf("missing client_info: %s", sent.Interface.Para)
	}
}

func TestDoGoodsRenew_UsesRenewEndpointAndAutoPayOnlyWhenRequested(t *testing.T) {
	for _, tc := range []struct {
		name    string
		autoPay string
	}{
		{name: "console order"},
		{name: "internal order and pay", autoPay: "1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var path string
			var body []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path = r.URL.Path
				body, _ = io.ReadAll(r.Body)
				_, _ = w.Write([]byte(`{"returnCode":0,"data":{"deal_names":["202609290001"],"big_deal_no":"202609290001"}}`))
			}))
			defer srv.Close()
			c := New("", "http://example.invalid/activity_web/activity/do_goods", Options{
				RenewBaseURL: srv.URL + "/v1/proxy/dianshi-order/activity_web/activity",
			})
			_, err := c.DoGoodsRenew(context.Background(), &DoGoodsRenewRequest{
				Uin: "330500000004", ActivityID: 166165503931688, Preview: 1, AutoPay: tc.autoPay,
				ClientInfo: map[string]string{"uin": "330500000004", "ownerUin": "330500000004"},
				GoodsRenew: []RenewPriceGoodsItem{{GoodsID: 1975812517099088, ResourceID: "pass-90qg3c8q", TimeSpanUnit: "1m", BundleID: "bundle_launch_01", RegionID: 8}},
			})
			if err != nil {
				t.Fatalf("DoGoodsRenew: %v", err)
			}
			if path != "/v1/proxy/dianshi-order/activity_web/activity/do_goods_renew" {
				t.Fatalf("path=%q", path)
			}
			var sent envelope
			if err := json.Unmarshal(body, &sent); err != nil {
				t.Fatal(err)
			}
			if sent.Interface == nil || sent.Interface.InterfaceName != "do_goods_renew" {
				t.Fatalf("interface=%+v", sent.Interface)
			}
			var para map[string]json.RawMessage
			if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
				t.Fatal(err)
			}
			if _, ok := para["goods"]; ok {
				t.Fatalf("unexpected new-purchase goods: %s", sent.Interface.Para)
			}
			if _, ok := para["goods_renew"]; !ok {
				t.Fatalf("missing goods_renew: %s", sent.Interface.Para)
			}
			if tc.autoPay == "" {
				if _, ok := para["auto_pay"]; ok {
					t.Fatalf("unexpected auto_pay: %s", sent.Interface.Para)
				}
			} else if string(para["auto_pay"]) != `"1"` {
				t.Fatalf("auto_pay=%s", para["auto_pay"])
			}
		})
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
		Preview:         1,
	})
	checksum := CalcCheckSum("815836472", 164273735574009, "demo_secret")
	request := &DoGoodsRequest{
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
	}
	got, err := c.DoGoods(context.Background(), request)
	if err != nil {
		t.Fatalf("DoGoods err=%v", err)
	}
	if request.Preview != 0 {
		t.Fatalf("request Preview=%d, want 0", request.Preview)
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
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if got := para["preview"]; got != float64(1) {
		t.Fatalf("preview = %#v, want 1", got)
	}
}

func TestDoGoodsAndPay_Success(t *testing.T) {
	const sampleResp = `{
		"version":1,"componentName":"qcact-logic","eventId":966200588,
		"returnValue":0,"returnCode":0,"returnMessage":"成功",
		"data":{
			"deal_names":["20240809794064572803152"],
			"big_deal_no":"20240809794064572803142",
			"resource_ids":{"20240809794064572803152":["pass-paid-1"]}
		}
	}`

	var gotBody []byte
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleResp))
	}))
	defer srv.Close()

	c := New("", srv.URL+"/activity_web/activity/do_goods", Options{
		EventIDProvider: newFixedEventID(966200588),
		NowProvider:     newFixedClock(),
		Preview:         1,
	})
	request := &DoGoodsRequest{
		Uin:        "815836472",
		ActivityID: 164273735574009,
		Originate:  OriginateLightvelaTrade,
		Goods: []DoGoodsItem{{
			ActID: 1862147936410255,
			PreferenceParam: map[string]interface{}{
				"externalUserId": "usr_zero_order",
			},
		}},
	}

	got, err := c.DoGoodsAndPay(context.Background(), request)
	if err != nil {
		t.Fatalf("DoGoodsAndPay err=%v", err)
	}
	if gotPath != "/activity_web/activity/do_goods_and_pay" {
		t.Fatalf("path=%q want %q", gotPath, "/activity_web/activity/do_goods_and_pay")
	}
	if len(got.DealNames) != 1 || got.DealNames[0] != "20240809794064572803152" {
		t.Errorf("DealNames=%v", got.DealNames)
	}
	if got.BigDealNo != "20240809794064572803142" {
		t.Errorf("BigDealNo=%s", got.BigDealNo)
	}
	if len(got.ResourceIDs["20240809794064572803152"]) != 1 || got.ResourceIDs["20240809794064572803152"][0] != "pass-paid-1" {
		t.Fatalf("ResourceIDs=%v", got.ResourceIDs)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if sent.ComponentName != ComponentNameOrder {
		t.Errorf("componentName=%s want %s", sent.ComponentName, ComponentNameOrder)
	}
	if sent.Interface == nil || sent.Interface.InterfaceName != InterfaceNameDoGoodsAndPay {
		t.Errorf("interfaceName missing or wrong: %+v", sent.Interface)
	}
	if !strings.Contains(string(sent.Interface.Para), `"externalUserId":"usr_zero_order"`) {
		t.Errorf("para missing externalUserId: %s", string(sent.Interface.Para))
	}
}

func TestGetActivityPrice_DefaultPreviewOmitted(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	request := &GetPriceRequest{
		ActivityID: 1,
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	}
	if _, err := c.GetActivityPrice(context.Background(), request); err != nil {
		t.Fatalf("GetActivityPrice err=%v", err)
	}
	if request.Preview != 0 {
		t.Fatalf("request Preview=%d, want 0", request.Preview)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if _, ok := para["preview"]; ok {
		t.Fatalf("preview unexpectedly present: %s", sent.Interface.Para)
	}
	if _, ok := para["uin"]; ok {
		t.Fatalf("uin unexpectedly present without preview: %s", sent.Interface.Para)
	}
}

func TestGetActivityPrice_RequestPreviewOverridesDefault(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	request := &GetPriceRequest{
		ActivityID: 1,
		Preview:    1,
		Uin:        "450860000002",
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	}
	if _, err := c.GetActivityPrice(context.Background(), request); err != nil {
		t.Fatalf("GetActivityPrice err=%v", err)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if got := para["preview"]; got != float64(1) {
		t.Fatalf("preview = %#v, want 1", got)
	}
	if got := para["uin"]; got != "450860000002" {
		t.Fatalf("uin = %#v, want 450860000002", got)
	}
}

// TestGetActivityPrice_PreviewCarriesUin 锁定点石 preview 模式的成对约束：
// preview=1 时顶层 uin 必须出现在 para（缺 uin 点石返 returnCode=1100105 "商品ID不存在"，
// 见 commit 68aa66c73 与 2026-08-19 KR 联调实测）。
func TestGetActivityPrice_PreviewCarriesUin(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "", Options{Preview: 1})
	request := &GetPriceRequest{
		ActivityID: 1,
		Uin:        "450860000002",
		Goods:      []GetPriceGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	}
	if _, err := c.GetActivityPrice(context.Background(), request); err != nil {
		t.Fatalf("GetActivityPrice err=%v", err)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if got := para["preview"]; got != float64(1) {
		t.Fatalf("preview = %#v, want 1", got)
	}
	if got := para["uin"]; got != "450860000002" {
		t.Fatalf("uin = %#v, want 450860000002", got)
	}
}

func TestDoGoods_DefaultPreviewOmitted(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":{"deal_names":["d"],"big_deal_no":"b"}}`))
	}))
	defer srv.Close()

	c := New("", srv.URL)
	request := &DoGoodsRequest{
		Uin:        "1",
		ActivityID: 1,
		Goods:      []DoGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	}
	if _, err := c.DoGoods(context.Background(), request); err != nil {
		t.Fatalf("DoGoods err=%v", err)
	}
	if request.Preview != 0 {
		t.Fatalf("request Preview=%d, want 0", request.Preview)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if _, ok := para["preview"]; ok {
		t.Fatalf("preview unexpectedly present: %s", sent.Interface.Para)
	}
}

func TestDoGoods_RequestPreviewOverridesDefault(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"returnCode":0,"returnMessage":"ok","data":{"deal_names":["d"],"big_deal_no":"b"}}`))
	}))
	defer srv.Close()

	c := New("", srv.URL)
	request := &DoGoodsRequest{
		Uin:        "1",
		ActivityID: 1,
		Preview:    1,
		Goods:      []DoGoodsItem{{ActID: 1, PreferenceParam: map[string]interface{}{}}},
	}
	if _, err := c.DoGoods(context.Background(), request); err != nil {
		t.Fatalf("DoGoods err=%v", err)
	}

	var sent envelope
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	var para map[string]interface{}
	if err := json.Unmarshal(sent.Interface.Para, &para); err != nil {
		t.Fatalf("decode para: %v", err)
	}
	if got := para["preview"]; got != float64(1) {
		t.Fatalf("preview = %#v, want 1", got)
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
