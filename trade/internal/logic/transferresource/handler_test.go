package transferresource

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

type fakeFlowStore struct {
	tryAcquireFunc func(context.Context, string, string, string, []byte) (bool, *store.Flow, error)
	completed      bool
}

func (f *fakeFlowStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error) {
	return f.tryAcquireFunc(ctx, dealName, flowType, appID, body)
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, dealName, flowType, appID string, responseBody []byte) error {
	if dealName != "deal-transfer-1" || flowType != store.FlowTypeTransferResource || appID != "1447552654" {
		return errors.New("unexpected completed flow key")
	}
	f.completed = true
	return nil
}

func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("unused")
}

func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("unused")
}

func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("unused")
}

func (f *fakeFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("unused")
}

func (f *fakeFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, nil
}

type fakeCTLClient struct {
	got *ctlclient.TransferPassRequest
}

func (f *fakeCTLClient) TransferPass(_ context.Context, req *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	f.got = req
	return &ctlclient.PassDetail{PassID: req.PassID, BundleID: req.TargetBundleID, Uin: req.NewUin, AppID: req.NewAppID}, nil
}

func TestTransferResourceWinnerCallsCTLAndReturnsResourceID(t *testing.T) {
	flow := &fakeFlowStore{tryAcquireFunc: func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
		return true, nil, nil
	}}
	ctl := &fakeCTLClient{}
	resp := callHandler(t, Deps{
		FlowStore: flow,
		CTLClient: ctl,
		Builder:   jifei.NewFrameworkBuilder("trade", "1.0"),
	}, validPara())

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode=%d message=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if ctl.got == nil {
		t.Fatal("expected ctl TransferPass to be called")
	}
	if ctl.got.PassID != "pass-qjy7j2gm" || ctl.got.TargetBundleID != "bundle_launch_01" ||
		ctl.got.NewUin != 330500000004 || ctl.got.NewAppID != 1447552654 ||
		ctl.got.DealName != "deal-transfer-1" || ctl.got.BigOrderID != "big-transfer-1" {
		t.Fatalf("unexpected ctl request: %+v", ctl.got)
	}
	if !flow.completed {
		t.Fatal("expected flow to be marked completed")
	}
	gotIDs, _ := resp.Data["resourceId"].([]string)
	if len(gotIDs) != 1 || gotIDs[0] != "pass-qjy7j2gm" {
		t.Fatalf("resourceId data mismatch: %+v", resp.Data)
	}
}

func callHandler(t *testing.T, deps Deps, para map[string]any) jifei.Framework {
	t.Helper()
	raw, err := json.Marshal(para)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	resp, err := makeHandler(deps)(context.Background(), raw)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return resp
}

func validPara() map[string]any {
	return map[string]any{
		"oldOwnerUin": "0",
		"newOwnerUin": "330500000004",
		"uin":         "0",
		"oldAppId":    0,
		"newAppId":    1447552654,
		"appId":       1447552654,
		"operateUin":  "0",
		"resourceId":  []string{"pass-qjy7j2gm"},
		"dealName":    "deal-transfer-1",
		"bigDealId":   "big-transfer-1",
		"type":        "sp_lighthouse_lightvela_mc",
		"region":      8,
		"zoneId":      "800001",
		"goodsDetail": map[string]any{
			"bundleId":       "bundle_launch_01",
			"externalUserId": "usr_cd57811ec414ce48e8d40c6c",
			"resourceId":     "pass-qjy7j2gm",
		},
		"retry":          "0",
		"productCode":    "p_lighthouse",
		"subProductCode": "sp_lighthouse_lightvela_mc",
	}
}
