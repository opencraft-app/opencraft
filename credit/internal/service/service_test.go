package service

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
)

type fakeStore struct {
	products           map[string]*store.CreditProduct
	packages           map[string]*store.CreditPackage
	histories          map[string]*store.HistoryCreditPackage
	usages             map[string]*store.CreditPackageUsage
	usageArchiveReason map[string]string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		products:           map[string]*store.CreditProduct{},
		packages:           map[string]*store.CreditPackage{},
		histories:          map[string]*store.HistoryCreditPackage{},
		usages:             map[string]*store.CreditPackageUsage{},
		usageArchiveReason: map[string]string{},
	}
}

func (s *fakeStore) GetProductByID(_ context.Context, productID string) (*store.CreditProduct, error) {
	product := s.products[productID]
	if product == nil {
		return nil, store.ErrProductNotFound
	}
	cp := *product
	return &cp, nil
}

func (s *fakeStore) ListOnlineProducts(_ context.Context) ([]store.CreditProduct, error) {
	out := make([]store.CreditProduct, 0)
	for _, product := range s.products {
		if product.State == store.ProductStateOnline {
			out = append(out, *product)
		}
	}
	return out, nil
}

func (s *fakeStore) ListPackageAppIDs(_ context.Context, productIDs []string, pageNo, pageSize int) ([]int64, int64, error) {
	allowed := stringSet(productIDs)
	seen := make(map[int64]struct{})
	for _, pkg := range s.packages {
		if len(allowed) > 0 {
			if _, ok := allowed[pkg.ProductID]; !ok {
				continue
			}
		}
		seen[pkg.AppID] = struct{}{}
	}
	appIDs := make([]int64, 0, len(seen))
	for appID := range seen {
		appIDs = append(appIDs, appID)
	}
	sort.Slice(appIDs, func(i, j int) bool { return appIDs[i] < appIDs[j] })
	return pageInt64s(appIDs, pageNo, pageSize), int64(len(appIDs)), nil
}

func (s *fakeStore) ListPackagesByOwner(_ context.Context, uin string, appID int64, productIDs []string, pageNo, pageSize int) ([]*store.CreditPackage, int64, error) {
	allowed := stringSet(productIDs)
	items := make([]*store.CreditPackage, 0)
	for _, pkg := range s.packages {
		if pkg.Uin != uin || pkg.AppID != appID {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[pkg.ProductID]; !ok {
				continue
			}
		}
		cp := *pkg
		items = append(items, &cp)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].PackageID < items[j].PackageID })
	total := int64(len(items))
	start := pageNo * pageSize
	if start >= len(items) {
		return []*store.CreditPackage{}, total, nil
	}
	end := start + pageSize
	if end > len(items) {
		end = len(items)
	}
	return items[start:end], total, nil
}

func stringSet(values []string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}

func pageInt64s(values []int64, pageNo, pageSize int) []int64 {
	start := pageNo * pageSize
	if start >= len(values) {
		return []int64{}
	}
	end := start + pageSize
	if end > len(values) {
		end = len(values)
	}
	return values[start:end]
}

func (s *fakeStore) CreatePackageWithUsage(_ context.Context, pkg *store.CreditPackage, usage *store.CreditPackageUsage) error {
	cp := *pkg
	s.packages[pkg.PackageID] = &cp
	cu := *usage
	s.usages[pkg.PackageID] = &cu
	return nil
}

func (s *fakeStore) GetPackageByID(_ context.Context, packageID string) (*store.CreditPackage, error) {
	pkg := s.packages[packageID]
	if pkg == nil {
		return nil, store.ErrPackageNotFound
	}
	cp := *pkg
	return &cp, nil
}

func (s *fakeStore) GetPackageByDealName(_ context.Context, dealName string) (*store.CreditPackage, error) {
	for _, pkg := range s.packages {
		if pkg.DealName == dealName {
			cp := *pkg
			return &cp, nil
		}
	}
	return nil, store.ErrPackageNotFound
}

