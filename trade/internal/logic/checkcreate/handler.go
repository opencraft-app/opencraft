// Package checkcreate 实现 jifei `lightvela.pass.checkCreate` 回调的业务校验 handler。
//
// 设计稿引用：
//   - §5 checkCreate 接口设计
//   - §5.2 校验项五项（Q13 拍板）— 本期落地 4 项（#2 bundle / #3 pay_mode / #4 goods_detail / #5 quota）；
//     #1 signature 按 Q52 拍板"中转服务上线后再补"，本期 trade 不做来源鉴权。
//   - §5.3 幂等（Q62 拍板）— checkCreate 不写 trade_flow，每次独立实时校验。
//   - Q54：goodsDetail 必校 (pid, 询价参数, timeSpan, timeUnit, goodsNum) 与商品配置完全一致。
//   - Q56：错误分类映射（A 类退款 vs B 类业务错），但 checkCreate 阶段订单尚未发货，
//     此处不返退款魔法值 352014（Q56 退款仅 createResource A 类业务永久不可发货时用）；
//     校验失败统一返非零 returnCode 让 jifei 重试。
//   - Q59：3s 同步超时硬约束（trade→ctl 在内 + 自身 SQL 时间预算）。
//   - Q66 修订 + Q69（2026-05-09）：互斥占用 = 列表非空即互斥，不再做 in-service 三元判定。
package checkcreate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode（Q56 协同；区间 6xxxxx 自定义业务错码段，避开协议层 4xxxxx + 退款专用 352014）。
//
// 这些 code 值由 trade 自定义，jifei 收到后按非零 returnCode 行为（重试）处理。
// 命名格式 `BUSINESS_*` 与设计稿 §5.4 错误码表对齐（迭代 5 暂落地必需子集，其余在 §5.4 完整表中）。
const (
	// ReturnCodeOrderNotFound = trade_order 反查无记录（jifei 回传 dealName 与 trade 落库不一致）。
	// 通常意味着 trade pod 重启 / DB 异常 / jifei 串号；属 Q56 B 类（链路异常重试）。
	ReturnCodeOrderNotFound = 600101

	// ReturnCodeBundleNotFound = ctl 反查 bundle 不存在（HTTP 404 / ErrNotFound）。
	ReturnCodeBundleNotFound = 600102

	// ReturnCodeBundleOffline = bundle 存在但已下架（state != ONLINE）。
	ReturnCodeBundleOffline = 600103

	// ReturnCodeBundleSoldOut = bundle 售罄（sales_state != AVAILABLE）。
	ReturnCodeBundleSoldOut = 600104

	// ReturnCodeBusinessParamMismatch = jifei 入参与 trade_order 落库快照不一致。
	// 涵盖 §5.2 #3 pay_mode 不一致 + §5.2 #4 / Q54 goodsDetail 5 维任一不一致。
	ReturnCodeBusinessParamMismatch = 600105

	// ReturnCodeQuotaOccupied = 用户已持有 pass（互斥占用，Q66 修订 + Q69）。
	ReturnCodeQuotaOccupied = 600106

	// ReturnCodeUpstreamUnavailable = ctl / DB 上游基础设施不可用（5xx / 网络错）；
	// 区分于业务级"找不到"以便排障。属 Q56 B 类。
	ReturnCodeUpstreamUnavailable = 600107

	// ReturnCodeInvalidPara = jifei 入参 JSON 解析失败 / 必填字段缺失。
	ReturnCodeInvalidPara = 600108
)

// HandlerTimeout 是 checkCreate handler 的总超时（Q59：5s 同步硬约束 - 1s 网络往返 buffer）。
//
// 实际链路：dispatch → handler → ctlclient (4s 内置超时) + store SQL (本机毫秒级)，
// 这里再加一层 ctx WithTimeout 兜底防御 ctlclient 客户端配置失误（如未设 Timeout）。
const HandlerTimeout = 3 * time.Second

// Deps 是 handler 的依赖集合，由调用方在 server 装配阶段注入。
type Deps struct {
	OrderStore  store.OrderStore             // §5.2 #3/#4 trade_order 反查
	BundleStore store.BundleDefinitionStore  // §5.2 #4 Q54 sv_* / pid 5维对账（trade_bundle_definition 真源）
	CTLClient   ctlclient.Client             // §5.2 #2 GetBundleByID + §5.2 #5 ListPassesByUser
	Builder     *jifei.FrameworkBuilder      // 构造 jifei framework 双层出参
}

