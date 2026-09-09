package creditusage

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/resourcebillingclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

type Deps struct {
	DefinitionStore store.CreditDefinitionStore
	BillingClient   resourcebillingclient.Client
	CID             string
	SiteKind        string
	RegionOverride  string
}

type Service struct {
	deps   Deps
	region region.LighthouseRegion
}

type ReportRequest struct {
	PackageID          string      `json:"package_id"`
	ProductID          string      `json:"product_id"`
	DealName           string      `json:"deal_name"`
	Uin                string      `json:"uin"`
	AppID              int64       `json:"app_id"`
	UsageDate          string      `json:"usage_date"`
	CalcDate           string      `json:"calc_date"`
	PackageExpiredTime time.Time   `json:"package_expired_time"`
	CreditTotal        json.Number `json:"credit_total"`
	CreditUsedDay      json.Number `json:"credit_used_day"`
	CreditLeft         json.Number `json:"credit_left"`
}

func New(deps Deps) *Service {
	if deps.DefinitionStore == nil || deps.BillingClient == nil {
		panic("creditusage.New: definition store and billing client are required")
	}
	if strings.TrimSpace(deps.CID) == "" {
		deps.CID = "101433"
	}
	return &Service{deps: deps, region: region.Resolve(deps.SiteKind, deps.RegionOverride)}
}

func (s *Service) Report(ctx context.Context, req ReportRequest) (json.RawMessage, error) {
	if err := validateReport(req); err != nil {
		return nil, err
	}
	def, err := s.deps.DefinitionStore.GetCreditDefinitionByProductID(ctx, strings.TrimSpace(req.ProductID))
	if err != nil {
		return nil, err
	}
	parts, err := json.Marshal(map[string]json.Number{
		"credit_day": req.CreditUsedDay, "credit_total": req.CreditTotal, "credit_left": req.CreditLeft,
	})
	if err != nil {
		return nil, err
	}
	params, _ := json.Marshal(map[string]map[string]int{"units": {"credit": 1}})
	calcDate := strings.ReplaceAll(req.CalcDate, "-", "")
	response, err := s.deps.BillingClient.SendResource(ctx, resourcebillingclient.Request{
		CID: strings.TrimSpace(s.deps.CID), CalcDate: calcDate,
		Data: map[string][]resourcebillingclient.Resource{req.Uin: {{
			SerialID: req.PackageID, OrderID: req.DealName, Uin: req.Uin, AppID: req.AppID,
			RegionID: s.region.RegionID, ZoneID: s.region.ZoneID, PayMode: 1, Platform: 1,
			ProjectID: 0, CalcNum: 1, TimeSpan: 1, Pid: def.Pid,
			ProductCode: def.ProductCode, SubProductCode: def.SubProductCode,
			Params: string(params), Parts: string(parts), CalcDate: calcDate,
			StartTime: req.UsageDate + " 00:00:00", EndTime: req.UsageDate + " 23:59:59", DataStatus: "0",
		}}},
	})
	if err != nil {
		return nil, err
	}
	return json.Marshal(response)
}

func validateReport(req ReportRequest) error {
	if strings.TrimSpace(req.PackageID) == "" || strings.TrimSpace(req.ProductID) == "" || strings.TrimSpace(req.DealName) == "" ||
		strings.TrimSpace(req.Uin) == "" || req.AppID <= 0 {
		return fmt.Errorf("credit usage identity fields are required")
	}
	if _, err := time.Parse(time.DateOnly, req.UsageDate); err != nil {
		return fmt.Errorf("invalid usage_date: %w", err)
	}
	if _, err := time.Parse(time.DateOnly, req.CalcDate); err != nil {
		return fmt.Errorf("invalid calc_date: %w", err)
	}
	if req.PackageExpiredTime.IsZero() {
		return fmt.Errorf("package_expired_time is required")
	}
	for name, value := range map[string]json.Number{"credit_total": req.CreditTotal, "credit_used_day": req.CreditUsedDay, "credit_left": req.CreditLeft} {
		if _, ok := new(big.Rat).SetString(value.String()); !ok {
			return fmt.Errorf("invalid %s", name)
		}
	}
	return nil
}
