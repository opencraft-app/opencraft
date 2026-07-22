// Package transferresource implements jifei `lightvela.pass.transferResource`.
package transferresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

const (
	ReturnCodeInvalidPara         = 600701
	ReturnCodeFlowInProgress      = 600702
	ReturnCodeUpstreamUnavailable = 600703
	ReturnCodeFlowReplayCorrupted = 600704

	HandlerTimeout = 4 * time.Second
	flowType       = store.FlowTypeTransferResource
)

type Deps struct {
	FlowStore store.FlowStore
	CTLClient TransferClient
	Builder   *jifei.FrameworkBuilder
}

type TransferClient interface {
	TransferPass(ctx context.Context, req *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error)
}

type callbackPara struct {
	OldOwnerUin    string                 `json:"oldOwnerUin"`
	NewOwnerUin    string                 `json:"newOwnerUin"`
	Uin            string                 `json:"uin"`
	OldAppID       int64                  `json:"oldAppId"`
	NewAppID       int64                  `json:"newAppId"`
	AppID          int64                  `json:"appId"`
	ResourceIDs    []string               `json:"resourceId"`
	DealName       string                 `json:"dealName"`
	BigDealID      string                 `json:"bigDealId"`
	Type           string                 `json:"type"`
	Region         int64                  `json:"region"`
	ZoneID         string                 `json:"zoneId"`
	GoodsDetail    map[string]interface{} `json:"goodsDetail"`
	ProductCode    string                 `json:"productCode"`
	SubProductCode string                 `json:"subProductCode"`
}

func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameTransferResource, makeHandler(deps))
}

func makeHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		appIDStr := strconv.FormatInt(effectiveAppID(&para), 10)
		acquired, existing, err := deps.FlowStore.TryAcquireSlot(ctx, para.DealName, flowType, appIDStr, paraRaw)
		if err != nil {
			return deps.Builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("acquire trade_flow slot: %v", err)), nil
		}
		if !acquired {
			return handleLoser(deps, existing), nil
		}

		resp := runMainFlow(ctx, deps, &para)
		respBytes, marshalErr := json.Marshal(resp)
		if marshalErr != nil {
			return resp, nil
		}
		switch {
		case resp.ReturnCode == 0:
			_ = deps.FlowStore.MarkCompleted(ctx, para.DealName, flowType, appIDStr, respBytes)
		case resp.ReturnCode == jifei.RefundReturnCode:
			_ = deps.FlowStore.MarkFailed(ctx, para.DealName, flowType, appIDStr, respBytes)
		}
		return resp, nil
	}
}

func runMainFlow(ctx context.Context, deps Deps, para *callbackPara) jifei.Framework {
	passID := strings.TrimSpace(para.ResourceIDs[0])
	req := &ctlclient.TransferPassRequest{
		PassID:         passID,
		UserID:         stringFromGoodsDetail(para.GoodsDetail, "externalUserId"),
		SourceBundleID: "bundle_free_trial_01",
		TargetBundleID: stringFromGoodsDetail(para.GoodsDetail, "bundleId"),
		OldUin:         parseInt64OrZero(para.OldOwnerUin),
		OldAppID:       para.OldAppID,
		NewUin:         parseInt64OrZero(para.NewOwnerUin),
		NewAppID:       para.NewAppID,
		DealName:       strings.TrimSpace(para.DealName),
		BigOrderID:     strings.TrimSpace(para.BigDealID),
	}
	if req.TargetBundleID == "" {
		req.TargetBundleID = "bundle_launch_01"
	}
	if req.NewUin == 0 {
		req.NewUin = parseInt64OrZero(para.Uin)
	}
	if req.NewAppID == 0 {
		req.NewAppID = para.AppID
	}

	if _, err := deps.CTLClient.TransferPass(ctx, req); err != nil {
		if isPermanentCTLError(err) {
			return deps.Builder.NewRefund()
		}
		return deps.Builder.NewError(ReturnCodeUpstreamUnavailable, fmt.Sprintf("ctl TransferPass: %v", err))
	}
	return deps.Builder.NewSuccess(map[string]any{
		"resourceId": []string{passID},
	})
}

func handleLoser(deps Deps, existing *store.Flow) jifei.Framework {
	if existing == nil {
		return deps.Builder.NewError(ReturnCodeFlowInProgress, "trade_flow exists but row not found")
	}
	switch existing.Status {
	case store.FlowStatusCompleted, store.FlowStatusFailed:
		if len(existing.ResponseBody) == 0 {
			return deps.Builder.NewError(ReturnCodeFlowReplayCorrupted, "trade_flow response_body is empty")
		}
		var resp jifei.Framework
		if err := json.Unmarshal(existing.ResponseBody, &resp); err != nil {
			return deps.Builder.NewError(ReturnCodeFlowReplayCorrupted, fmt.Sprintf("decode response_body: %v", err))
		}
		return resp
	default:
		return deps.Builder.NewError(ReturnCodeFlowInProgress, "transferResource flow is in progress")
	}
}

func validatePara(p *callbackPara) error {
	if strings.TrimSpace(p.DealName) == "" {
		return fmt.Errorf("dealName is required")
	}
	if len(p.ResourceIDs) == 0 || strings.TrimSpace(p.ResourceIDs[0]) == "" {
		return fmt.Errorf("resourceId is required")
	}
	if effectiveAppID(p) <= 0 {
		return fmt.Errorf("newAppId/appId must be > 0")
	}
	if strings.TrimSpace(p.NewOwnerUin) == "" && strings.TrimSpace(p.Uin) == "" {
		return fmt.Errorf("newOwnerUin/uin is required")
	}
	return nil
}

func effectiveAppID(p *callbackPara) int64 {
	if p.NewAppID > 0 {
		return p.NewAppID
	}
	return p.AppID
}

func isPermanentCTLError(err error) bool {
	if errors.Is(err, ctlclient.ErrNotFound) {
		return true
	}
	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) {
		return ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500
	}
	return false
}

func stringFromGoodsDetail(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func parseInt64OrZero(s string) int64 {
	v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return v
}
