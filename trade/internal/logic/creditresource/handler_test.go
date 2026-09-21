package creditresource

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/creditclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

type fakeFlowStore struct {
	completedBody         []byte
	acquireDeal           string
	acquireType           string
	acquireAppID          string
	deletedID             int64
	getFlowFunc           func(context.Context, string, string, string) (*store.Flow, error)
	tryAcquireIsolateFunc func(context.Context, string, string, string, string, []byte, *string) (bool, *store.Flow, error)
}

func (f *fakeFlowStore) TryAcquireSlot(_ context.Context, dealName, flowType, appID string, _ []byte) (bool, *store.Flow, error) {
	f.acquireDeal = dealName
	f.acquireType = flowType
	f.acquireAppID = appID
	return true, nil, nil
}

func (f *fakeFlowStore) TryAcquireSlotForIsolate(ctx context.Context, resourceID, flowType, appID, uin string, body []byte, dealName *string) (bool, *store.Flow, error) {
	if f.tryAcquireIsolateFunc != nil {
		return f.tryAcquireIsolateFunc(ctx, resourceID, flowType, appID, uin, body, dealName)
	}
	return false, nil, errors.New("not used")
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, _, _, _ string, body []byte) error {
	f.completedBody = body
	return nil
}

func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, body []byte) error {
	f.completedBody = body
	return nil
}

func (f *fakeFlowStore) MarkFailed(context.Context, string, string, string, []byte) error {
	return errors.New("not used")
}

func (f *fakeFlowStore) MarkCompletedByID(context.Context, int64, []byte) error {
	return errors.New("not used")
}

func (f *fakeFlowStore) MarkFailedByID(context.Context, int64, []byte) error {
	return errors.New("not used")
}

func (f *fakeFlowStore) DeleteByID(_ context.Context, id int64) error {
	f.deletedID = id
	return nil
}

func (f *fakeFlowStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	if f.getFlowFunc != nil {
		return f.getFlowFunc(ctx, dealName, flowType, appID)
	}
	return &store.Flow{ID: 123, Status: store.FlowStatusInProgress}, nil
}

func (f *fakeFlowStore) GetByID(context.Context, int64) (*store.Flow, error) {
	return nil, errors.New("not used")
}

func (f *fakeFlowStore) ListInProgressBefore(context.Context, time.Time, int) ([]*store.Flow, error) {
	return nil, errors.New("not used")
}

type fakeCreditClient struct {
	used          map[string]creditclient.UsedAmountItem
	appIDs        []int64
	resourceTotal int64
	resources     []creditclient.ResourceItem
	isolateFunc   func(context.Context, string, string) error
}

func (fakeCreditClient) CompletePackage(context.Context, *creditclient.CompletePackageRequest) (*creditclient.PackageDetail, error) {
	return nil, errors.New("not used")
}

func (c fakeCreditClient) GetUsedAmounts(context.Context, *creditclient.UsedAmountRequest) (map[string]creditclient.UsedAmountItem, error) {
	return c.used, nil
}

func (c fakeCreditClient) QueryResources(context.Context, *creditclient.ResourceQueryRequest) ([]creditclient.ResourceItem, error) {
	return c.resources, nil
}

func (c fakeCreditClient) ListResourceAppIDs(context.Context, *creditclient.ResourcePageRequest) ([]int64, int64, error) {
	return c.appIDs, int64(len(c.appIDs)), nil
}

func (c fakeCreditClient) ListUserResources(context.Context, *creditclient.UserResourcePageRequest) ([]creditclient.ResourceItem, int64, error) {
	return c.resources, c.resourceTotal, nil
}

func (c fakeCreditClient) IsolatePackage(ctx context.Context, packageID, reason string) error {
	if c.isolateFunc != nil {
		return c.isolateFunc(ctx, packageID, reason)
	}
	return errors.New("not used")
}

type fakeDefinitionStore struct{}

func (fakeDefinitionStore) GetCreditDefinitionByProductID(_ context.Context, productID string) (*store.CreditDefinition, error) {
	if productID != "credit_100" {
		return nil, store.ErrCreditDefinitionNotFound
	}
	return &store.CreditDefinition{
		ProductID: productID, ProductCode: "p_lighthouse", SubProductCode: "sp_lighthouse_lv_credit_pkg",
		Pid: 10001,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 2025868},
		},
		SVList: map[string]int64{"sv_credit_package": 1},
	}, nil
}