func (s *fakeStore) GetPackageBySubscriptionName(_ context.Context, subscriptionName string) (*store.CreditPackage, error) {
	for _, pkg := range s.packages {
		if pkg.LLMSubscriptionName == subscriptionName {
			cp := *pkg
			return &cp, nil
		}
	}
	return nil, store.ErrPackageNotFound
}

func (s *fakeStore) MovePackageToHistory(_ context.Context, packageID string, deletedAt time.Time, reason string, isolatedAt *time.Time) error {
	pkg := s.packages[packageID]
	if pkg == nil {
		if s.histories[packageID] != nil {
			return nil
		}
		return store.ErrPackageNotFound
	}
	historyPackage := *pkg
	historyPackage.Status = store.PackageStatusDeleted
	if isolatedAt != nil {
		value := isolatedAt.UTC()
		historyPackage.IsolatedTime = &value
	}
	s.histories[packageID] = &store.HistoryCreditPackage{
		CreditPackage: historyPackage,
		DeletedTime:   deletedAt,
		DestroyReason: reason,
	}
	if s.usages[packageID] != nil {
		s.usageArchiveReason[packageID] = reason
		delete(s.usages, packageID)
	}
	delete(s.packages, packageID)
	return nil
}

type fakeLLMGateway struct {
	applyReq          *ApplySubscriptionRequest
	applyResponse     *Subscription
	cancelReq         *CancelSelectedSubscriptionsRequest
	activeList        ActiveSubscriptionList
	skipApplyToActive bool
	applyErr          error
	cancelSelectedErr error
}

func (g *fakeLLMGateway) ApplySubscription(_ context.Context, req ApplySubscriptionRequest) (Subscription, error) {
	g.applyReq = &req
	if g.applyErr != nil {
		return Subscription{}, g.applyErr
	}
	if g.applyResponse != nil {
		return *g.applyResponse, nil
	}
	return Subscription{
		ID:           "llm-sub-1",
		Name:         req.SubscriptionName,
		UserID:       req.UserID,
		PlanID:       req.PlanID,
		Status:       "active",
		TokenTotal:   100,
		TokenBalance: 100,
		PeriodEnd:    "2026-08-30T10:00:00Z",
	}, nil
}

func (g *fakeLLMGateway) CancelSelectedSubscriptions(_ context.Context, req CancelSelectedSubscriptionsRequest) error {
	g.cancelReq = &req
	return g.cancelSelectedErr
}

func (g *fakeLLMGateway) ListActiveSubscriptions(_ context.Context, userID string) (ActiveSubscriptionList, error) {
	g.activeList.UserID = userID
	if len(g.activeList.Subscriptions) == 0 && g.applyReq != nil && !g.skipApplyToActive {
		g.activeList.Subscriptions = []Subscription{{
			ID:           "llm-sub-1",
			Name:         g.applyReq.SubscriptionName,
			UserID:       g.applyReq.UserID,
			PlanID:       g.applyReq.PlanID,
			Status:       "active",
			TokenTotal:   100,
			TokenBalance: 100,
		}}
	}
	return g.activeList, nil
}

func TestCompletePaidPackageCreatesNamedLLMGatewaySubscription(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		ProductName:      "100 credits",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	llm := &fakeLLMGateway{}
	svc := New(st, llm, Options{
		Now:               func() time.Time { return time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC) },
		GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test001", nil },
	})

	pkg, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName:   "deal-1",
		BigOrderID: "big-1",
		UserID:     "usr_1",
		ProductID:  "credit_100",
		Uin:        "10001",
		AppID:      12345,
		TimeSpan:   1,
		TimeUnit:   "m",
	})
	if err != nil {
		t.Fatalf("complete paid package: %v", err)
	}
	if pkg.PackageID != "cpkg-test001" || pkg.LLMSubscriptionName != "credit-package:cpkg-test001" {
		t.Fatalf("unexpected package identity: %+v", pkg)
	}
	if llm.applyReq == nil || llm.applyReq.SubscriptionName != "credit-package:cpkg-test001" || llm.applyReq.IsUnique {
		t.Fatalf("unexpected llm apply request: %+v", llm.applyReq)
	}
	if st.packages["cpkg-test001"] == nil {
		t.Fatalf("package was not persisted")
	}
	if !pkg.ExpiredTime.Equal(time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("expired_time should be calculated by credit package period, got %s", pkg.ExpiredTime)
	}
}

