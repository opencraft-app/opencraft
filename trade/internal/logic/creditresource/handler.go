package creditresource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/creditclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeitime "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

const handlerTimeout = 4 * time.Second

const (
	resourceQueryTimeout       = 2500 * time.Millisecond
	resourceTimeFormat         = "2006-01-02 15:04:05"
	resourceNullTime           = "0000-00-00 00:00:00"
	creditResourceInstanceType = 6
)

type Deps struct {
	FlowStore             store.FlowStore
	CreditClient          creditclient.Client
	CreditDefinitionStore store.CreditDefinitionStore
	Builder               *jifei.FrameworkBuilder
	SiteKind              string
	RegionOverride        string
}

type createPara struct {
	DealName    string                 `json:"dealName"`
	BigOrderID  string                 `json:"bigDealId"`
	AppID       int64                  `json:"appId"`
	Uin         string                 `json:"uin"`
	Region      int                    `json:"region"`
	PayMode     int                    `json:"payMode"`
	GoodsDetail map[string]interface{} `json:"goodsDetail"`
}

type lifecyclePara struct {
	ResourceID string `json:"resourceId"`
	AppID      int64  `json:"appId"`
	Uin        string `json:"uin"`
	Reason     string `json:"reason"`
}

type usedAmountPara struct {
	ProductCode    string   `json:"productCode"`
	SubProductCode string   `json:"subProductCode"`
	Region         int      `json:"region"`
	ResourceIDs    []string `json:"resourceIdList"`
	AppID          int64    `json:"appId"`
	Uin            string   `json:"uin"`
	PayMode        int      `json:"payMode"`
}

type getAllAppIDsPara struct {
	ProductCode    string `json:"productCode"`
	SubProductCode string `json:"subProductCode"`
	PayMode        int    `json:"payMode"`
	Region         int    `json:"region"`
	PageNo         int    `json:"pageNo"`
	PageSize       int    `json:"pageSize"`
}

type getUserResourcesPara struct {
	Uin             string `json:"uin"`
	AppID           int64  `json:"appId"`
	ProductCode     string `json:"productCode"`
	SubProductCode  string `json:"subProductCode"`
	PayMode         int    `json:"payMode"`
	Region          int    `json:"region"`
	PageNo          int    `json:"pageNo"`
	PageSize        int    `json:"pageSize"`
	NeedDeviceInfos int    `json:"needDeviceInfos"`
}

type queryResourcePara struct {
	Uin             string   `json:"uin"`
	AppID           int64    `json:"appId"`
	ProductCode     string   `json:"productCode"`
	SubProductCode  string   `json:"subProductCode"`
	PayMode         int      `json:"payMode"`
	Region          int      `json:"region"`
	ResourceIDs     []string `json:"resourceIds"`
	NeedDeviceInfos int      `json:"needDeviceInfos"`
}

func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameCreditCheckCreate, makeCheckCreateHandler(deps))
	d.Register(jifei.InterfaceNameCreditCreateResource, makeCreateHandler(deps))
	d.Register(jifei.InterfaceNameCreditGetAllAppIDs, makeGetAllAppIDsHandler(deps))
	d.Register(jifei.InterfaceNameCreditGetUserResources, makeGetUserResourcesHandler(deps))
	d.Register(jifei.InterfaceNameCreditQueryResource, makeQueryResourceHandler(deps))
	d.Register(jifei.InterfaceNameCreditIsolateResource, makeIsolateHandler(deps))
	d.Register(jifei.InterfaceNameCreditGetUsedAmount, makeGetUsedAmountHandler(deps))
}

func makeGetAllAppIDsHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, resourceQueryTimeout)
		defer cancel()
		var para getAllAppIDsPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610601, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if para.ProductCode == "" || para.PageNo < 0 || para.PageSize <= 0 || para.PageSize > 20000 {
			return deps.Builder.NewError(610602, "productCode, pageNo >= 0 and pageSize between 1 and 20000 are required"), nil
		}
		if para.PayMode != 1 {
			return deps.Builder.NewSuccess(emptyAppIDs()), nil
		}
		definitions, err := deps.CreditDefinitionStore.ListCreditDefinitions(ctx, para.ProductCode, para.SubProductCode)
		if err != nil {
			return deps.Builder.NewError(610603, fmt.Sprintf("list credit definitions: %v", err)), nil
		}
		productIDs := creditProductIDs(definitions)
		if len(productIDs) == 0 {
			return deps.Builder.NewSuccess(emptyAppIDs()), nil
		}
		appIDs, total, err := deps.CreditClient.ListResourceAppIDs(ctx, &creditclient.ResourcePageRequest{
			ProductIDs: productIDs, PageNo: para.PageNo, PageSize: para.PageSize,
		})
		if err != nil {
			return deps.Builder.NewError(610604, fmt.Sprintf("list credit app ids: %v", err)), nil
		}
		if appIDs == nil {
			appIDs = []int64{}
		}
		return deps.Builder.NewSuccess(map[string]any{"appIds": appIDs, "total": total}), nil
	}
}

func makeGetUserResourcesHandler(deps Deps) jifei.Handler {
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, resourceQueryTimeout)
		defer cancel()
		var para getUserResourcesPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610611, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if strings.TrimSpace(para.Uin) == "" || para.AppID <= 0 || para.PageNo < 0 || para.PageSize <= 0 || para.PageSize > 1000 {
			return deps.Builder.NewError(610612, "uin, appId, pageNo >= 0 and pageSize between 1 and 1000 are required"), nil
		}
		if _, err := strconv.ParseInt(para.Uin, 10, 64); err != nil {
			return deps.Builder.NewError(610612, "uin must be a numeric string"), nil
		}
		if para.PayMode != 1 {
			return deps.Builder.NewSuccess(emptyResources()), nil
		}
		definitions, err := deps.CreditDefinitionStore.ListCreditDefinitions(ctx, para.ProductCode, para.SubProductCode)
		if err != nil {
			return deps.Builder.NewError(610613, fmt.Sprintf("list credit definitions: %v", err)), nil
		}
		if len(definitions) == 0 {
			return deps.Builder.NewSuccess(emptyResources()), nil
		}
		items, total, err := deps.CreditClient.ListUserResources(ctx, &creditclient.UserResourcePageRequest{
			Uin: para.Uin, AppID: para.AppID, ProductIDs: creditProductIDs(definitions),
			PageNo: para.PageNo, PageSize: para.PageSize,
		})
		if err != nil {
			return deps.Builder.NewError(610614, fmt.Sprintf("list credit user resources: %v", err)), nil
		}
		resources := mapCreditResources(items, definitionsByProductID(definitions), expectedRegion, para.ProductCode, para.SubProductCode)
		return deps.Builder.NewSuccess(map[string]any{"resources": resources, "total": total}), nil
	}
}

func makeQueryResourceHandler(deps Deps) jifei.Handler {
	expectedRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, resourceQueryTimeout)
		defer cancel()
		var para queryResourcePara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610621, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if para.PayMode == 0 {
			para.PayMode = 1
		}
		if para.AppID <= 0 || len(para.ResourceIDs) == 0 || len(para.ResourceIDs) > 100 {
			return deps.Builder.NewError(610622, "appId and 1 to 100 resourceIds are required"), nil
		}
		if para.Uin != "" {
			if _, err := strconv.ParseInt(para.Uin, 10, 64); err != nil {
				return deps.Builder.NewError(610622, "uin must be a numeric string when present"), nil
			}
		}
		if para.PayMode != 1 {
			return deps.Builder.NewSuccess(emptyResources()), nil
		}
		items, err := deps.CreditClient.QueryResources(ctx, &creditclient.ResourceQueryRequest{
			Uin: para.Uin, AppID: para.AppID, ResourceIDs: para.ResourceIDs,
		})
		if err != nil {
			return deps.Builder.NewError(610623, fmt.Sprintf("query credit resources: %v", err)), nil
		}
		definitions := make(map[string]*store.CreditDefinition)
		for _, item := range items {
			if _, ok := definitions[item.ProductID]; ok {
				continue
			}
			def, err := deps.CreditDefinitionStore.GetCreditDefinitionByProductID(ctx, item.ProductID)
			if err != nil {
				return deps.Builder.NewError(610624, fmt.Sprintf("get credit definition: %v", err)), nil
			}
			definitions[item.ProductID] = def
		}
		resources := mapCreditResources(items, definitions, expectedRegion, para.ProductCode, para.SubProductCode)
		return deps.Builder.NewSuccess(map[string]any{"resources": resources, "total": int64(len(resources))}), nil
	}
}

