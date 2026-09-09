package creditusage

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/resourcebillingclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

type fakeDefinitionStore struct{}

func (fakeDefinitionStore) GetCreditDefinitionByProductID(context.Context, string) (*store.CreditDefinition, error) {
	return &store.CreditDefinition{ProductCode: "p_credit", SubProductCode: "sp_credit", Pid: 10001}, nil
}

func (fakeDefinitionStore) ListCreditDefinitions(context.Context, string, string) ([]*store.CreditDefinition, error) {
	return nil, nil
}

type fakeBillingClient struct {
	request resourcebillingclient.Request
}

func (f *fakeBillingClient) SendResource(_ context.Context, request resourcebillingclient.Request) (*resourcebillingclient.Response, error) {
	f.request = request
	response := &resourcebillingclient.Response{}
	response.Data.ResourceCount.TotalCount = 1
	response.Data.ResourceCount.SuccCount = 1
	return response, nil
}

func TestReportMapsCreditUsageToQBilling(t *testing.T) {
	billing := &fakeBillingClient{}
	service := New(Deps{DefinitionStore: fakeDefinitionStore{}, BillingClient: billing, CID: "101433", RegionOverride: "ap-beijing"})

	_, err := service.Report(context.Background(), ReportRequest{
		PackageID: "cpkg-1", ProductID: "credit_100", DealName: "deal-1", Uin: "700000164995", AppID: 1300000001,
		UsageDate: "2026-09-03", CalcDate: "2026-09-04", PackageExpiredTime: time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC),
		CreditTotal: "10.0000", CreditUsedDay: "0.0000", CreditLeft: "10.0000",
	})
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	resources := billing.request.Data["700000164995"]
	if len(resources) != 1 {
		t.Fatalf("unexpected data: %+v", billing.request.Data)
	}
	item := resources[0]
	if item.Params != `{"units":{"credit":1}}` || item.Parts != `{"credit_day":0.0000,"credit_left":10.0000,"credit_total":10.0000}` {
		t.Fatalf("unexpected params/parts: params=%s parts=%s", item.Params, item.Parts)
	}
	if item.StartTime != "2026-09-03 00:00:00" || item.EndTime != "2026-09-03 23:59:59" || item.CalcDate != "20260904" {
		t.Fatalf("unexpected dates: %+v", item)
	}
}