func TestCompletePaidPackageKeepsExistingPackageIDForRetriedDeal(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	st.packages["cpkg-legacyid"] = &store.CreditPackage{
		PackageID: "cpkg-legacyid",
		DealName:  "deal-legacy",
		ProductID: "credit_100",
		UserID:    "usr_1",
	}
	llm := &fakeLLMGateway{}
	generated := false
	svc := New(st, llm, Options{
		GeneratePackageID: func(context.Context, string) (string, error) {
			generated = true
			return "cpkg-newvalue", nil
		},
	})

	pkg, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-legacy", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 1, TimeUnit: "m",
	})
	if err != nil {
		t.Fatalf("complete retried package: %v", err)
	}
	if pkg.PackageID != "cpkg-legacyid" {
		t.Fatalf("expected existing package ID, got %q", pkg.PackageID)
	}
	if generated || llm.applyReq != nil {
		t.Fatalf("retried deal must not allocate an ID or call LLMGateway")
	}
}

func TestCompletePaidPackageStopsBeforeLLMGatewayWhenPackageIDGenerationFails(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	llm := &fakeLLMGateway{}
	generationErr := errors.New("allocate package ID")
	var gotDealName string
	svc := New(st, llm, Options{
		GeneratePackageID: func(_ context.Context, dealName string) (string, error) {
			gotDealName = dealName
			return "", generationErr
		},
	})

	_, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 1, TimeUnit: "m",
	})
	if !errors.Is(err, generationErr) {
		t.Fatalf("expected package ID generation error, got %v", err)
	}
	if gotDealName != "deal-1" {
		t.Fatalf("expected deal name deal-1, got %q", gotDealName)
	}
	if llm.applyReq != nil {
		t.Fatalf("LLMGateway must not be called when package ID generation fails: %+v", llm.applyReq)
	}
}

func TestCompletePaidPackageCreatesUsageScheduledForNextBeijingMidnight(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	now := time.Date(2026, 9, 3, 15, 30, 0, 0, time.UTC) // 23:30 in Beijing.
	svc := New(st, &fakeLLMGateway{}, Options{
		Now:               func() time.Time { return now },
		GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test001", nil },
		CreditTokenRatio:  10000,
	})

	_, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 1, TimeUnit: "m",
	})
	if err != nil {
		t.Fatalf("complete paid package: %v", err)
	}
	usage := st.usages["cpkg-test001"]
	if usage == nil {
		t.Fatal("usage row was not created")
	}
	wantNext := time.Date(2026, 9, 3, 16, 0, 0, 0, time.UTC)
	if !usage.NextRetryTime.Equal(wantNext) {
		t.Fatalf("next retry time = %s, want %s", usage.NextRetryTime, wantNext)
	}
	if usage.PushStatus != store.UsagePushStatusInit || usage.CreditTotal.String() != "0.0100" || usage.CreditLeft.String() != "0.0100" {
		t.Fatalf("unexpected initial usage: %+v", usage)
	}
}

func TestCompletePaidPackageInitializesFromExactActiveSubscription(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	llm := &fakeLLMGateway{
		applyResponse: &Subscription{
			ID: "llm-sub-set-1", TokenTotal: 20000, TokenBalance: 20000,
		},
		activeList: ActiveSubscriptionList{Subscriptions: []Subscription{
			{ID: "llm-sub-package-2", Name: "credit-package:cpkg-test002", TokenTotal: 10000, TokenBalance: 7500},
		}},
	}
	svc := New(st, llm, Options{
		GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test002", nil },
		CreditTokenRatio:  10000,
	})

	pkg, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-2", BigOrderID: "big-2", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 1, TimeUnit: "m",
	})
	if err != nil {
		t.Fatalf("complete paid package: %v", err)
	}
	if pkg.LLMSubscriptionID != "llm-sub-package-2" {
		t.Fatalf("subscription id=%q, want exact active subscription id", pkg.LLMSubscriptionID)
	}
	usage := st.usages[pkg.PackageID]
	if usage == nil {
		t.Fatal("usage row was not created")
	}
	if usage.CreditTotal.String() != "1.0000" || usage.CreditUsedTotal.String() != "0.2500" || usage.CreditLeft.String() != "0.7500" {
		t.Fatalf("usage initialized from aggregate apply response: %+v", usage)
	}
}