func creditProductIDs(definitions []*store.CreditDefinition) []string {
	productIDs := make([]string, 0, len(definitions))
	for _, def := range definitions {
		if def != nil && def.ProductID != "" {
			productIDs = append(productIDs, def.ProductID)
		}
	}
	return productIDs
}

func definitionsByProductID(definitions []*store.CreditDefinition) map[string]*store.CreditDefinition {
	byID := make(map[string]*store.CreditDefinition, len(definitions))
	for _, def := range definitions {
		if def != nil {
			byID[def.ProductID] = def
		}
	}
	return byID
}

func mapCreditResources(
	items []creditclient.ResourceItem,
	definitions map[string]*store.CreditDefinition,
	expectedRegion region.LighthouseRegion,
	productCode, subProductCode string,
) []map[string]any {
	resources := make([]map[string]any, 0, len(items))
	for _, item := range items {
		def := definitions[item.ProductID]
		if def == nil || (productCode != "" && productCode != def.ProductCode) ||
			(subProductCode != "" && subProductCode != def.SubProductCode) {
			continue
		}
		resources = append(resources, creditResourceMap(item, def, expectedRegion))
	}
	return resources
}

func creditResourceMap(item creditclient.ResourceItem, def *store.CreditDefinition, expectedRegion region.LighthouseRegion) map[string]any {
	status := 2
	if item.Status == "active" {
		status = 1
	}
	allowReturn := 0
	if item.AllowReturn {
		allowReturn = 1
	}
	goodsDetail := map[string]any{
		"productCode": def.ProductCode, "subProductCode": def.SubProductCode, "pid": def.Pid,
	}
	for key, value := range def.SVList {
		goodsDetail[key] = value
	}
	productInfo := make([]map[string]interface{}, 0, len(def.ProductInfo)+1)
	productInfo = append(productInfo, map[string]interface{}{"name": "地域", "value": expectedRegion.RegionName})
	productInfo = append(productInfo, def.ProductInfo...)
	goodsDetail["productInfo"] = productInfo
	return map[string]any{
		"uin": item.Uin, "appId": item.AppID, "resourceId": item.PackageID,
		"region": expectedRegion.RegionID, "zoneId": expectedRegion.ZoneID, "status": status,
		"isolatedTimestamp": formatResourceTimePtr(item.IsolatedTime),
		"createTime":        formatResourceTime(item.CreatedTime), "expireTime": formatResourceTime(item.ExpiredTime),
		"payMode": 1, "instanceType": creditResourceInstanceType, "allowReturn": allowReturn, "renewFlag": 0, "alias": "",
		"goodsDetail": goodsDetail,
	}
}

func formatResourceTime(value time.Time) string {
	if value.IsZero() {
		return resourceNullTime
	}
	return value.In(jifeitime.CurDeadlineLocation).Format(resourceTimeFormat)
}

func formatResourceTimePtr(value *time.Time) string {
	if value == nil || value.IsZero() {
		return resourceNullTime
	}
	return formatResourceTime(*value)
}

func emptyAppIDs() map[string]any {
	return map[string]any{"appIds": []int64{}, "total": int64(0)}
}

func emptyResources() map[string]any {
	return map[string]any{"resources": []map[string]any{}, "total": int64(0)}
}

func makeCheckCreateHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, handlerTimeout)
		defer cancel()
		var para struct {
			GoodsDetail map[string]interface{} `json:"goodsDetail"`
		}
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610101, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if goodsDetailString(para.GoodsDetail, "externalUserId") == "" || goodsDetailString(para.GoodsDetail, "productId") == "" ||
			!validResourcePackagePeriod(para.GoodsDetail) {
			return deps.Builder.NewError(610102, "externalUserId, productId, timeSpan=1, timeUnit=p and packageTimeSpan/packageTimeUnit are required"), nil
		}
		productID := goodsDetailString(para.GoodsDetail, "productId")
		def, err := deps.CreditDefinitionStore.GetCreditDefinitionByProductID(ctx, productID)
		if errors.Is(err, store.ErrCreditDefinitionNotFound) {
			return deps.Builder.NewError(610103, fmt.Sprintf("credit definition not found: productId=%s", productID)), nil
		}
		if err != nil {
			return deps.Builder.NewError(610104, fmt.Sprintf("get credit definition: %v", err)), nil
		}
		if err := validateCreditGoodsDetail(para.GoodsDetail, def); err != nil {
			return deps.Builder.NewError(610105, err.Error()), nil
		}
		return deps.Builder.NewSuccess(map[string]any{"status": 0}), nil
	}
}

