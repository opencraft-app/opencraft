package creditorder

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/billingamount"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

var (
	ErrInvalidInput         = errors.New("creditorder: invalid input")
	ErrProductNotFound      = errors.New("creditorder: product not found")
	ErrBindingNotFound      = errors.New("creditorder: binding not found")
	ErrJifeiResponseInvalid = errors.New("creditorder: jifei response invalid")
	ErrDealNameDuplicate    = errors.New("creditorder: deal_name already exists")
)

type Deps struct {
	CreditDefinitionStore store.CreditDefinitionStore
	JifeiClient           jifeiclient.Client
	OrderWriter           store.OrderWriter
	ShadowClient          shadowclient.Client
	SiteKind              string
	RegionOverride        string
	// Inquiry fallback is quote-only. Order paths always require ExternalUserID and never use it.
	InquiryFallbackUin   string
	InquiryFallbackAppID string
}

type Service struct {
	deps     Deps
	region   region.LighthouseRegion
	currency string
}

func New(deps Deps) *Service {
	if deps.CreditDefinitionStore == nil {
		panic("creditorder.New: CreditDefinitionStore is required")
	}
	if deps.JifeiClient == nil {
		panic("creditorder.New: JifeiClient is required")
	}
	if deps.OrderWriter == nil {
		panic("creditorder.New: OrderWriter is required")
	}
	lhRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return &Service{deps: deps, region: lhRegion, currency: resolveCurrency(deps.SiteKind)}
}

type Request struct {
	ExternalUserID string
	Uin            string
	AppID          string
	ProductID      string
	TimeSpan       int
	TimeUnit       string
	GoodsNum       int
	PayMode        int
}

type QuoteResult struct {
	ProductID      string  `json:"product_id"`
	Price          string  `json:"price"`
	TotalCost      string  `json:"total_cost"`
	RealTotalCost  string  `json:"real_total_cost"`
	Currency       string  `json:"currency"`
	Discount       float64 `json:"discount"`
	GoodsNum       int     `json:"goods_num"`
	ProductCode    string  `json:"product_code"`
	SubProductCode string  `json:"sub_product_code"`
	Pid            int64   `json:"pid"`
}

type OrderResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
}