func TestCompletePaidPackageDoesNotPersistWhenExactSubscriptionIsMissing(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	llm := &fakeLLMGateway{skipApplyToActive: true}
	svc := New(st, llm, Options{GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test001", nil }})

	_, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 1, TimeUnit: "m",
	})
	if err == nil || !strings.Contains(err.Error(), "active subscription credit-package:cpkg-test001 not found") {
		t.Fatalf("err=%v, want exact subscription missing error", err)
	}
	if st.packages["cpkg-test001"] != nil || st.usages["cpkg-test001"] != nil {
		t.Fatal("package and usage must not be persisted without an exact active subscription")
	}
}

func TestCompletePaidPackagePreservesMinuteBillingUnit(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID: "credit_100", LLMGatewayPlanID: "plan-credit-100", State: store.ProductStateOnline,
	}
	now := time.Date(2026, 9, 3, 15, 30, 0, 0, time.UTC)
	svc := New(st, &fakeLLMGateway{}, Options{
		Now: func() time.Time { return now }, GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test001", nil },
	})

	pkg, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, TimeSpan: 15, TimeUnit: "M",
	})
	if err != nil {
		t.Fatalf("complete minute package: %v", err)
	}
	if want := now.Add(15 * time.Minute); !pkg.ExpiredTime.Equal(want) {
		t.Fatalf("expired_time=%s want=%s", pkg.ExpiredTime, want)
	}
}

func TestGetUsedAmountsReturnsLiveSubscriptionRatio(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", ProductID: "credit_100",
		Uin: "700000164995", AppID: 1300000001, DealName: "deal-1",
		LLMSubscriptionName: "credit-package:cpkg-test001",
		ExpiredTime:         time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Status: store.PackageStatusActive,
	}
	llm := &fakeLLMGateway{activeList: ActiveSubscriptionList{Subscriptions: []Subscription{{
		Name: "credit-package:cpkg-test001", TokenTotal: 10000, TokenBalance: 7644, Status: "active",
	}}}}
	svc := New(st, llm, Options{Now: func() time.Time { return time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC) }})

	items, err := svc.GetUsedAmounts(context.Background(), UsedAmountRequest{
		Uin: "700000164995", AppID: 1300000001, ResourceIDs: []string{"cpkg-test001"},
	})
	if err != nil {
		t.Fatalf("get used amounts: %v", err)
	}
	item := items["cpkg-test001"]
	if item.PackageID != "cpkg-test001" || item.ProductID != "credit_100" || item.DealName != "deal-1" || item.UsedRatio.String() != "0.2356" {
		t.Fatalf("unexpected used amount: %+v", item)
	}
}

func TestGetUsedAmountsRejectsMissingSubscription(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", Uin: "700000164995", AppID: 1300000001,
		LLMSubscriptionName: "credit-package:cpkg-test001",
		ExpiredTime:         time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Status: store.PackageStatusActive,
	}
	svc := New(st, &fakeLLMGateway{}, Options{Now: func() time.Time { return time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC) }})

	_, err := svc.GetUsedAmounts(context.Background(), UsedAmountRequest{
		Uin: "700000164995", AppID: 1300000001, ResourceIDs: []string{"cpkg-test001"},
	})
	if err == nil {
		t.Fatal("expected missing subscription error")
	}
}

