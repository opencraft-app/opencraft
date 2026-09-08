package inquiry

import (
	"context"
	"errors"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 变配询价（同 SP 升配）。需求：TAPD 1010132091137784162 §4.1 / §5.1

const (
	modifySourceBundleID = "bundle_sail"
	modifyTargetBundleID = "bundle_cruise"

	// 变配询价报文里 oldConfig/newConfig 各自内层必须自带的三件套真值。
	// 单点定义，避免用例与断言两处写死后漂移。
	modifyProductCode    = "p_lighthouse"
	modifySubProductCode = "sp_lightvela_cn"
	modifyPid            = int64(4001)
)

// modifyDefs 构造一对同 SP 的源/目标 BundleDefinition。
// 目标套餐带 scene=modify 的 categoryId；源套餐刻意不带，验证 categoryId 取目标侧。
func modifyDefs() map[string]*store.BundleDefinition {
	source := &store.BundleDefinition{
		BundleID:       modifySourceBundleID,
		ProductCode:    modifyProductCode,
		SubProductCode: modifySubProductCode,
		Pid:            modifyPid,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100059},
			{Scene: "renew", Category: 100060},
		},
		SVList:      map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		ProductInfo: []map[string]interface{}{{"k": "v"}},
	}
	target := &store.BundleDefinition{
		BundleID:       modifyTargetBundleID,
		ProductCode:    modifyProductCode,
		SubProductCode: modifySubProductCode,
		Pid:            modifyPid,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100061},
			{Scene: "modify", Category: 2025048},
		},
		SVList: map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
	}
	return map[string]*store.BundleDefinition{
		modifySourceBundleID: source,
		modifyTargetBundleID: target,
	}
}

func stdQuoteModifyReq() QuoteModifyRequest {
	return QuoteModifyRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		ResourceID:     "lhpass-r1",
		SourceBundleID: modifySourceBundleID,
		TargetBundleID: modifyTargetBundleID,
		CurDeadline:    "2026-06-15 10:30:00",
		PayMode:        1,
	}
}

func newModifySvc(t *testing.T, siteKind string, defs map[string]*store.BundleDefinition) (*Service, *fakeJifei) {
	t.Helper()
	ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, id string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: id, BundleName: "Cruise", BundleState: "ONLINE"}, nil
	}}
	jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return stdJifeiPriceResp(), nil
	}}
	svc := New(Deps{
		CTLClient:   ctl,
		BundleStore: &fakeBundleStore{defs: defs},
		JifeiClient: jc,
		SiteKind:    siteKind,
	})
	return svc, jc
}