// callbackPara 是 jifei `lightvela.pass.checkCreate` 回调的 interface.para 业务字段集。
//
// 与设计稿 §5.1 草案字段集对齐（dealName / appId / uin / subProductCode / bundleId / goodsNum /
// goodsDetail），由 dispatcher 传过来的 para 是 framework 内层的 raw JSON。
//
// 字段类型说明：
//   - GoodsNum / PayMode：jifei 协议层的整数（PDF 第 6 页示例）；payMode 在 PDF 协议层
//     当前未在 checkCreate para 顶层显式列出，从 goodsDetail 取（Q54 含义"询价参数"）。
//   - GoodsDetail：jifei 协议层完整 goodsDetail map，包含 pid / timeSpan / timeUnit / goodsNum / sv_*。
type callbackPara struct {
	DealName       string                 `json:"dealName"`
	AppID          string                 `json:"appId"`
	Uin            string                 `json:"uin"`
	SubProductCode string                 `json:"subProductCode"`
	BundleID       string                 `json:"bundleId"`
	GoodsNum       int                    `json:"goodsNum"`
	GoodsDetail    map[string]interface{} `json:"goodsDetail"`
}

// Install 把 checkCreate 真 handler 注册到 dispatcher，替代 InstallStubHandlers 里的 stub。
//
// 调用方约定：在 server 装配阶段，先调 jifei.NewDispatcher，再调 Install（不再调 InstallStubHandlers
// 里的 checkCreate 那一行）。createResource 在迭代 6 落地之前继续走 stub。
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameCheckCreate, makeHandler(deps))
}

// makeHandler 构造闭包 handler；导出便于单元测试直接构造 handler 而不必走 dispatcher。
func makeHandler(deps Deps) jifei.Handler {
	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底（Q59）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return deps.Builder.NewError(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) §5.2 #3/#4 trade_order 反查（同时为后续两项校验提供数据源）。
		order, err := deps.OrderStore.GetOrderByDealName(ctx, para.DealName)
		if err != nil {
			if errors.Is(err, store.ErrTradeOrderNotFound) {
				return deps.Builder.NewError(
					ReturnCodeOrderNotFound,
					fmt.Sprintf("trade_order not found for dealName=%s", para.DealName),
				), nil
			}
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("get trade_order failed: %v", err),
			), nil
		}

		// (3) §5.2 #2 bundle 存在 + 在线 + 未售罄（反向调 ctl/bundle）。
		bundle, err := deps.CTLClient.GetBundleByID(ctx, para.BundleID)
		if err != nil {
			if errors.Is(err, ctlclient.ErrNotFound) {
				return deps.Builder.NewError(
					ReturnCodeBundleNotFound,
					fmt.Sprintf("bundle not found: bundleId=%s", para.BundleID),
				), nil
			}
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("get bundle failed: %v", err),
			), nil
		}
		if bundle.BundleState != "ONLINE" {
			return deps.Builder.NewError(
				ReturnCodeBundleOffline,
				fmt.Sprintf("bundle state=%s (expected ONLINE): bundleId=%s", bundle.BundleState, para.BundleID),
			), nil
		}
		if bundle.BundleSalesState != "AVAILABLE" {
			return deps.Builder.NewError(
				ReturnCodeBundleSoldOut,
				fmt.Sprintf("bundle sales_state=%s (expected AVAILABLE): bundleId=%s", bundle.BundleSalesState, para.BundleID),
			), nil
		}

		// (4) §5.2 #4 Q54 5 维对账（pid + sv_* + timeSpan + timeUnit + goodsNum）。
		//     pid + sv_* 真源是 trade_bundle_definition；timeSpan / timeUnit / goodsNum 真源是 trade_order。
		bundleDef, err := deps.BundleStore.GetBundleDefinitionByID(ctx, para.BundleID)
		if err != nil {
			if errors.Is(err, store.ErrBundleDefinitionNotFound) {
				return deps.Builder.NewError(
					ReturnCodeBundleNotFound,
					fmt.Sprintf("trade_bundle_definition not found: bundleId=%s", para.BundleID),
				), nil
			}
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("get bundle_definition failed: %v", err),
			), nil
		}
		if msg := verifyGoodsDetail(para.GoodsDetail, bundleDef, order); msg != "" {
			return deps.Builder.NewError(ReturnCodeBusinessParamMismatch, msg), nil
		}

		// (5) §5.2 #3 pay_mode 与 trade_order 落库一致。
		//     payMode 字段在 jifei goodsDetail 中（与询价 / 下单的 payMode 一致约定）。
		payModeFromPara, payModeProvided := goodsDetailIntField(para.GoodsDetail, "payMode")
		// 兼容某些 jifei 版本把 payMode 平铺在 para 顶层（看 PDF 不同页示例不一致），
		// 当 goodsDetail 中没有 payMode 时不要立刻报错 — 可能由 trade_order 的 PayMode 兜底校验，
		// 但严格按 §5.2 #3 字面"jifei 回调入参的 payMode 与 trade_order 落库 payMode 一致"，
		// 找不到入参 payMode 应明确报错（缺字段也算字段不一致）。
		if !payModeProvided {
			return deps.Builder.NewError(
				ReturnCodeBusinessParamMismatch,
				"payMode missing in goodsDetail (required by §5.2 #3)",
			), nil
		}
		if payModeFromPara != order.PayMode {
			return deps.Builder.NewError(
				ReturnCodeBusinessParamMismatch,
				fmt.Sprintf("payMode mismatch: jifei=%d, trade_order=%d", payModeFromPara, order.PayMode),
			), nil
		}

		// (6) §5.2 #5 quota / 互斥占用（Q66 修订 + Q69：列表非空即互斥）。
		//     用 trade_order.ExternalUserID 作为查询主体（与下单时记录一致）。
		passes, err := deps.CTLClient.ListPassesByUser(ctx, order.ExternalUserID)
		if err != nil {
			return deps.Builder.NewError(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("list passes failed: %v", err),
			), nil
		}
		if len(passes) > 0 {
			return deps.Builder.NewError(
				ReturnCodeQuotaOccupied,
				fmt.Sprintf("user already has %d pass(es), mutex blocked", len(passes)),
			), nil
		}

		// (7) 全部校验通过。data 字段按 PDF 协议层 checkCreate 出参约定填空对象（jifei 不取业务字段）。
		return deps.Builder.NewSuccess(map[string]any{}), nil
	}
}