func TestQueryResourcesReturnsOwnedLivePackages(t *testing.T) {
	now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	isolatedAt := now.Add(-time.Hour)
	st := newFakeStore()
	st.packages["cpkg-active"] = &store.CreditPackage{
		PackageID: "cpkg-active", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
		CreatedTime: now.Add(-24 * time.Hour), ExpiredTime: now.Add(24 * time.Hour), Status: store.PackageStatusActive,
	}
	st.packages["cpkg-isolated"] = &store.CreditPackage{
		PackageID: "cpkg-isolated", ProductID: "credit_200", Uin: "700000164995", AppID: 1300000001,
		CreatedTime: now.Add(-48 * time.Hour), ExpiredTime: now.Add(12 * time.Hour), IsolatedTime: &isolatedAt, Status: store.PackageStatusIsolated,
	}
	st.packages["cpkg-other"] = &store.CreditPackage{
		PackageID: "cpkg-other", Uin: "other", AppID: 1300000001, ExpiredTime: now.Add(24 * time.Hour), Status: store.PackageStatusActive,
	}
	svc := New(st, &fakeLLMGateway{}, Options{Now: func() time.Time { return now }})

	items, err := svc.QueryResources(context.Background(), ResourceQueryRequest{
		Uin: "700000164995", AppID: 1300000001,
		ResourceIDs: []string{"cpkg-active", "cpkg-isolated", "cpkg-other", "cpkg-missing"},
	})
	if err != nil {
		t.Fatalf("query resources: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("items len=%d, want 2: %+v", len(items), items)
	}
	if !items[0].AllowReturn || items[0].Status != store.PackageStatusActive {
		t.Fatalf("active package should be returnable: %+v", items[0])
	}
	if items[1].AllowReturn || items[1].Status != store.PackageStatusIsolated || items[1].IsolatedTime == nil {
		t.Fatalf("isolated package should be visible but not returnable: %+v", items[1])
	}
}

func TestListResourceAppIDsFiltersProductsAndPaginates(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-a"] = &store.CreditPackage{PackageID: "cpkg-a", ProductID: "credit_100", AppID: 1001}
	st.packages["cpkg-b"] = &store.CreditPackage{PackageID: "cpkg-b", ProductID: "credit_100", AppID: 1002}
	st.packages["cpkg-c"] = &store.CreditPackage{PackageID: "cpkg-c", ProductID: "credit_200", AppID: 1003}
	svc := New(st, &fakeLLMGateway{}, Options{})

	appIDs, total, err := svc.ListResourceAppIDs(context.Background(), ResourcePageRequest{
		ProductIDs: []string{"credit_100"}, PageNo: 1, PageSize: 1,
	})
	if err != nil {
		t.Fatalf("list resource app ids: %v", err)
	}
	if total != 2 || len(appIDs) != 1 || appIDs[0] != 1002 {
		t.Fatalf("appIDs=%v total=%d", appIDs, total)
	}
}

func TestListUserResourcesReturnsLivePackages(t *testing.T) {
	now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	st := newFakeStore()
	st.packages["cpkg-active"] = &store.CreditPackage{
		PackageID: "cpkg-active", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
		ExpiredTime: now.Add(time.Hour), Status: store.PackageStatusActive,
	}
	st.packages["cpkg-other-product"] = &store.CreditPackage{
		PackageID: "cpkg-other-product", ProductID: "credit_200", Uin: "700000164995", AppID: 1300000001,
		ExpiredTime: now.Add(time.Hour), Status: store.PackageStatusIsolated,
	}
	svc := New(st, &fakeLLMGateway{}, Options{Now: func() time.Time { return now }})

	items, total, err := svc.ListUserResources(context.Background(), UserResourcePageRequest{
		Uin: "700000164995", AppID: 1300000001, ProductIDs: []string{"credit_100"}, PageNo: 0, PageSize: 1000,
	})
	if err != nil {
		t.Fatalf("list user resources: %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].PackageID != "cpkg-active" {
		t.Fatalf("items=%+v total=%d", items, total)
	}
}

func TestIsolatePaidPackageCancelsSubscriptionAndArchivesImmediately(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID:           "cpkg-test001",
		UserID:              "usr_1",
		LLMSubscriptionName: "credit-package:cpkg-test001",
		Status:              store.PackageStatusActive,
		ExpiredTime:         time.Now().Add(time.Hour),
	}
	st.usages["cpkg-test001"] = &store.CreditPackageUsage{PackageID: "cpkg-test001"}
	llm := &fakeLLMGateway{}
	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	svc := New(st, llm, Options{Now: func() time.Time { return now }})

	if err := svc.IsolatePaidPackage(context.Background(), "cpkg-test001", "refund"); err != nil {
		t.Fatalf("isolate: %v", err)
	}
	if llm.cancelReq == nil || len(llm.cancelReq.SubscriptionNames) != 1 || llm.cancelReq.SubscriptionNames[0] != "credit-package:cpkg-test001" {
		t.Fatalf("unexpected cancel selected request: %+v", llm.cancelReq)
	}
	if st.packages["cpkg-test001"] != nil || st.usages["cpkg-test001"] != nil {
		t.Fatal("package and usage must leave live tables after isolation")
	}
	history := st.histories["cpkg-test001"]
	if history == nil || history.DestroyReason != "refund" || history.IsolatedTime == nil || !history.IsolatedTime.Equal(now) {
		t.Fatalf("unexpected package history: %+v", history)
	}
	if st.usageArchiveReason["cpkg-test001"] != "refund" {
		t.Fatalf("usage archive reason=%q", st.usageArchiveReason["cpkg-test001"])
	}
}

func TestIsolatePaidPackageArchivesLegacyIsolatedPackageWithoutCancellingAgain(t *testing.T) {
	st := newFakeStore()
	originalIsolatedAt := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", LLMSubscriptionName: "credit-package:cpkg-test001",
		Status: store.PackageStatusIsolated, IsolatedTime: &originalIsolatedAt,
	}
	llm := &fakeLLMGateway{}
	svc := New(st, llm, Options{Now: func() time.Time { return originalIsolatedAt.Add(time.Hour) }})

	if err := svc.IsolatePaidPackage(context.Background(), "cpkg-test001", "refund"); err != nil {
		t.Fatalf("isolate legacy package: %v", err)
	}
	if llm.cancelReq != nil {
		t.Fatalf("legacy isolated package must not cancel again: %+v", llm.cancelReq)
	}
	history := st.histories["cpkg-test001"]
	if history == nil || history.IsolatedTime == nil || !history.IsolatedTime.Equal(originalIsolatedAt) {
		t.Fatalf("original isolated time must be preserved: %+v", history)
	}
}