// 变配询价的出向 goodsDetail 是这条链路最关键的契约：顶层是源套餐（"现在是什么"），
// newConfig 是目标套餐（"要变成什么"），bundleId / newBundleId 供 checkModify 回调反解。
func TestQuoteModifyBuildsOldAndNewConfig(t *testing.T) {
	svc, jc := newModifySvc(t, "cn", modifyDefs())

	got, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 回显目标 bundle：调用方按 target_bundle_id 归位报价。
	if got.BundleID != modifyTargetBundleID {
		t.Errorf("BundleID = %q, want %q", got.BundleID, modifyTargetBundleID)
	}
	if got.RealTotalCost != "35.10" {
		t.Errorf("RealTotalCost = %q, want 35.10", got.RealTotalCost)
	}

	args := jc.lastGetPriceArgs
	if args == nil || len(args.ResInfo) != 1 {
		t.Fatalf("expected exactly one ResInfo item, got %+v", args)
	}
	res := args.ResInfo[0]
	if res.GoodsCategoryID != 2025048 {
		t.Errorf("GoodsCategoryID = %d, want 2025048 (target bundle scene=modify)", res.GoodsCategoryID)
	}
	if res.Action != "" {
		t.Errorf("Action = %q, want empty (categoryId 已定场景)", res.Action)
	}
	if res.GoodsNum != 1 {
		t.Errorf("GoodsNum = %d, want 1", res.GoodsNum)
	}

	gd := res.GoodsDetail
	if gd["resourceId"] != "lhpass-r1" {
		t.Errorf("goodsDetail.resourceId = %v", gd["resourceId"])
	}
	if gd["curDeadline"] != "2026-06-15 10:30:00" {
		t.Errorf("goodsDetail.curDeadline = %v", gd["curDeadline"])
	}
	if gd["bundleId"] != modifySourceBundleID || gd["newBundleId"] != modifyTargetBundleID {
		t.Errorf("bundleId/newBundleId = %v/%v, want %q/%q",
			gd["bundleId"], gd["newBundleId"], modifySourceBundleID, modifyTargetBundleID)
	}
	// 顶层 sv_* 来自源套餐
	if gd["sv_cpu"] != int64(2) || gd["sv_mem"] != int64(4) {
		t.Errorf("top-level sv_* should mirror source bundle, got cpu=%v mem=%v", gd["sv_cpu"], gd["sv_mem"])
	}
	oldConfig, ok := gd["oldConfig"].(map[string]interface{})
	if !ok {
		t.Fatalf("oldConfig type = %T, want map[string]interface{}", gd["oldConfig"])
	}
	if oldConfig["sv_cpu"] != int64(2) || oldConfig["sv_disk"] != int64(60) {
		t.Errorf("oldConfig = %v, want source sv list", oldConfig)
	}
	newConfig, ok := gd["newConfig"].(map[string]interface{})
	if !ok {
		t.Fatalf("newConfig type = %T, want map[string]interface{}", gd["newConfig"])
	}
	if newConfig["sv_cpu"] != int64(4) || newConfig["sv_mem"] != int64(8) || newConfig["sv_disk"] != int64(80) {
		t.Errorf("newConfig = %v, want target sv list", newConfig)
	}
	// oldConfig / newConfig 必须各自自描述：计费变配场景读内层 pid 定位价格模型，
	// 不会回退到顶层 pid。缺这三个字段实测报 371008 "get price error:pid not found"。
	assertModifyConfigSelfDescribing(t, "oldConfig", oldConfig)
	assertModifyConfigSelfDescribing(t, "newConfig", newConfig)
	// 变配不改到期时间，goodsDetail 不该带时长字段。
	if _, exists := gd["timeSpan"]; exists {
		t.Errorf("goodsDetail should not carry timeSpan for modify: %+v", gd)
	}
	if _, exists := gd["timeUnit"]; exists {
		t.Errorf("goodsDetail should not carry timeUnit for modify: %+v", gd)
	}
}