func (s *Service) Quote(ctx context.Context, req Request) (*QuoteResult, error) {
	def, normalized, err := s.prepare(ctx, req, true)
	if err != nil {
		return nil, err
	}
	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
		return nil, fmt.Errorf("%w: missing category_ids[scene=purchase] productId=%s", ErrProductNotFound, normalized.ProductID)
	}
	resp, err := s.deps.JifeiClient.GetPrice(ctx, &jifeiclient.GetPriceRequest{
		OwnerUin: normalized.Uin,
		Uin:      normalized.Uin,
		ResInfo: []jifeiclient.GetPriceItem{
			{
				GoodsCategoryID: categoryID,
				Currency:        s.currency,
				RegionID:        s.region.RegionID,
				ZoneID:          s.region.ZoneID,
				GoodsNum:        normalized.GoodsNum,
				PayMode:         normalized.PayMode,
				GoodsDetail:     buildGoodsDetail(def, normalized),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creditorder: jifei GetPrice: %w", err)
	}
	if resp == nil || len(resp.Data) == 0 {
		return nil, fmt.Errorf("%w: empty getPrice data", ErrJifeiResponseInvalid)
	}
	data := resp.Data[0]
	discount := 0.0
	if data.PolicyDetail != nil {
		discount = data.PolicyDetail.Total
	}
	productCode := data.ProductCode
	if productCode == "" {
		productCode = def.ProductCode
	}
	subProductCode := data.SubProductCode
	if subProductCode == "" {
		subProductCode = def.SubProductCode
	}
	pid := data.Pid
	if pid == 0 {
		pid = def.Pid
	}
	price, totalCost, realTotalCost, err := s.quoteAmountFields(data)
	if err != nil {
		return nil, err
	}
	return &QuoteResult{
		ProductID:      normalized.ProductID,
		Price:          price,
		TotalCost:      totalCost,
		RealTotalCost:  realTotalCost,
		Currency:       data.Currency,
		Discount:       discount,
		GoodsNum:       normalized.GoodsNum,
		ProductCode:    productCode,
		SubProductCode: subProductCode,
		Pid:            pid,
	}, nil
}

func (s *Service) quoteAmountFields(data jifeiclient.GetPriceData) (price, totalCost, realTotalCost string, err error) {
	price = string(data.Price)
	totalCost = string(data.TotalCost)
	realTotalCost = string(data.RealTotalCost)
	if !strings.EqualFold(s.currency, "USD") {
		return price, totalCost, realTotalCost, nil
	}
	if data.TaxDetail == nil {
		return "", "", "", fmt.Errorf("%w: jifei GetPrice taxDetail is required for intl quote", ErrJifeiResponseInvalid)
	}
	if data.HighPrecisionPrice != nil {
		if value := strings.TrimSpace(string(data.HighPrecisionPrice.PriceHigh)); value != "" {
			price = value
		}
		if value := strings.TrimSpace(string(data.HighPrecisionPrice.TotalCostHigh)); value != "" {
			totalCost = value
		}
		if value := strings.TrimSpace(string(data.HighPrecisionPrice.RealTotalCostHigh)); value != "" {
			realTotalCost = value
		}
	}
	price, err = creditAmountCents("price", price, "0")
	if err != nil {
		return "", "", "", err
	}
	totalCost, err = creditAmountCents("totalCost", totalCost, "0")
	if err != nil {
		return "", "", "", err
	}
	realTotalCost, err = creditAmountCents("realTotalCost", realTotalCost, string(data.TaxDetail.TaxRate))
	if err != nil {
		return "", "", "", err
	}
	return price, totalCost, realTotalCost, nil
}

func creditAmountCents(field, rawAmount, taxRate string) (string, error) {
	cents, err := billingamount.TaxInclusiveCents(rawAmount, taxRate)
	if err != nil {
		return "", fmt.Errorf("%w: jifei GetPrice invalid %s=%q or taxRate=%q: %v", ErrJifeiResponseInvalid, field, rawAmount, taxRate, err)
	}
	return cents, nil
}

func (s *Service) PlaceOrder(ctx context.Context, req Request) (*OrderResult, error) {
	def, normalized, err := s.prepare(ctx, req, false)
	if err != nil {
		return nil, err
	}
	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
		return nil, fmt.Errorf("%w: missing category_ids[scene=purchase] productId=%s", ErrProductNotFound, normalized.ProductID)
	}
	appID, err := parseAppID(normalized.AppID)
	if err != nil {
		return nil, err
	}
	resp, err := s.deps.JifeiClient.GenerateDeals(ctx, &jifeiclient.GenerateDealsRequest{
		OwnerUin: normalized.Uin,
		Uin:      normalized.Uin,
		AppID:    appID,
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        s.region.RegionID,
				ZoneID:          s.region.ZoneID,
				GoodsNum:        normalized.GoodsNum,
				PayMode:         normalized.PayMode,
				ProjectID:       0,
				GoodsDetail:     buildGoodsDetail(def, normalized),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creditorder: jifei GenerateDeals: %w", err)
	}
	if resp == nil || resp.BigDealID == "" || len(resp.DealNames) == 0 || resp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: generateDeals missing deal identity", ErrJifeiResponseInvalid)
	}
	return s.writeOrder(ctx, normalized, def, resp.BigDealID, resp.DealNames[0], store.OrderStatusPendingPay, "", "")
}

func (s *Service) PlaceOrderAndPay(ctx context.Context, req Request) (*OrderResult, error) {
	def, normalized, err := s.prepare(ctx, req, false)
	if err != nil {
		return nil, err
	}
	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
		return nil, fmt.Errorf("%w: missing category_ids[scene=purchase] productId=%s", ErrProductNotFound, normalized.ProductID)
	}
	appID, err := parseAppID(normalized.AppID)
	if err != nil {
		return nil, err
	}
	autoVoucher := 1
	resp, err := s.deps.JifeiClient.GenerateDealsAndPay(ctx, &jifeiclient.GenerateDealsAndPayRequest{
		OwnerUin:    normalized.Uin,
		Uin:         normalized.Uin,
		AppID:       appID,
		AutoVoucher: &autoVoucher,
		Goods: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        s.region.RegionID,
				ZoneID:          s.region.ZoneID,
				GoodsNum:        normalized.GoodsNum,
				PayMode:         normalized.PayMode,
				ProjectID:       0,
				GoodsDetail:     buildGoodsDetail(def, normalized),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creditorder: jifei GenerateDealsAndPay: %w", err)
	}
	if resp == nil || len(resp.BigDealIDs) == 0 || resp.BigDealIDs[0] == "" || len(resp.DealNames) == 0 || resp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: generateDealsAndPay missing deal identity", ErrJifeiResponseInvalid)
	}
	dealName := resp.DealNames[0]
	status := store.OrderStatusPaidPendingProvision
	resourceID := ""
	if deliver, ok := resp.DealDeliverResults[dealName]; ok {
		state, _ := deliver["state"].(string)
		resourceIDs := resp.ResourceIDs[dealName]
		if state == "3" {
			status = store.OrderStatusProvisionFailed
		} else if state == "0" && len(resourceIDs) > 0 && resourceIDs[0] != "" {
			status = store.OrderStatusProvisioned
			resourceID = resourceIDs[0]
		}
	}
	return s.writeOrder(ctx, normalized, def, resp.BigDealIDs[0], dealName, status, resourceID, "")
}

