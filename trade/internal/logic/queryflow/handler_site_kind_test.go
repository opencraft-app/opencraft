package queryflow

import (
	"context"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// TestHandler_IntlSiteAcceptsRegion9 验证 v1.7.x 国际站接入 A6.2：
//   - Deps.SiteKind="intl" 时 handler 接受 jifei 入参 region=9（新加坡）
//   - intl 站点错传 region=1 必须拒绝（合规红线）
//   - cn 站点保持原有 region=1 baseline
//
// 与 destroyresource / isolateresource 同模式（jifei 反向回调 handler 的 region 校验）。
func TestHandler_IntlSiteAcceptsRegion9(t *testing.T) {
	cases := []struct {
		name         string
		siteKind     string
		paraRegion   int
		wantAccepted bool
	}{
		{
			name:         "intl site + region=9 accepted",
			siteKind:     "intl",
			paraRegion:   region.LighthouseIntlRegionID,
			wantAccepted: true,
		},
		{
			name:         "intl site + region=1 rejected (compliance red line)",
			siteKind:     "intl",
			paraRegion:   region.LighthouseRegionID,
			wantAccepted: false,
		},
		{
			name:         "cn site + region=1 accepted (baseline)",
			siteKind:     "cn",
			paraRegion:   region.LighthouseRegionID,
			wantAccepted: true,
		},
		{
			name:         "cn site + region=9 rejected",
			siteKind:     "cn",
			paraRegion:   region.LighthouseIntlRegionID,
			wantAccepted: false,
		},
		{
			name:         "empty siteKind falls back to cn behavior",
			siteKind:     "",
			paraRegion:   region.LighthouseRegionID,
			wantAccepted: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flow := &fakeFlowStore{
				getByIDFunc: func(_ context.Context, id int64) (*store.Flow, error) {
					if !tc.wantAccepted {
						t.Errorf("FlowStore.GetByID should NOT be called when region 校验拒绝")
					}
					return &store.Flow{ID: id, Status: store.FlowStatusInProgress}, nil
				},
			}
			deps := Deps{
				FlowStore: flow,
				Builder:   jifei.NewFrameworkBuilder("trade", "1.0"),
				SiteKind:  tc.siteKind,
			}
			p := defaultPara()
			p.Region = tc.paraRegion
			resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))

			if tc.wantAccepted {
				if resp.ReturnCode != 0 {
					t.Errorf("expected returnCode=0 (success), got %d (msg=%s)",
						resp.ReturnCode, resp.ReturnMessage)
				}
				if resp.Data["status"] != StatusInProgress {
					t.Errorf("expected status=%d (in-progress), got %v", StatusInProgress, resp.Data["status"])
				}
			} else {
				if resp.ReturnCode != ReturnCodeInvalidPara {
					t.Errorf("expected returnCode=%d (region mismatch), got %d (msg=%s)",
						ReturnCodeInvalidPara, resp.ReturnCode, resp.ReturnMessage)
				}
			}
		})
	}
}