// validatePara 做基本必填字段校验；返非 nil 错误时 handler 会用 ReturnCodeInvalidPara 包装。
func validatePara(p *callbackPara) error {
	if p.DealName == "" {
		return errors.New("dealName is required")
	}
	if p.BundleID == "" {
		return errors.New("bundleId is required")
	}
	if p.GoodsDetail == nil {
		return errors.New("goodsDetail is required")
	}
	if p.GoodsNum <= 0 {
		return errors.New("goodsNum must be > 0")
	}
	return nil
}

// verifyGoodsDetail 实现 Q54 5 维对账：pid + sv_* + timeSpan + timeUnit + goodsNum。
//
// 真源拆解：
//   - pid → trade_bundle_definition.Pid
//   - sv_*（如 sv_cpu / sv_mem）→ trade_bundle_definition.SVList（运营录入 key 不带 sv_ 前缀；
//     对账时按"goodsDetail 中所有 sv_<key> 必须等于 SVList[key] 的字符串值"）
//   - timeSpan / timeUnit / goodsNum → trade_order（下单时落库的快照）
//
// 任一不一致返非空 message；全部一致返 ""。
func verifyGoodsDetail(goodsDetail map[string]interface{}, def *store.BundleDefinition, order *store.TradeOrder) string {
	// pid
	pid, ok := goodsDetailStringField(goodsDetail, "pid")
	if !ok || pid != def.Pid {
		return fmt.Sprintf("pid mismatch: jifei=%q, bundle_definition=%q", pid, def.Pid)
	}

	// timeSpan（Period）
	timeSpan, ok := goodsDetailIntField(goodsDetail, "timeSpan")
	if !ok || timeSpan != order.Period {
		return fmt.Sprintf("timeSpan mismatch: jifei=%d, trade_order.period=%d", timeSpan, order.Period)
	}

	// timeUnit
	timeUnit, ok := goodsDetailStringField(goodsDetail, "timeUnit")
	if !ok || timeUnit != order.TimeUnit {
		return fmt.Sprintf("timeUnit mismatch: jifei=%q, trade_order.time_unit=%q", timeUnit, order.TimeUnit)
	}

	// goodsNum
	goodsNum, ok := goodsDetailIntField(goodsDetail, "goodsNum")
	if !ok || goodsNum != order.GoodsNum {
		return fmt.Sprintf("goodsNum mismatch: jifei=%d, trade_order.goods_num=%d", goodsNum, order.GoodsNum)
	}

	// sv_*：遍历 SVList，每个 key 对应 jifei 入参中的 sv_<key>，值字符串相等。
	for key, expected := range def.SVList {
		jifeiKey := "sv_" + key
		expectedStr := fmt.Sprintf("%v", expected)
		got, ok := goodsDetailStringField(goodsDetail, jifeiKey)
		if !ok || got != expectedStr {
			return fmt.Sprintf("sv field mismatch: jifei[%s]=%q, bundle_definition.sv_list[%s]=%q",
				jifeiKey, got, key, expectedStr)
		}
	}

	return ""
}

// goodsDetailStringField 从 goodsDetail map 取字符串字段；
// 兼容 jifei 把数字 / 布尔回传成 number 的场景（fmt.Sprint 兜底）。
func goodsDetailStringField(m map[string]interface{}, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	switch t := v.(type) {
	case string:
		return t, true
	case float64:
		// JSON number 反序列化成 float64；整数转 string 不带小数
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10), true
		}
		return strconv.FormatFloat(t, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(t), true
	default:
		return fmt.Sprintf("%v", t), true
	}
}

// goodsDetailIntField 从 goodsDetail map 取整数字段；兼容 string / float64。
func goodsDetailIntField(m map[string]interface{}, key string) (int, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case string:
		n, err := strconv.Atoi(t)
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}
