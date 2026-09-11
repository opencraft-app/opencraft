package pass

import (
	"context"
	"testing"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	bundlelogic "ctl/pkg/logic/bundle"
	passmodel "ctl/pkg/model/pass"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

type fillCreditBundleLogicStub struct {
	bundle *bundlelogic.BundleDetail
}

func (s *fillCreditBundleLogicStub) ImportBundle(string, string, string, string, string, string, string, int64, int64, int, string, string, string, bool, int, int) (*bundlelogic.BundleDetail, error) {
	return nil, nil
}

func (s *fillCreditBundleLogicStub) GetBundles() ([]*bundlelogic.BundleDetail, error) {
	return nil, nil
}

func (s *fillCreditBundleLogicStub) ModifyBundles([]string, *bundlelogic.ModifyBundleFields) (int64, error) {
	return 0, nil
}

func (s *fillCreditBundleLogicStub) DescribeBundles() ([]*bundlelogic.BundleDetail, error) {
	return nil, nil
}

func (s *fillCreditBundleLogicStub) GetBundleByID(string) (*bundlelogic.BundleDetail, error) {
	return s.bundle, nil
}

type fillCreditAIGatewayStub struct {
	aigateway.Adapter
}

func (s *fillCreditAIGatewayStub) GetActiveSubscription(context.Context, string) (*aigateway.Subscription, error) {
	return nil, aigateway.ErrAiGatewayNotConfigured
}

type fillCreditLLMGatewayStub struct {
	llmgateway.Adapter
	list *llmgateway.ActiveSubscriptionList
}

func (s *fillCreditLLMGatewayStub) ListActiveSubscriptions(context.Context, string) (*llmgateway.ActiveSubscriptionList, error) {
	if s.list == nil {
		return &llmgateway.ActiveSubscriptionList{}, nil
	}
	return s.list, nil
}

type fillCreditAdapterFactory struct {
	adapterfactory.AdapterFactory
	ai  aigateway.Adapter
	llm llmgateway.Adapter
}

func (f *fillCreditAdapterFactory) AiGatewayAdapter() aigateway.Adapter {
	return f.ai
}

func (f *fillCreditAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter {
	return f.llm
}

func TestFillCreditHidesPackageCreditWithoutActivePackageEntitlement(t *testing.T) {
	originalDB := resource.GormDB
	testutil.NewSQLiteDB(t, &userresourcequota.Entity{}, &modelgateway.Entity{})

	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() {
		resource.GormDB = originalDB
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
	})

	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			AiGateway: &config.AiGatewayConfig{},
			LLMGateway: &config.LLMGatewayConfig{
				Enabled: true,
				BaseURL: "https://llmgateway.example.com",
			},
		},
		Bundle: &config.BundleConfig{CreditTokenRatio: 10000},
	}
	adapterfactory.DefaultAdapterFactory = &fillCreditAdapterFactory{
		ai:  &fillCreditAIGatewayStub{},
		llm: &fillCreditLLMGatewayStub{},
	}

	l := &logic{bundleLogic: &fillCreditBundleLogicStub{bundle: &bundlelogic.BundleDetail{
		BundleID:   "bundle_launch_01",
		BundleName: "启航套餐",
		Credit:     100,
	}}}

	for _, status := range []string{passmodel.StatusActive, passmodel.StatusIsolated} {
		t.Run(status, func(t *testing.T) {
			detail := &PassDetail{
				PassID:   "pass-" + status,
				UserID:   "usr-credit-fill",
				BundleID: "bundle_launch_01",
				Status:   status,
			}

			l.fillCredit(detail)

			if detail.CreditTotal != 0 {
				t.Fatalf("CreditTotal = %d, want 0", detail.CreditTotal)
			}
			if detail.CreditAvailable != 0 {
				t.Fatalf("CreditAvailable = %d, want 0", detail.CreditAvailable)
			}
		})
	}
}