func TestExpirePaidPackageCancelsSubscriptionAndArchivesWithoutIsolation(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", LLMSubscriptionName: "credit-package:cpkg-test001",
	}
	st.usages["cpkg-test001"] = &store.CreditPackageUsage{PackageID: "cpkg-test001"}
	llm := &fakeLLMGateway{}
	svc := New(st, llm, Options{Now: func() time.Time { return time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC) }})

	if err := svc.ExpirePaidPackage(context.Background(), "cpkg-test001"); err != nil {
		t.Fatalf("expire: %v", err)
	}
	if st.packages["cpkg-test001"] != nil {
		t.Fatal("live package should be removed")
	}
	history := st.histories["cpkg-test001"]
	if history == nil || history.Status != store.PackageStatusDeleted || history.DestroyReason != "expired" || history.IsolatedTime != nil {
		t.Fatalf("unexpected history: %+v", history)
	}
	if st.usageArchiveReason["cpkg-test001"] != "expired" {
		t.Fatalf("usage archive reason=%q", st.usageArchiveReason["cpkg-test001"])
	}
	if llm.cancelReq == nil || llm.cancelReq.SubscriptionNames[0] != "credit-package:cpkg-test001" {
		t.Fatalf("unexpected cancel request: %+v", llm.cancelReq)
	}
	if err := svc.ExpirePaidPackage(context.Background(), "cpkg-test001"); err != nil {
		t.Fatalf("expiration should be idempotent: %v", err)
	}
}

