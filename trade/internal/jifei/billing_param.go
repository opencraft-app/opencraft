package jifei

// IntlPointOfSale is the billing point of sale used by international LightVela sites.
const IntlPointOfSale = "intlSaaSLightvela"

// AddIntlPointOfSale merges the international point of sale into goodsDetail
// without replacing billing parameters already set by the caller.
func AddIntlPointOfSale(goodsDetail map[string]interface{}) {
	billingParam, _ := goodsDetail["billingParam"].(map[string]interface{})
	if billingParam == nil {
		billingParam = make(map[string]interface{})
		goodsDetail["billingParam"] = billingParam
	}
	billingParam["pointOfSale"] = IntlPointOfSale
}
