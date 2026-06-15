package jifeiclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestExtraPara_SiteAndLanguage 验证 v1.7.x 国际站接入 A2/A3：
// envelope.interface.extraPara 按 Options.SiteKind 注入 site / language（PDF 协议字面量映射）。
//
// 验证矩阵：
//   - SiteKind="cn" / "" / "bogus"   → extraPara 不写 site / language（兼容现状，omitempty 跳过）
//   - SiteKind="intl"                 → extraPara.site="2"（PDF 协议字面量，不是 "intl"）
//   - extraPara.language="en"
//   - **反向断言**：出向 wire 上不会出现 "site":"intl"（trade 内部字面量绝对不入 wire）
//
// 测试方式：拦截 GetPrice 出向 envelope，反序列化为 map[string]interface{} 检查 extraPara 子对象。
func TestExtraPara_SiteAndLanguage(t *testing.T) {
	cases := []struct {
		name              string
		siteKind          string
		wantHasSite       bool
		wantSiteValue     string
		wantHasLanguage   bool
		wantLanguageValue string
		wantHasExtraPara  bool
	}{
		{
			name:             "cn omits site and language",
			siteKind:         "cn",
			wantHasSite:      false,
			wantHasLanguage:  false,
			wantHasExtraPara: false,
		},
		{
			name:              "intl injects PDF wire literal '2' and 'en'",
			siteKind:          "intl",
			wantHasSite:       true,
			wantSiteValue:     "2",
			wantHasLanguage:   true,
			wantLanguageValue: "en",
			wantHasExtraPara:  true,
		},
		{
			name:             "empty falls back to cn behavior",
			siteKind:         "",
			wantHasSite:      false,
			wantHasLanguage:  false,
			wantHasExtraPara: false,
		},
		{
			name:             "bogus falls back to cn behavior",
			siteKind:         "bogus",
			wantHasSite:      false,
			wantHasLanguage:  false,
			wantHasExtraPara: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyStr string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				bodyStr = string(body)
				_, _ = w.Write(envelopeForSuccess(t, []GetPriceData{}))
			}))
			defer server.Close()

			cli := New(server.URL, "trade-test-uin", Options{
				EventIDProvider: fixedEventIDProvider,
				NowProvider:     fixedNowProvider,
				SiteKind:        tc.siteKind,
			})

			_, _ = cli.GetPrice(context.Background(), &GetPriceRequest{
				OwnerUin: "100012345678",
				Uin:      "100012345678",
				ResInfo:  []GetPriceItem{{GoodsCategoryID: 100059, GoodsNum: 1, PayMode: 1, Action: "purchase"}},
			})

			// 反向断言：出向 wire 上绝对不能出现 "site":"intl" / "site":"cn" 等内部字面量
			if strings.Contains(bodyStr, `"site":"intl"`) {
				t.Errorf("BUG: trade internal literal 'intl' leaked into envelope.extraPara.site; body=%s", bodyStr)
			}
			if strings.Contains(bodyStr, `"site":"cn"`) {
				t.Errorf("BUG: trade internal literal 'cn' leaked into envelope.extraPara.site; body=%s", bodyStr)
			}
			if strings.Contains(bodyStr, `"language":"intl"`) {
				t.Errorf("BUG: trade internal literal 'intl' leaked into envelope.extraPara.language; body=%s", bodyStr)
			}

			// 解析 envelope，检查 extraPara 子对象
			var raw map[string]interface{}
			if err := json.Unmarshal([]byte(bodyStr), &raw); err != nil {
				t.Fatalf("unmarshal request body: %v", err)
			}
			ifaceMap, _ := raw["interface"].(map[string]interface{})
			if ifaceMap == nil {
				t.Fatalf("envelope.interface missing")
			}

			extraParaRaw, hasExtraPara := ifaceMap["extraPara"]
			if hasExtraPara != tc.wantHasExtraPara {
				t.Errorf("envelope.interface.extraPara presence: got %v, want %v (body=%s)",
					hasExtraPara, tc.wantHasExtraPara, bodyStr)
			}
			if !tc.wantHasExtraPara {
				return // 后续字段断言对 cn case 不适用
			}

			extraParaMap, _ := extraParaRaw.(map[string]interface{})
			if extraParaMap == nil {
				t.Fatalf("envelope.interface.extraPara is not a map: %T", extraParaRaw)
			}

			site, hasSite := extraParaMap["site"]
			if hasSite != tc.wantHasSite {
				t.Errorf("extraPara.site presence: got %v, want %v", hasSite, tc.wantHasSite)
			}
			if hasSite && site != tc.wantSiteValue {
				t.Errorf("extraPara.site value: got %v, want %q", site, tc.wantSiteValue)
			}

			language, hasLanguage := extraParaMap["language"]
			if hasLanguage != tc.wantHasLanguage {
				t.Errorf("extraPara.language presence: got %v, want %v", hasLanguage, tc.wantHasLanguage)
			}
			if hasLanguage && language != tc.wantLanguageValue {
				t.Errorf("extraPara.language value: got %v, want %q", language, tc.wantLanguageValue)
			}
		})
	}
}

// TestExtraPara_IntlPreservesOwnerUinFromCaller 验证 modifyresourcestatus 路径
// （doSignedWithExtra 传入 extraPara{OwnerUin: ...}）在 SiteKind="intl" 时：
//   - OwnerUin 被保留
//   - Site / Language 被同时注入
//
// 这覆盖 applySiteKindToExtraPara 的 mutate 同对象路径（不拷贝）。
func TestExtraPara_IntlPreservesOwnerUinFromCaller(t *testing.T) {
	c := &client{siteKind: "intl"}
	in := &extraParaBlock{OwnerUin: "100012345678"}
	out := c.applySiteKindToExtraPara(in)
	if out != in {
		t.Errorf("applySiteKindToExtraPara should mutate in-place, got new pointer")
	}
	if out.OwnerUin != "100012345678" {
		t.Errorf("OwnerUin lost: got %q", out.OwnerUin)
	}
	if out.Site != "2" {
		t.Errorf("Site: got %q want %q", out.Site, "2")
	}
	if out.Language != "en" {
		t.Errorf("Language: got %q want %q", out.Language, "en")
	}
}

// TestExtraPara_CnLeavesNilUntouched 验证 SiteKind="cn" 时 nil extraPara 仍返回 nil
// （interfaceBlock.ExtraPara omitempty 跳过，与 v1.7.x 接入前行为 100% 兼容）。
func TestExtraPara_CnLeavesNilUntouched(t *testing.T) {
	c := &client{siteKind: "cn"}
	if got := c.applySiteKindToExtraPara(nil); got != nil {
		t.Errorf("cn + nil extraPara: got non-nil %+v, want nil", got)
	}
	if got := c.applySiteKindToExtraPara(&extraParaBlock{OwnerUin: "x"}); got.Site != "" || got.Language != "" {
		t.Errorf("cn + ownerUin: Site/Language polluted: %+v", got)
	}
}