// TestQuoteModifyUsesEachSubProductOwnBillingIdentity 覆盖 §10.1 的四 SP 映射。
//
// 需求 §三 明确写了 Modify CategoryID「不能跨站/跨 SP 复用或根据连续编号猜测」。
// 四个 SP 的 PID / CategoryID / SV 各不相同，一旦询价把别的 SP 的计费身份带出去，
// 计费侧会按错误的资源集合定价——这类错误在单 SP 的用例里看不出来，因为只有一份定义。
//
// 这里给四个 SP 各配一套互不相同的 PID / categoryId / SV，断言出向请求取的是当前
// 站点+套餐那一套；AI 路径额外断言 credit SV 被带上（§10.1「AI 路径包含 credit SV」）。
func TestQuoteModifyUsesEachSubProductOwnBillingIdentity(t *testing.T) {
	cases := []struct {
		name         string
		siteKind     string
		subProduct   string
		pid          int64
		modifyCateg  int64
		sourceSV     map[string]int64
		targetSV     map[string]int64
		wantCreditSV string
	}{
		{
			name:        "国内通用",
			siteKind:    "cn",
			subProduct:  "sp_lighthouse_lightvela_mc",
			pid:         1059119,
			modifyCateg: 2025048,
			sourceSV: map[string]int64{
				"sv_lighthouse_lv_compute_launch_mc_med4_01": 1,
				"sv_lighthouse_lv_disk_launch_mc_50gb":       1,
			},
			targetSV: map[string]int64{
				"sv_lighthouse_lv_compute_cruise_mc_lg8_01": 1,
				"sv_lighthouse_lv_disk_cruise_mc_80gb":      1,
			},
		},
		{
			name:        "国内 AI",
			siteKind:    "cn",
			subProduct:  "sp_lighthouse_lightvela_ai_mc",
			pid:         1060103,
			modifyCateg: 2025275,
			sourceSV: map[string]int64{
				"sv_lighthouse_lv_ai_compute_launch_mc_med4_01": 1,
				"sv_lighthouse_lv_ai_credit_launch_mc_01":       1,
			},
			targetSV: map[string]int64{
				"sv_lighthouse_lv_ai_compute_cruise_mc_lg8_01": 1,
				"sv_lighthouse_lv_ai_credit_cruise_mc_01":      1,
			},
			wantCreditSV: "sv_lighthouse_lv_ai_credit_cruise_mc_01",
		},
		{
			name:        "国际通用",
			siteKind:    "intl",
			subProduct:  "sp_lighthouse_lightvela_bundle_intl",
			pid:         1059132,
			modifyCateg: 2025257,
			sourceSV:    map[string]int64{"sv_lighthouse_lv_compute_launch_intl_med4_01": 1},
			targetSV:    map[string]int64{"sv_lighthouse_lv_compute_cruise_intl_lg8_01": 1},
		},
		{
			name:         "国际 AI",
			siteKind:     "intl",
			subProduct:   "sp_lighthouse_lightvela_ai_intl",
			pid:          1060119,
			modifyCateg:  2025272,
			sourceSV:     map[string]int64{"sv_lighthouse_lv_ai_credit_launch_intl_01": 1},
			targetSV:     map[string]int64{"sv_lighthouse_lv_ai_credit_cruise_intl_01": 1},
			wantCreditSV: "sv_lighthouse_lv_ai_credit_cruise_intl_01",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defs := map[string]*store.BundleDefinition{
				modifySourceBundleID: {
					BundleID:       modifySourceBundleID,
					ProductCode:    "p_lighthouse",
					SubProductCode: tc.subProduct,
					Pid:            tc.pid,
					CategoryIDs:    []store.CategoryIDEntry{{Scene: "purchase", Category: 1}},
					SVList:         tc.sourceSV,
				},
				modifyTargetBundleID: {
					BundleID:       modifyTargetBundleID,
					ProductCode:    "p_lighthouse",
					SubProductCode: tc.subProduct,
					Pid:            tc.pid,
					CategoryIDs:    []store.CategoryIDEntry{{Scene: "modify", Category: tc.modifyCateg}},
					SVList:         tc.targetSV,
				},
			}
			svc, jc := newModifySvc(t, tc.siteKind, defs)
			if tc.siteKind == "intl" {
				// 国际站询价强制要求 taxDetail，否则 fail-closed。本用例只关心出向
				// 计费身份，金额换算由 TestQuoteModifyIntlReturnsCentsAndTax 覆盖。
				jc.getPriceFn = func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
					return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{{
						Price: "100", TotalCost: "100", RealTotalCost: "100", Currency: "USD",
						TaxDetail: &jifeiclient.TaxDetail{TaxRate: "0.07"},
						HighPrecisionPrice: &jifeiclient.HighPrecisionPrice{
							PriceHigh: "100000000", TotalCostHigh: "100000000", RealTotalCostHigh: "100000000",
						},
					}}}, nil
				}
			}

			if _, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq()); err != nil {
				t.Fatalf("QuoteModify: %v", err)
			}

			args := jc.lastGetPriceArgs
			if args == nil || len(args.ResInfo) != 1 {
				t.Fatalf("expected one ResInfo item, got %+v", args)
			}
			res := args.ResInfo[0]
			if res.GoodsCategoryID != tc.modifyCateg {
				t.Errorf("GoodsCategoryID = %d, want %d (this SP's own modify category)",
					res.GoodsCategoryID, tc.modifyCateg)
			}
			gd := res.GoodsDetail
			if gd["subProductCode"] != tc.subProduct {
				t.Errorf("goodsDetail.subProductCode = %v, want %q", gd["subProductCode"], tc.subProduct)
			}
			if gd["pid"] != tc.pid {
				t.Errorf("goodsDetail.pid = %v, want %d", gd["pid"], tc.pid)
			}

			oldConfig, ok := gd["oldConfig"].(map[string]interface{})
			if !ok {
				t.Fatalf("oldConfig type = %T", gd["oldConfig"])
			}
			newConfig, ok := gd["newConfig"].(map[string]interface{})
			if !ok {
				t.Fatalf("newConfig type = %T", gd["newConfig"])
			}
			// 每个 SP 的内层三件套必须是自己那套，不能串台。
			for label, config := range map[string]map[string]interface{}{
				"oldConfig": oldConfig, "newConfig": newConfig,
			} {
				if config["subProductCode"] != tc.subProduct {
					t.Errorf("%s.subProductCode = %v, want %q", label, config["subProductCode"], tc.subProduct)
				}
				if config["pid"] != tc.pid {
					t.Errorf("%s.pid = %v, want %d", label, config["pid"], tc.pid)
				}
			}
			assertSVListEqual(t, "oldConfig", oldConfig, tc.sourceSV)
			assertSVListEqual(t, "newConfig", newConfig, tc.targetSV)

			if tc.wantCreditSV != "" && newConfig[tc.wantCreditSV] == nil {
				t.Errorf("newConfig missing credit SV %q: %v", tc.wantCreditSV, newConfig)
			}
		})
	}
}