func TestExpirePaidPackageKeepsLiveDataWhenCancellationFails(t *testing.T) {
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", LLMSubscriptionName: "credit-package:cpkg-test001",
	}
	cancelErr := errors.New("llmgateway unavailable")
	svc := New(st, &fakeLLMGateway{cancelSelectedErr: cancelErr}, Options{})

	if err := svc.ExpirePaidPackage(context.Background(), "cpkg-test001"); !errors.Is(err, cancelErr) {
		t.Fatalf("expire error=%v, want cancellation error", err)
	}
	if st.packages["cpkg-test001"] == nil || st.histories["cpkg-test001"] != nil {
		t.Fatal("failed cancellation must preserve live package")
	}
}

func TestQueryCreditsClassifiesByLLMGatewaySubscriptionName(t *testing.T) {
	now := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	expired := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	st := newFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID:           "cpkg-test001",
		UserID:              "usr_1",
		LLMSubscriptionName: "credit-package:cpkg-test001",
		Status:              store.PackageStatusActive,
		ExpiredTime:         expired,
	}
	llm := &fakeLLMGateway{activeList: ActiveSubscriptionList{Subscriptions: []Subscription{
		{Name: "credit-package:cpkg-test001", TokenTotal: 100, TokenBalance: 83, PeriodEnd: expired.Format(time.RFC3339)},
		{Name: "free-credit:campaign:grant-1", TokenTotal: 20, TokenBalance: 12, PeriodEnd: expired.Format(time.RFC3339)},
	}}}
	svc := New(st, llm, Options{Now: func() time.Time { return now }})

	credits, err := svc.QueryCredits(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("query credits: %v", err)
	}
	if len(credits) != 2 {
		t.Fatalf("credits len=%d %+v", len(credits), credits)
	}
	if credits[0].CreditType != CreditTypePaid || credits[0].CreditTotal.String() != "0.0100" || credits[0].CreditAvailable.String() != "0.0083" || !credits[0].ExpiredTime.Equal(expired) {
		t.Fatalf("unexpected paid credit: %+v", credits[0])
	}
	if credits[1].CreditType != CreditTypeFree || credits[1].CreditTotal.String() != "0.0020" || credits[1].CreditAvailable.String() != "0.0012" {
		t.Fatalf("unexpected free credit: %+v", credits[1])
	}
}

func TestCompletePaidPackagePropagatesLLMGatewayFailure(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID:        "credit_100",
		LLMGatewayPlanID: "plan-credit-100",
		State:            store.ProductStateOnline,
	}
	upstreamErr := errors.New("llmgateway unavailable")
	svc := New(st, &fakeLLMGateway{applyErr: upstreamErr}, Options{GeneratePackageID: func(context.Context, string) (string, error) { return "cpkg-test001", nil }})

	_, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100", Uin: "10001", AppID: 12345,
		TimeSpan: 1, TimeUnit: "m",
	})
	if !errors.Is(err, upstreamErr) {
		t.Fatalf("err=%v, want %v", err, upstreamErr)
	}
	if st.packages["cpkg-test001"] != nil {
		t.Fatal("package must not be persisted when llmgateway apply fails")
	}
}

func TestCompletePaidPackageRejectsInvalidPeriodBeforeCreatingSubscription(t *testing.T) {
	st := newFakeStore()
	st.products["credit_100"] = &store.CreditProduct{
		ProductID: "credit_100", LLMGatewayPlanID: "plan-credit-100", State: store.ProductStateOnline,
	}
	llm := &fakeLLMGateway{}
	svc := New(st, llm, Options{})

	_, err := svc.CompletePaidPackage(context.Background(), CompletePaidPackageRequest{
		DealName: "deal-1", BigOrderID: "big-1", UserID: "usr_1", ProductID: "credit_100", Uin: "10001", AppID: 12345,
		TimeSpan: 1, TimeUnit: "p",
	})
	if err == nil {
		t.Fatal("expected invalid package period")
	}
	if llm.applyReq != nil {
		t.Fatalf("invalid package period must not create subscription: %+v", llm.applyReq)
	}
}