func (s *Service) prepare(ctx context.Context, req Request, quoteOnly bool) (*store.CreditDefinition, Request, error) {
	req.ExternalUserID = strings.TrimSpace(req.ExternalUserID)
	req.Uin = strings.TrimSpace(req.Uin)
	req.AppID = strings.TrimSpace(req.AppID)
	req.ProductID = strings.TrimSpace(req.ProductID)
	if req.GoodsNum == 0 {
		req.GoodsNum = 1
	}
	if req.TimeSpan == 0 {
		req.TimeSpan = 1
	}
	req.TimeUnit = strings.TrimSpace(req.TimeUnit)
	if req.TimeUnit == "" {
		req.TimeUnit = "m"
	}
	if req.PayMode == 0 {
		req.PayMode = 1
	}
	if req.ExternalUserID == "" && !quoteOnly {
		return nil, req, fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}
	if req.ProductID == "" {
		return nil, req, fmt.Errorf("%w: product_id is required", ErrInvalidInput)
	}
	if req.GoodsNum <= 0 {
		return nil, req, fmt.Errorf("%w: goods_num must be positive", ErrInvalidInput)
	}
	if req.PayMode != 1 {
		return nil, req, fmt.Errorf("%w: pay_mode must be 1", ErrInvalidInput)
	}
	if err := validatePeriod(req.TimeSpan, req.TimeUnit); err != nil {
		return nil, req, err
	}
	if req.Uin == "" && req.ExternalUserID != "" && s.deps.ShadowClient != nil {
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				if !quoteOnly || !s.applyInquiryFallbackIdentity(&req) {
					return nil, req, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
				}
			} else {
				return nil, req, fmt.Errorf("creditorder: shadow GetBindingByExternalUserID: %w", err)
			}
		} else {
			req.Uin = strings.TrimSpace(binding.Uin)
			if req.AppID == "" {
				req.AppID = strings.TrimSpace(binding.AppID)
			}
		}
	}
	if req.Uin == "" && quoteOnly {
		s.applyInquiryFallbackIdentity(&req)
	}
	if req.Uin == "" {
		return nil, req, fmt.Errorf("%w: uin is required", ErrInvalidInput)
	}
	if req.AppID == "" {
		return nil, req, fmt.Errorf("%w: app_id is required", ErrInvalidInput)
	}
	def, err := s.deps.CreditDefinitionStore.GetCreditDefinitionByProductID(ctx, req.ProductID)
	if err != nil {
		if errors.Is(err, store.ErrCreditDefinitionNotFound) {
			return nil, req, fmt.Errorf("%w: productId=%s", ErrProductNotFound, req.ProductID)
		}
		return nil, req, fmt.Errorf("creditorder: get credit definition: %w", err)
	}
	return def, req, nil
}

func (s *Service) applyInquiryFallbackIdentity(req *Request) bool {
	fallbackUin := strings.TrimSpace(s.deps.InquiryFallbackUin)
	fallbackAppID := strings.TrimSpace(s.deps.InquiryFallbackAppID)
	if fallbackUin == "" || fallbackAppID == "" {
		return false
	}
	req.Uin = fallbackUin
	req.AppID = fallbackAppID
	return true
}

func (s *Service) writeOrder(ctx context.Context, req Request, def *store.CreditDefinition, bigOrderID string, dealName string, status string, resourceID string, payURL string) (*OrderResult, error) {
	in := store.CreateOrderInput{
		BigOrderID:     bigOrderID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.ProductID,
		Period:         req.TimeSpan,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		RegionID:       s.region.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    buildGoodsDetail(def, req),
		PayURL:         payURL,
		Status:         status,
		ResourceType:   "credit_package",
		ResourceID:     resourceID,
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("creditorder: create order: %w", err)
	}
	return &OrderResult{DealName: dealName, BigOrderID: bigOrderID}, nil
}

func buildGoodsDetail(def *store.CreditDefinition, req Request) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":     def.ProductCode,
		"subProductCode":  def.SubProductCode,
		"pid":             def.Pid,
		"goodsNum":        req.GoodsNum,
		"productId":       req.ProductID,
		"timeSpan":        1,
		"timeUnit":        "p",
		"packageTimeSpan": req.TimeSpan,
		"packageTimeUnit": req.TimeUnit,
	}
	if req.ExternalUserID != "" {
		out["externalUserId"] = req.ExternalUserID
	}
	for k, v := range def.SVList {
		out[k] = v
	}
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}

func validatePeriod(span int, unit string) error {
	if span <= 0 {
		return fmt.Errorf("%w: time_span must be positive", ErrInvalidInput)
	}
	switch strings.TrimSpace(unit) {
	case "y", "m", "d", "h", "M", "s":
		return nil
	default:
		return fmt.Errorf("%w: time_unit must be one of y/m/d/h/M/s", ErrInvalidInput)
	}
}

func parseAppID(appID string) (int64, error) {
	v, err := strconv.ParseInt(strings.TrimSpace(appID), 10, 64)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%w: invalid app_id=%q", ErrInvalidInput, appID)
	}
	return v, nil
}

func resolveCurrency(siteKind string) string {
	if siteKind == "intl" {
		return "USD"
	}
	return "CNY"
}