func validateCreditGoodsDetail(goodsDetail map[string]interface{}, def *store.CreditDefinition) error {
	if def == nil {
		return errors.New("credit definition is nil")
	}
	pid, ok := goodsDetailInt64(goodsDetail, "pid")
	if !ok || pid != def.Pid {
		return fmt.Errorf("pid mismatch: jifei=%d, credit_definition=%d", pid, def.Pid)
	}
	if len(def.SVList) == 0 {
		return errors.New("credit definition must contain at least one sv_* field")
	}
	for key, want := range def.SVList {
		if !strings.HasPrefix(key, "sv_") {
			return fmt.Errorf("credit definition contains invalid sv field %q", key)
		}
		got, ok := goodsDetailInt64(goodsDetail, key)
		if !ok || got != want {
			return fmt.Errorf("sv field mismatch: jifei[%s]=%d, credit_definition.sv_list[%s]=%d", key, got, key, want)
		}
	}
	for key := range goodsDetail {
		if strings.HasPrefix(key, "sv_") {
			if _, ok := def.SVList[key]; !ok {
				return fmt.Errorf("unexpected sv field: jifei[%s]", key)
			}
		}
	}
	return nil
}

func makeCreateHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, handlerTimeout)
		defer cancel()
		var para createPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610201, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		userID := goodsDetailString(para.GoodsDetail, "externalUserId")
		productID := goodsDetailString(para.GoodsDetail, "productId")
		if para.DealName == "" || para.BigOrderID == "" || para.AppID <= 0 || para.Uin == "" || userID == "" || productID == "" ||
			!validResourcePackagePeriod(para.GoodsDetail) {
			return deps.Builder.NewError(610202, "dealName, bigDealId, appId, uin and complete resource-package goodsDetail are required"), nil
		}
		appID := strconv.FormatInt(para.AppID, 10)
		acquired, existing, err := deps.FlowStore.TryAcquireSlot(ctx, para.DealName, store.FlowTypeCreateResource, appID, paraRaw)
		if err != nil {
			return deps.Builder.NewError(610203, fmt.Sprintf("acquire flow: %v", err)), nil
		}
		if !acquired {
			return replayOrInProgress(deps.Builder, existing), nil
		}
		pkg, err := deps.CreditClient.CompletePackage(ctx, &creditclient.CompletePackageRequest{
			DealName: para.DealName, BigOrderID: para.BigOrderID, UserID: userID,
			ProductID: productID, Uin: para.Uin, AppID: para.AppID,
			TimeSpan: goodsDetailInt(para.GoodsDetail, "packageTimeSpan"), TimeUnit: goodsDetailString(para.GoodsDetail, "packageTimeUnit"),
		})
		if err != nil {
			deleteCreateFlow(ctx, deps.FlowStore, para.DealName, appID)
			return deps.Builder.NewError(610204, fmt.Sprintf("complete credit package: %v", err)), nil
		}
		resp := deps.Builder.NewSuccess(map[string]any{"resourceIds": []string{pkg.PackageID}})
		respBytes, _ := json.Marshal(resp)
		if err := deps.FlowStore.MarkCompletedWithResourceID(ctx, para.DealName, store.FlowTypeCreateResource, appID, pkg.PackageID, respBytes); err != nil {
			deleteCreateFlow(ctx, deps.FlowStore, para.DealName, appID)
			return deps.Builder.NewError(610205, fmt.Sprintf("complete credit flow: %v", err)), nil
		}
		return resp, nil
	}
}

