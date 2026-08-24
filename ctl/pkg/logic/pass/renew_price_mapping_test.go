package pass

import (
	"testing"

	tradeadapter "ctl/pkg/adapter/trade"
)

func TestRenewQuoteToPriceIncludesTaxPrice(t *testing.T) {
	got := renewQuoteToPrice(&tradeadapter.BundleQuote{
		BundleID:      "bundle_launch",
		Price:         "650",
		TotalCost:     "1400",
		TaxPrice:      "84",
		RealTotalCost: "1284",
		Currency:      "USD",
		Discount:      0.9,
	})

	if got.BundleID != "bundle_launch" || got.Price != 650 || got.TotalCost != 1400 ||
		got.TaxPrice != 84 || got.RealTotalCost != 1284 || got.Currency != "USD" || got.Discount != 0.9 {
		t.Fatalf("renewQuoteToPrice() = %+v", got)
	}
}
