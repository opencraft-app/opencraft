package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// newTestEnvWithSiteKind 与 newTestEnv 等价但允许显式注入 SiteKind 到 internalapi.Deps。
//
// v1.7.x 国际站接入 A6.1 测试用：当 SiteKind="intl" 时 deleteResourceHandler 出向
// envelope.resInfo.regionId 必须 = 9（Singapore），与 cn=1（广州）合规隔离。
func newTestEnvWithSiteKind(t *testing.T, siteKind string) *testEnv {
	t.Helper()
	ctl := &fakeCTL{}
	jifei := &fakeJifei{}
	orderWriter := &fakeOrderWriter{}
	orderStore := &fakeOrderStore{}
	bundle := &fakeBundleStore{}

	inq := inquiry.New(inquiry.Deps{
		CTLClient:   ctl,
		BundleStore: bundle,
		JifeiClient: jifei,
		SiteKind:    siteKind,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   ctl,
		BundleStore: bundle,
		JifeiClient: jifei,
		OrderWriter: orderWriter,
		OrderStore:  orderStore,
		SiteKind:    siteKind,
	})

	r := gin.New()
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		BundleStore:          bundle,
		JifeiClient:          jifei,
		SiteKind:             siteKind,
	})

	return &testEnv{
		router:      r,
		ctl:         ctl,
		jifei:       jifei,
		orderWriter: orderWriter,
		orderStore:  orderStore,
		bundle:      bundle,
		token:       "test-token",
	}
}

// TestDeleteResource_IntlSiteRegion 验证 v1.7.x 国际站接入 A6.1：
//   - SiteKind="intl" 时 deleteResourceHandler 出向 ModifyResourceStatus 的 RegionID=9（Singapore）
//   - SiteKind="cn"   时 RegionID=1（广州，baseline）
//   - SiteKind=""     时兜底为 cn 行为（与 cn 完全等价）
//
// 与 placeorder/inquiry 出向 envelope.resInfo.regionId 同源同值（合规：跨链路一致性）。
func TestDeleteResource_IntlSiteRegion(t *testing.T) {
	cases := []struct {
		name         string
		siteKind     string
		wantRegionID int
	}{
		{"cn baseline", "cn", region.LighthouseRegionID},
		{"empty falls back to cn", "", region.LighthouseRegionID},
		{"intl uses singapore", "intl", region.LighthouseIntlRegionID},
		{"bogus falls back to cn", "bogus", region.LighthouseRegionID},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnvWithSiteKind(t, tc.siteKind)

			// 与 TestDeleteResource_HappyPath 装配范式一致。
			env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
				return &store.BundleDefinition{
					BundleID:       bundleID,
					ProductCode:    "p_lighthouse",
					SubProductCode: "sp_test",
				}, nil
			}
			var seenReq *jifeiclient.ModifyResourceStatusRequest
			env.jifei.modifyResourceStatusFn = func(_ context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
				seenReq = req
				return &jifeiclient.ModifyResourceStatusResponse{
					OperationSet: []jifeiclient.ModifyResourceStatusOperation{{Status: 0}},
				}, nil
			}

			body := deleteResourceBody()
			var buf bytes.Buffer
			_ = json.NewEncoder(&buf).Encode(body)
			req := httptest.NewRequest(http.MethodPost,
				"/internal/trade/resources/lhins-bj-7-test-001/delete", &buf)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+env.token)
			rec := httptest.NewRecorder()
			env.router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
			}
			if seenReq == nil {
				t.Fatalf("ModifyResourceStatus not called")
			}
			if seenReq.RegionID != tc.wantRegionID {
				t.Errorf("RegionID: got %d want %d (siteKind=%q)",
					seenReq.RegionID, tc.wantRegionID, tc.siteKind)
			}
		})
	}
}