func deleteCreateFlow(ctx context.Context, flowStore store.FlowStore, dealName, appID string) {
	flow, err := flowStore.GetFlow(ctx, dealName, store.FlowTypeCreateResource, appID)
	if err == nil && flow != nil {
		_ = flowStore.DeleteByID(ctx, flow.ID)
	}
}

func makeGetUsedAmountHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		defer cancel()
		var para usedAmountPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610501, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if para.AppID <= 0 || strings.TrimSpace(para.Uin) == "" || para.Region <= 0 || para.PayMode != 1 || len(para.ResourceIDs) == 0 {
			return deps.Builder.NewError(610502, "appId, uin, region, payMode=1 and resourceIdList are required"), nil
		}
		items, err := deps.CreditClient.GetUsedAmounts(ctx, &creditclient.UsedAmountRequest{
			Uin: para.Uin, AppID: para.AppID, ResourceIDs: para.ResourceIDs,
		})
		if err != nil {
			return deps.Builder.NewError(610503, fmt.Sprintf("get credit used amounts: %v", err)), nil
		}
		data := make(map[string]any, len(para.ResourceIDs))
		for _, resourceID := range para.ResourceIDs {
			item, ok := items[resourceID]
			if !ok {
				return deps.Builder.NewError(610504, fmt.Sprintf("credit response missing resource %s", resourceID)), nil
			}
			def, err := deps.CreditDefinitionStore.GetCreditDefinitionByProductID(ctx, item.ProductID)
			if err != nil {
				return deps.Builder.NewError(610505, fmt.Sprintf("get credit definition: %v", err)), nil
			}
			if (strings.TrimSpace(para.ProductCode) != "" && para.ProductCode != def.ProductCode) ||
				(strings.TrimSpace(para.SubProductCode) != "" && para.SubProductCode != def.SubProductCode) {
				return deps.Builder.NewError(610505, "credit product code does not match resource"), nil
			}
			period, timeUnit, err := creditPeriodFromCreateFlow(ctx, deps.FlowStore, para, resourceID, item, def)
			if err != nil {
				return deps.Builder.NewError(610506, fmt.Sprintf("get credit billing period: %v", err)), nil
			}
			svKey, err := singleSVKey(def.SVList)
			if err != nil {
				return deps.Builder.NewError(610507, err.Error()), nil
			}
			data[resourceID] = map[string]any{
				"pid": def.Pid, "timeUnit": timeUnit, "timeSpan": period,
				"payMode": 1, svKey: item.UsedRatio,
			}
		}
		return deps.Builder.NewSuccess(data), nil
	}
}

func creditPeriodFromCreateFlow(
	ctx context.Context,
	flowStore store.FlowStore,
	query usedAmountPara,
	resourceID string,
	item creditclient.UsedAmountItem,
	def *store.CreditDefinition,
) (int, string, error) {
	if flowStore == nil {
		return 0, "", errors.New("flow store is not configured")
	}
	appID := strconv.FormatInt(query.AppID, 10)
	flow, err := flowStore.GetFlow(ctx, item.DealName, store.FlowTypeCreateResource, appID)
	if err != nil {
		return 0, "", fmt.Errorf("get completed create flow: %w", err)
	}
	if flow == nil || flow.Status != store.FlowStatusCompleted || len(flow.RequestBody) == 0 {
		return 0, "", errors.New("completed create flow with request body not found")
	}
	if flow.ResourceID == nil || strings.TrimSpace(*flow.ResourceID) != strings.TrimSpace(resourceID) ||
		strings.TrimSpace(item.PackageID) != strings.TrimSpace(resourceID) {
		return 0, "", errors.New("create flow does not match credit resource")
	}

	var created createPara
	if err := json.Unmarshal(flow.RequestBody, &created); err != nil {
		return 0, "", fmt.Errorf("decode create flow request: %w", err)
	}
	if created.DealName != item.DealName || created.AppID != query.AppID ||
		strings.TrimSpace(created.Uin) != strings.TrimSpace(query.Uin) ||
		created.Region != query.Region || created.PayMode != query.PayMode {
		return 0, "", errors.New("create flow does not match resource ownership")
	}
	if goodsDetailString(created.GoodsDetail, "productId") != item.ProductID ||
		goodsDetailString(created.GoodsDetail, "productCode") != def.ProductCode ||
		goodsDetailString(created.GoodsDetail, "subProductCode") != def.SubProductCode {
		return 0, "", errors.New("create flow does not match credit product")
	}
	if err := validateCreditGoodsDetail(created.GoodsDetail, def); err != nil {
		return 0, "", err
	}
	if !validResourcePackagePeriod(created.GoodsDetail) {
		return 0, "", errors.New("create flow contains invalid resource-package period")
	}
	return goodsDetailInt(created.GoodsDetail, "packageTimeSpan"), goodsDetailString(created.GoodsDetail, "packageTimeUnit"), nil
}