func (fakeDefinitionStore) ListCreditDefinitions(_ context.Context, productCode, subProductCode string) ([]*store.CreditDefinition, error) {
	def, _ := fakeDefinitionStore{}.GetCreditDefinitionByProductID(context.Background(), "credit_100")
	if productCode != "" && productCode != def.ProductCode {
		return []*store.CreditDefinition{}, nil
	}
	if subProductCode != "" && subProductCode != def.SubProductCode {
		return []*store.CreditDefinition{}, nil
	}
	return []*store.CreditDefinition{def}, nil
}

func TestGetUsedAmountUsesCompletedCreateFlowWhenTradeOrderIsMissing(t *testing.T) {
	handler := makeGetUsedAmountHandler(Deps{
		FlowStore: completedCreditCreateFlow(t, "cpkg-test001"),
		CreditClient: fakeCreditClient{used: map[string]creditclient.UsedAmountItem{
			"cpkg-test001": {PackageID: "cpkg-test001", ProductID: "credit_100", DealName: "deal-1", UsedRatio: "0.2356"},
		}},
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	raw := json.RawMessage(`{"appId":1300000001,"uin":"700000164995","region":8,"payMode":1,"resourceIdList":["cpkg-test001"]}`)

	resp, err := handler(context.Background(), raw)
	if err != nil {
		t.Fatalf("get used amount handler: %v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode=%d message=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	item, ok := resp.Data["cpkg-test001"].(map[string]any)
	if !ok {
		t.Fatalf("missing resource response: %+v", resp.Data)
	}
	if item["timeSpan"] != 3 || item["timeUnit"] != "m" || item["payMode"] != 1 || item["pid"] != int64(10001) {
		t.Fatalf("unexpected billing fields: %+v", item)
	}
	if ratio, ok := item["sv_credit_package"].(json.Number); !ok || ratio.String() != "0.2356" {
		t.Fatalf("unexpected used ratio: %#v", item["sv_credit_package"])
	}
}

func TestIsolateResourceForwardsReasonAndCompletesFlow(t *testing.T) {
	flowStore := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, resourceID, flowType, appID, uin string, _ []byte, _ *string) (bool, *store.Flow, error) {
			if resourceID != "cpkg-test001" || flowType != store.FlowTypeIsolateResource || appID != "1300000001" || uin != "700000164995" {
				t.Fatalf("unexpected flow key: resource=%s type=%s app=%s uin=%s", resourceID, flowType, appID, uin)
			}
			return true, &store.Flow{ID: 42}, nil
		},
	}
	var gotPackageID, gotReason string
	handler := makeIsolateHandler(Deps{
		FlowStore: flowStore,
		CreditClient: fakeCreditClient{isolateFunc: func(_ context.Context, packageID, reason string) error {
			gotPackageID, gotReason = packageID, reason
			return nil
		}},
		Builder: jifei.NewFrameworkBuilder("trade", "1.0"),
	})

	resp, err := handler(context.Background(), json.RawMessage(`{"resourceId":"cpkg-test001","appId":1300000001,"uin":"700000164995","reason":"refund"}`))
	if err != nil || resp.ReturnCode != 0 {
		t.Fatalf("isolate resource: err=%v resp=%+v", err, resp)
	}
	if gotPackageID != "cpkg-test001" || gotReason != "refund" {
		t.Fatalf("package=%q reason=%q", gotPackageID, gotReason)
	}
}

func TestQueryResourceReturnsRefundableCreditPackage(t *testing.T) {
	created := time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC)
	expired := time.Date(2026, 10, 1, 2, 0, 0, 0, time.UTC)
	handler := makeQueryResourceHandler(Deps{
		CreditClient: fakeCreditClient{resources: []creditclient.ResourceItem{{
			PackageID: "cpkg-test001", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
			CreatedTime: created, ExpiredTime: expired, Status: "active", AllowReturn: true,
		}}},
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
		SiteKind:              "cn",
		RegionOverride:        "ap-beijing",
	})
	raw := json.RawMessage(`{"appId":1300000001,"uin":"700000164995","region":8,"payMode":1,"resourceIds":["cpkg-test001"]}`)

	resp, err := handler(context.Background(), raw)
	if err != nil {
		t.Fatalf("query resource handler: %v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode=%d message=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	resources, ok := resp.Data["resources"].([]map[string]any)
	if !ok || len(resources) != 1 {
		t.Fatalf("unexpected resources: %+v", resp.Data)
	}
	item := resources[0]
	if item["resourceId"] != "cpkg-test001" || item["status"] != 1 || item["allowReturn"] != 1 ||
		item["region"] != 8 || item["zoneId"] != 800001 || item["instanceType"] != 6 {
		t.Fatalf("unexpected resource fields: %+v", item)
	}
	goods, ok := item["goodsDetail"].(map[string]any)
	if !ok || goods["pid"] != int64(10001) || goods["productCode"] != "p_lighthouse" ||
		goods["subProductCode"] != "sp_lighthouse_lv_credit_pkg" {
		t.Fatalf("unexpected goods detail: %+v", item["goodsDetail"])
	}
}

func TestGetAllAppIDsReturnsCreditOwners(t *testing.T) {
	handler := makeGetAllAppIDsHandler(Deps{
		CreditClient:          fakeCreditClient{appIDs: []int64{1300000001, 1300000002}},
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	resp, err := handler(context.Background(), json.RawMessage(`{"productCode":"p_lighthouse","subProductCode":"sp_lighthouse_lv_credit_pkg","payMode":1,"region":8,"pageNo":0,"pageSize":20000}`))
	if err != nil || resp.ReturnCode != 0 {
		t.Fatalf("get all app ids: err=%v resp=%+v", err, resp)
	}
	appIDs, ok := resp.Data["appIds"].([]int64)
	if !ok || len(appIDs) != 2 || resp.Data["total"] != int64(2) {
		t.Fatalf("unexpected response: %+v", resp.Data)
	}
}

func TestGetUserResourcesReturnsCreditPackages(t *testing.T) {
	handler := makeGetUserResourcesHandler(Deps{
		CreditClient: fakeCreditClient{resourceTotal: 1, resources: []creditclient.ResourceItem{{
			PackageID: "cpkg-test001", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
			CreatedTime: time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC),
			ExpiredTime: time.Date(2026, 10, 1, 2, 0, 0, 0, time.UTC), Status: "active", AllowReturn: true,
		}}},
		CreditDefinitionStore: fakeDefinitionStore{}, Builder: jifei.NewFrameworkBuilder("trade", "1.0"),
		SiteKind: "cn", RegionOverride: "ap-beijing",
	})
	resp, err := handler(context.Background(), json.RawMessage(`{"uin":"700000164995","appId":1300000001,"payMode":1,"region":8,"pageNo":0,"pageSize":1000}`))
	if err != nil || resp.ReturnCode != 0 {
		t.Fatalf("get user resources: err=%v resp=%+v", err, resp)
	}
	resources, ok := resp.Data["resources"].([]map[string]any)
	if !ok || len(resources) != 1 || resp.Data["total"] != int64(1) ||
		resources[0]["resourceId"] != "cpkg-test001" || resources[0]["instanceType"] != 6 {
		t.Fatalf("unexpected response: %+v", resp.Data)
	}
}

func TestGetUsedAmountRejectsCreateFlowOwnedByAnotherResource(t *testing.T) {
	handler := makeGetUsedAmountHandler(Deps{
		FlowStore: completedCreditCreateFlow(t, "cpkg-other"),
		CreditClient: fakeCreditClient{used: map[string]creditclient.UsedAmountItem{
			"cpkg-test001": {PackageID: "cpkg-test001", ProductID: "credit_100", DealName: "deal-1", UsedRatio: "0.2356"},
		}},
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	raw := json.RawMessage(`{"appId":1300000001,"uin":"700000164995","region":8,"payMode":1,"resourceIdList":["cpkg-test001"]}`)

	resp, err := handler(context.Background(), raw)
	if err != nil {
		t.Fatalf("get used amount handler: %v", err)
	}
	if resp.ReturnCode == 0 {
		t.Fatalf("mismatched create flow must fail: %+v", resp)
	}
}

func TestGetUsedAmountRequiresCompletedCreateFlow(t *testing.T) {
	resourceID := "cpkg-test001"
	handler := makeGetUsedAmountHandler(Deps{
		FlowStore: &fakeFlowStore{getFlowFunc: func(context.Context, string, string, string) (*store.Flow, error) {
			return &store.Flow{Status: store.FlowStatusInProgress, ResourceID: &resourceID}, nil
		}},
		CreditClient: fakeCreditClient{used: map[string]creditclient.UsedAmountItem{
			resourceID: {PackageID: resourceID, ProductID: "credit_100", DealName: "deal-1", UsedRatio: "0.2356"},
		}},
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})

	resp, err := handler(context.Background(), json.RawMessage(`{"appId":1300000001,"uin":"700000164995","region":8,"payMode":1,"resourceIdList":["cpkg-test001"]}`))
	if err != nil {
		t.Fatalf("get used amount handler: %v", err)
	}
	if resp.ReturnCode != 610506 {
		t.Fatalf("returnCode=%d, want 610506: %+v", resp.ReturnCode, resp)
	}
}

func completedCreditCreateFlow(t *testing.T, resourceID string) *fakeFlowStore {
	t.Helper()
	requestBody := json.RawMessage(`{
		"dealName":"deal-1","bigDealId":"big-1","appId":1300000001,
		"uin":"700000164995","region":8,"payMode":1,
		"goodsDetail":{
			"externalUserId":"usr_1","productId":"credit_100","productCode":"p_lighthouse",
			"subProductCode":"sp_lighthouse_lv_credit_pkg","pid":10001,"goodsNum":1,
			"timeSpan":1,"timeUnit":"p","packageTimeSpan":3,"packageTimeUnit":"m",
			"sv_credit_package":1
		}
	}`)
	return &fakeFlowStore{getFlowFunc: func(_ context.Context, dealName, flowType, appID string) (*store.Flow, error) {
		if dealName != "deal-1" || flowType != store.FlowTypeCreateResource || appID != "1300000001" {
			t.Fatalf("unexpected flow key: deal=%s type=%s app=%s", dealName, flowType, appID)
		}
		return &store.Flow{
			DealName: dealName, FlowType: flowType, AppID: appID,
			Status: store.FlowStatusCompleted, ResourceID: &resourceID, RequestBody: requestBody,
		}, nil
	}}
}

func TestCheckCreateRequiresRealResourcePackagePeriod(t *testing.T) {
	handler := makeCheckCreateHandler(Deps{Builder: jifei.NewFrameworkBuilder("trade", "1.0")})
	resp, err := handler(context.Background(), json.RawMessage(`{"goodsDetail":{"externalUserId":"usr_1","productId":"credit_100","timeSpan":1,"timeUnit":"p"}}`))
	if err != nil {
		t.Fatalf("check create: %v", err)
	}
	if resp.ReturnCode == 0 {
		t.Fatalf("missing packageTimeSpan/packageTimeUnit must fail: %+v", resp)
	}
}

func TestCheckCreateRejectsMismatchedSVValue(t *testing.T) {
	handler := makeCheckCreateHandler(Deps{
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	resp, err := handler(context.Background(), json.RawMessage(`{"goodsDetail":{"externalUserId":"usr_1","productId":"credit_100","pid":10001,"timeSpan":1,"timeUnit":"p","packageTimeSpan":1,"packageTimeUnit":"m","sv_credit_package":0}}`))
	if err != nil {
		t.Fatalf("check create: %v", err)
	}
	if resp.ReturnCode == 0 {
		t.Fatalf("mismatched sv value must fail: %+v", resp)
	}
}

func TestCheckCreateRejectsMismatchedPID(t *testing.T) {
	handler := makeCheckCreateHandler(Deps{
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	resp, err := handler(context.Background(), json.RawMessage(`{"goodsDetail":{"externalUserId":"usr_1","productId":"credit_100","pid":0,"timeSpan":1,"timeUnit":"p","packageTimeSpan":1,"packageTimeUnit":"m","sv_credit_package":1}}`))
	if err != nil {
		t.Fatalf("check create: %v", err)
	}
	if resp.ReturnCode == 0 {
		t.Fatalf("mismatched pid must fail: %+v", resp)
	}
}

func TestCheckCreateAcceptsMinuteResourcePackagePeriod(t *testing.T) {
	handler := makeCheckCreateHandler(Deps{
		CreditDefinitionStore: fakeDefinitionStore{},
		Builder:               jifei.NewFrameworkBuilder("trade", "1.0"),
	})
	resp, err := handler(context.Background(), json.RawMessage(`{"goodsDetail":{"externalUserId":"usr_1","productId":"credit_100","pid":10001,"timeSpan":1,"timeUnit":"p","packageTimeSpan":15,"packageTimeUnit":"M","sv_credit_package":1}}`))
	if err != nil {
		t.Fatalf("check create: %v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("minute package period must pass: %+v", resp)
	}
}
