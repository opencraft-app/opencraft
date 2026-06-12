package queryflow

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ===== 测试用 fake 实现 =======================================================

type fakeFlowStore struct {
	getByIDFunc func(ctx context.Context, id int64) (*store.Flow, error)
}

func (f *fakeFlowStore) TryAcquireSlot(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlot not used in queryFlow tests")
}
func (f *fakeFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlotForIsolate not used in queryFlow tests")
}
func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkCompleted not used in queryFlow tests")
}
func (f *fakeFlowStore) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkFailed not used in queryFlow tests")
}
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkCompletedByID not used in queryFlow tests")
}
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkFailedByID not used in queryFlow tests")
}
func (f *fakeFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("DeleteByID not used in queryFlow tests")
}
func (f *fakeFlowStore) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}
func (f *fakeFlowStore) GetByID(ctx context.Context, id int64) (*store.Flow, error) {
	return f.getByIDFunc(ctx, id)
}
func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, errors.New("ListInProgressBefore not used in queryFlow tests")
}

// ===== helpers ==============================================================

func defaultPara() callbackPara {
	return callbackPara{
		Uin:    "10000001",
		AppID:  251000001,
		Region: region.LighthouseRegionID,
		FlowID: 4242,
	}
}

func paraJSON(t *testing.T, p callbackPara) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	return raw
}

func newDeps(flow *fakeFlowStore) Deps {
	return Deps{
		FlowStore: flow,
		Builder:   jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

// ===== 入参校验 ==============================================================

func TestHandler_InvalidParaJSON(t *testing.T) {
	deps := newDeps(&fakeFlowStore{})
	resp, _ := makeHandler(deps)(context.Background(), json.RawMessage([]byte("not-json")))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expected returnCode=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

func TestHandler_MissingRequiredFields(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(p *callbackPara)
	}{
		{"missing uin", func(p *callbackPara) { p.Uin = "" }},
		{"missing appId", func(p *callbackPara) { p.AppID = 0 }},
		{"missing flowId", func(p *callbackPara) { p.FlowID = 0 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := defaultPara()
			tc.mutate(&p)
			deps := newDeps(&fakeFlowStore{})
			resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
			if resp.ReturnCode != ReturnCodeInvalidPara {
				t.Errorf("%s: expected returnCode=%d, got %d", tc.name, ReturnCodeInvalidPara, resp.ReturnCode)
			}
		})
	}
}

func TestHandler_RegionMismatch(t *testing.T) {
	p := defaultPara()
	p.Region = 9
	deps := newDeps(&fakeFlowStore{})
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expected returnCode=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

// ===== 三态映射（completed/in_progress/failed）==============================

func TestHandler_StatusMapping(t *testing.T) {
	cases := []struct {
		name       string
		flowStatus string
		wantStatus int
	}{
		{"completed → 0", store.FlowStatusCompleted, StatusSuccess},
		{"in_progress → 2", store.FlowStatusInProgress, StatusInProgress},
		{"failed → 3", store.FlowStatusFailed, StatusFailedRefund},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flow := &fakeFlowStore{
				getByIDFunc: func(_ context.Context, id int64) (*store.Flow, error) {
					if id != 4242 {
						t.Errorf("unexpected id=%d, want 4242", id)
					}
					return &store.Flow{ID: id, Status: tc.flowStatus}, nil
				},
			}
			deps := newDeps(flow)
			resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
			if resp.ReturnCode != 0 {
				t.Fatalf("expected returnCode=0, got %d", resp.ReturnCode)
			}
			gotStatus, _ := resp.Data["status"].(int)
			if gotStatus != tc.wantStatus {
				t.Errorf("expected data.status=%d, got %v", tc.wantStatus, resp.Data["status"])
			}
		})
	}
}

// ===== 不存在 / DB 错 / 未知 status ==========================================

func TestHandler_FlowNotFound_MappedToInternalError(t *testing.T) {
	flow := &fakeFlowStore{
		getByIDFunc: func(_ context.Context, _ int64) (*store.Flow, error) {
			return nil, store.ErrFlowNotFound
		},
	}
	deps := newDeps(flow)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Errorf("flow not found should map to InternalError=%d, got %d", ReturnCodeInternalError, resp.ReturnCode)
	}
}

func TestHandler_DBError_MappedToFlowInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		getByIDFunc: func(_ context.Context, _ int64) (*store.Flow, error) {
			return nil, errors.New("connection refused")
		},
	}
	deps := newDeps(flow)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("DB error should map to FlowInProgress=%d (jifei retry), got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
}

func TestHandler_UnknownStatus_MappedToInternalError(t *testing.T) {
	flow := &fakeFlowStore{
		getByIDFunc: func(_ context.Context, id int64) (*store.Flow, error) {
			return &store.Flow{ID: id, Status: "garbage_state"}, nil
		},
	}
	deps := newDeps(flow)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Errorf("unknown status should map to InternalError=%d, got %d", ReturnCodeInternalError, resp.ReturnCode)
	}
}