func singleSVKey(values map[string]int64) (string, error) {
	var key string
	for candidate := range values {
		if !strings.HasPrefix(candidate, "sv_") || key != "" {
			return "", fmt.Errorf("credit definition must contain exactly one sv_* field")
		}
		key = candidate
	}
	if key == "" {
		return "", fmt.Errorf("credit definition must contain exactly one sv_* field")
	}
	return key, nil
}

func makeIsolateHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, handlerTimeout)
		defer cancel()
		var para lifecyclePara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(610301, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if para.ResourceID == "" || para.AppID <= 0 || para.Uin == "" {
			return deps.Builder.NewError(610302, "resourceId, appId and uin are required"), nil
		}
		appID := strconv.FormatInt(para.AppID, 10)
		acquired, existing, err := deps.FlowStore.TryAcquireSlotForIsolate(
			ctx, para.ResourceID, store.FlowTypeIsolateResource, appID, para.Uin, paraRaw, nil,
		)
		if err != nil {
			return deps.Builder.NewError(610303, fmt.Sprintf("acquire flow: %v", err)), nil
		}
		if !acquired {
			return replayOrInProgress(deps.Builder, existing), nil
		}
		err = deps.CreditClient.IsolatePackage(ctx, para.ResourceID, strings.TrimSpace(para.Reason))
		if err != nil {
			_ = deps.FlowStore.DeleteByID(ctx, existingFlowID(existing))
			return deps.Builder.NewError(610304, fmt.Sprintf("credit lifecycle failed: %v", err)), nil
		}
		resp := deps.Builder.NewSuccess(map[string]any{"status": "ok"})
		respBytes, _ := json.Marshal(resp)
		if flowID := existingFlowID(existing); flowID > 0 {
			_ = deps.FlowStore.MarkCompletedByID(ctx, flowID, respBytes)
		}
		return resp, nil
	}
}

func replayOrInProgress(builder *jifei.FrameworkBuilder, flow *store.Flow) jifei.Framework {
	if flow != nil && flow.Status == store.FlowStatusCompleted && len(flow.ResponseBody) > 0 {
		var resp jifei.Framework
		if err := json.Unmarshal(flow.ResponseBody, &resp); err == nil {
			return resp
		}
	}
	return builder.NewError(610305, "flow is in progress")
}

func goodsDetailString(detail map[string]interface{}, key string) string {
	if detail == nil {
		return ""
	}
	value, _ := detail[key].(string)
	return strings.TrimSpace(value)
}

func goodsDetailInt(detail map[string]interface{}, key string) int {
	if detail == nil {
		return 0
	}
	switch value := detail[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	default:
		return 0
	}
}

func goodsDetailInt64(detail map[string]interface{}, key string) (int64, bool) {
	if detail == nil {
		return 0, false
	}
	switch value := detail[key].(type) {
	case float64:
		integer := int64(value)
		return integer, float64(integer) == value
	case int:
		return int64(value), true
	case int64:
		return value, true
	case json.Number:
		integer, err := value.Int64()
		return integer, err == nil
	default:
		return 0, false
	}
}

func validResourcePackagePeriod(detail map[string]interface{}) bool {
	if goodsDetailInt(detail, "timeSpan") != 1 || goodsDetailString(detail, "timeUnit") != "p" || goodsDetailInt(detail, "packageTimeSpan") <= 0 {
		return false
	}
	switch goodsDetailString(detail, "packageTimeUnit") {
	case "y", "m", "d", "h", "M", "s":
		return true
	default:
		return false
	}
}

func existingFlowID(flow *store.Flow) int64 {
	if flow == nil {
		return 0
	}
	return flow.ID
}