// assertSVListEqual 要求 sv_* 逐键相等，多一个 sv_* 也算错——SV 集合是计费定价的输入，
// 混进别的 SP 的 SV 会让计费按错误资源组合算钱。
//
// 只比 sv_* 前缀键：oldConfig / newConfig 里还有协议要求的 pid / productCode /
// subProductCode 三件套，它们由 assertModifyConfigSelfDescribing 单独校验。
func assertSVListEqual(t *testing.T, label string, got map[string]interface{}, want map[string]int64) {
	t.Helper()
	gotSV := map[string]int64{}
	for k, v := range got {
		if !strings.HasPrefix(k, "sv_") {
			continue
		}
		n, ok := v.(int64)
		if !ok {
			t.Errorf("%s[%q] type = %T, want int64", label, k, v)
			continue
		}
		gotSV[k] = n
	}
	if len(gotSV) != len(want) {
		t.Errorf("%s has %d sv_* entries (%v), want %d (%v)", label, len(gotSV), gotSV, len(want), want)
		return
	}
	for k, v := range want {
		if gotSV[k] != v {
			t.Errorf("%s[%q] = %d, want %d (full: %v)", label, k, gotSV[k], v, gotSV)
		}
	}
}

// assertModifyConfigSelfDescribing 校验 oldConfig / newConfig 自带 pid 三件套。
//
// 这是变配询价协议（iwiki 746616075）的硬要求，也是本链路踩过的真实坑：
// 只在 goodsDetail 顶层给 pid 时，计费变配场景返回 371008 "get price error:pid not found"。
func assertModifyConfigSelfDescribing(t *testing.T, label string, config map[string]interface{}) {
	t.Helper()
	if config["pid"] != modifyPid {
		t.Errorf("%s.pid = %v, want %d", label, config["pid"], modifyPid)
	}
	if config["productCode"] != modifyProductCode {
		t.Errorf("%s.productCode = %v, want %q", label, config["productCode"], modifyProductCode)
	}
	if config["subProductCode"] != modifySubProductCode {
		t.Errorf("%s.subProductCode = %v, want %q", label, config["subProductCode"], modifySubProductCode)
	}
}

// oldConfig / newConfig 必须是 BundleDefinition.SVList 的副本，
// 否则调用方（或 jifei 序列化前的任何一步）改了 map 会污染 BundleDefinition 缓存。
func TestQuoteModifyDoesNotAliasBundleSVList(t *testing.T) {
	defs := modifyDefs()
	svc, jc := newModifySvc(t, "cn", defs)

	if _, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	gd := jc.lastGetPriceArgs.ResInfo[0].GoodsDetail
	newConfig := gd["newConfig"].(map[string]interface{})
	newConfig["sv_cpu"] = int64(999)

	if defs[modifyTargetBundleID].SVList["sv_cpu"] != 4 {
		t.Errorf("mutating newConfig leaked into BundleDefinition.SVList: %v",
			defs[modifyTargetBundleID].SVList)
	}
}

func TestQuoteModifyIntlInjectsPointOfSale(t *testing.T) {
	svc, jc := newModifySvc(t, "intl", modifyDefs())
	// 国际站走 USD 分支，需要 taxDetail / highPrecisionPrice。
	jc.getPriceFn = func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return stdIntlJifeiPriceResp(), nil
	}

	if _, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	res := jc.lastGetPriceArgs.ResInfo[0]
	if res.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", res.Currency)
	}
	assertIntlPointOfSale(t, res.GoodsDetail)
}

// TestQuoteModifyIntlReturnsCentsAndTax 覆盖国际站变配的返回金额（§10.1）。
//
// 上一条只断言了出向请求（币种 + point of sale）。这条断言返回值：国际站的六字段
// 必须走高精度分支并算出 tax_price，与新购、续费**同一套**换算。变配漏掉高精度
// 或税额不会报错，只会让用户在确认页看到一个偏小的美元差价。
func TestQuoteModifyIntlReturnsCentsAndTax(t *testing.T) {
	svc, jc := newModifySvc(t, "intl", modifyDefs())
	jc.getPriceFn = func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{{
			// 低精度字段刻意给一个明显错的值：高精度分支必须覆盖它们。
			Price:         "999999",
			TotalCost:     "999999",
			RealTotalCost: "999999",
			Currency:      "USD",
			TaxDetail:     &jifeiclient.TaxDetail{TaxRate: "0.07"},
			HighPrecisionPrice: &jifeiclient.HighPrecisionPrice{
				PriceHigh:         "650000000",
				TotalCostHigh:     "1400000000",
				RealTotalCostHigh: "1200000000",
			},
		}}}, nil
	}

	got, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
	if err != nil {
		t.Fatalf("QuoteModify: %v", err)
	}
	// 与新购 / 续费同一组期望值（service_site_kind_test.go 同款 fixture）：
	// 换算口径必须逐分一致，否则同一笔钱在三个场景显示不同。
	if got.Price != "650" || got.TotalCost != "1400" || got.TaxPrice != "84" || got.RealTotalCost != "1284" {
		t.Fatalf("amounts = price:%s total:%s tax:%s real:%s, want 650/1400/84/1284",
			got.Price, got.TotalCost, got.TaxPrice, got.RealTotalCost)
	}
	if got.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", got.Currency)
	}
}

