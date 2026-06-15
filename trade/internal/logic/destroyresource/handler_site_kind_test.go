package destroyresource

import (
	"context"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// TestHandler_IntlSiteAcceptsRegion9 验证 v1.7.x 国际站接入 A6.2：
//   - Deps.SiteKind="intl" 时 handler 接受 jifei 入参 region=9（新加坡），
//     校验通过后正常进入抢占式幂等流程
//   - 此时如果 jifei 错传 region=1（国内站常量），handler 必须拒绝（合规红线）
//
// 与原 TestHandler_RegionMismatch 互补：原用例覆盖 cn 站点 + 错入参 region=9 拒绝；
// 本用例覆盖 intl 站点 + 正确入参 region=9 接受、错入参 region=1 拒绝。
func TestHandler_IntlSiteAcceptsRegion9(t *testing.T) {
	cases := []struct {
		name         string
		siteKind     string
		paraRegion   int
		wantAccepted bool // true = 走到 ctl.DestroyPass 成功路径；false = ReturnCodeInvalidPara
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
			const wantFlowID int64 = 7777
			flow := &fakeFlowStore{
				tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
					return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
				},
			}
			ctl := &fakeCTLClient{
				destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
					if !tc.wantAccepted {
						t.Errorf("ctl.DestroyPass should NOT be called when region校验拒绝")
					}
					return &ctlclient.DestroyPassResponse{}, nil
				},
			}
			deps := Deps{
				FlowStore: flow,
				CTLClient: ctl,
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
				// 验证返回的 flowId
				if resp.Data["flowId"] != wantFlowID {
					t.Errorf("expected flowId=%d, got %v", wantFlowID, resp.Data["flowId"])
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

// 防止 ctlclient 没用到导致 unused import 报错（cn baseline case 复用了上面的）。
var _ = ctlclient.ErrNotFound