func TestQuoteModifyInvalidInput(t *testing.T) {
	svc := newSvcStub()
	base := stdQuoteModifyReq()
	cases := []struct {
		name  string
		mutID func(*QuoteModifyRequest)
		want  string
	}{
		{"missing resource_id", func(r *QuoteModifyRequest) { r.ResourceID = "" }, "resource_id"},
		{"missing source", func(r *QuoteModifyRequest) { r.SourceBundleID = "" }, "source_bundle_id"},
		{"missing target", func(r *QuoteModifyRequest) { r.TargetBundleID = "" }, "target_bundle_id"},
		{"same source and target", func(r *QuoteModifyRequest) { r.TargetBundleID = r.SourceBundleID }, "must differ"},
		{"missing cur_deadline", func(r *QuoteModifyRequest) { r.CurDeadline = "" }, "cur_deadline"},
		{"missing uin without shadow", func(r *QuoteModifyRequest) { r.Uin = "" }, "uin"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := base
			c.mutID(&req)
			_, err := svc.QuoteModify(context.Background(), req)
			if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want ErrInvalidInput containing %q", err, c.want)
			}
		})
	}
}

// 跨 SP 变配本期不支持：计费的变配接入单是按 SP 配的，跨 SP 询价只会拿到语义不明的报价。
func TestQuoteModifyRejectsCrossSubProduct(t *testing.T) {
	defs := modifyDefs()
	defs[modifyTargetBundleID].SubProductCode = "sp_lightvela_ai_cn"
	svc, _ := newModifySvc(t, "cn", defs)

	_, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
	if !errors.Is(err, ErrModifyCrossSubProduct) {
		t.Fatalf("err = %v, want ErrModifyCrossSubProduct", err)
	}
}

// 目标套餐没配 scene=modify 的 categoryId 时 fail-closed。
// 各站点/SP 的 Modify CategoryID 要按计费接入单配置后写入 BundleDefinition（§3）；
// 缺配置时报错比拿一个猜的 categoryId 去询价安全得多。
func TestQuoteModifyRequiresModifyCategoryID(t *testing.T) {
	defs := modifyDefs()
	defs[modifyTargetBundleID].CategoryIDs = []store.CategoryIDEntry{{Scene: "purchase", Category: 100061}}
	svc, jc := newModifySvc(t, "cn", defs)

	_, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=modify]") {
		t.Fatalf("err = %v, want missing modify category error", err)
	}
	if jc.getPriceCalls.Load() != 0 {
		t.Errorf("GetPrice should not be called when modify category is missing, calls=%d", jc.getPriceCalls.Load())
	}
}

func TestQuoteModifyRejectsMissingBundleDefinition(t *testing.T) {
	for _, missing := range []string{modifySourceBundleID, modifyTargetBundleID} {
		t.Run(missing, func(t *testing.T) {
			defs := modifyDefs()
			delete(defs, missing)
			svc, _ := newModifySvc(t, "cn", defs)

			_, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
			if !errors.Is(err, ErrBundleNotFound) {
				t.Fatalf("err = %v, want ErrBundleNotFound", err)
			}
		})
	}
}

// 只校验目标 bundle 在售：源套餐用户已经持有，它下架与否不影响能否升配走掉。
func TestQuoteModifyRejectsOfflineTargetBundle(t *testing.T) {
	svc, _ := newModifySvc(t, "cn", modifyDefs())
	svc.deps.CTLClient = &fakeCTL{getBundleByIDFn: func(_ context.Context, id string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: id, BundleState: "OFFLINE"}, nil
	}}

	_, err := svc.QuoteModify(context.Background(), stdQuoteModifyReq())
	if !errors.Is(err, ErrBundleOffline) {
		t.Fatalf("err = %v, want ErrBundleOffline", err)
	}
}
