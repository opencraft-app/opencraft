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
	OrderStore  store.OrderStore            // 暂保留依赖位（v1.7.28 BUG-07 移除 trade_order 反查后不消费；兼容 server 装配）
	BundleStore store.BundleDefinitionStore // §5.2 #4 Q54 sv_* / pid 5维对账（trade_bundle_definition 真源）
	CTLClient   ctlclient.Client            // §5.2 #2 GetBundleByID + §5.2 #5 ListPassesByUser（v1.7.28 BUG-24 恢复互斥占用反查）
	Builder     *jifei.FrameworkBuilder     // 构造 jifei framework 双层出参
}

// callbackPara 是 jifei `lightvela.pass.checkCreate` 回调的 interface.para 业务字段集。
//
// 与 PDF §2.2 协议字段对齐（v1.7.28 BUG-07 修订 2026-05-21）：
//   - jifei checkCreate **不发 dealName / tranId**（PDF §1.1 明示 "检查时请求参数不包含
//     tranId 或者 dealName，因为订单可能尚未生成"），原 v1.7.x 设计稿"靠 dealName 反查
//     trade_order"路径取消。
//   - jifei 协议层无 bundleId 字段（这是 trade 业务层概念）；trade 出向 generateDeals 时
//     把 bundleId 塞进 goodsDetail 透传（PDF §2.2 "goodsDetail 中字段都是透传"），handler
//     从 GoodsDetail["bundleId"] 取出反查 trade_bundle_definition。
//
// 字段类型说明（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）：
//   - AppID: PDF "long"（int）— 云平台应用 ID；jifei 实测发 number。**v1.7.28 BUG-06
//     同模式修复 (2026-05-21)**：原定义 string，与 PDF 不符且会触发 unmarshal err。
//   - Uin: PDF "string"（quoted）— 资源实际拥有者主账号。
//   - OperateUin: PDF "string"（quoted）— 订单实际操作者。
//   - Region / ZoneID / PayMode: PDF "int"。
//   - SubProductCode / ProductCode: PDF "string"（para 顶层 + goodsDetail 内都有，jifei 重复发）。
//   - GoodsDetail: jifei 协议层完整 goodsDetail map，含 trade 出向时塞的 bundleId 字段。
type callbackPara struct {
	AppID          int64                  `json:"appId"`          // PDF: long (number)
	Uin            string                 `json:"uin"`            // PDF: string (quoted)
	OperateUin     string                 `json:"operateUin"`     // PDF: string (quoted)
	Region         int                    `json:"region"`         // PDF: int
	ZoneID         int                    `json:"zoneId"`         // PDF: int
	PayMode        int                    `json:"payMode"`        // PDF: int (0/1)
	ProductCode    string                 `json:"productCode"`    // PDF: string (optional)
	SubProductCode string                 `json:"subProductCode"` // PDF: string
	ProjectID      int                    `json:"projectId"`      // PDF: long (number, 默认 0)
	GoodsDetail    map[string]interface{} `json:"goodsDetail"`    // PDF: object
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
	// errFramework 是 NewErrorWithData 的本地包装，统一在 data 内塞 PDF §3.4 要求的
	// status 字段（=本次 returnCode）。这样 jifei 前台错误码映射能拿到 trade 业务错码。
	// PDF §3.1：失败时 data.status 必带；§3.4：returnCode 非 0 时 status 错误码也会生效。
	errFramework := func(code int, message string) jifei.Framework {
		return deps.Builder.NewErrorWithData(code, message, map[string]any{"status": code})
	}

	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底（Q59）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 para
		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return errFramework(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return errFramework(ReturnCodeInvalidPara, err.Error()), nil
		}

		// v1.7.28 BUG-07：从 jifei goodsDetail 取 bundleId（trade 出向 placeorder 时塞进去的，
		// PDF §2.2 "goodsDetail 中字段都是透传"，jifei 原样回传）。
		//
		// 协议背景：PDF §1.1 明示 "检查时请求参数不包含 tranId 或者 dealName，因为订单可能尚未生成"，
		// 即 checkCreate 阶段 jifei 不发 dealName，原 §5.2 设计稿"靠 dealName 反查 trade_order"路径
		// 不可行（trade_order 在 generateDeals 同步链路里也还未落库）。改用 goodsDetail 透传 bundleId
		// 让 trade 直接反查 trade_bundle_definition 完成 5 维对账。
		bundleID, ok := goodsDetailStringField(para.GoodsDetail, "bundleId")
		if !ok || bundleID == "" {
			return errFramework(
				ReturnCodeInvalidPara,
				"goodsDetail.bundleId is required (trade out-bound 透传字段; v1.7.28 BUG-07)",
			), nil
		}

		// (2) §5.2 #2 bundle 存在 + 在线 + 未售罄（反向调 ctl/bundle）。
		bundle, err := deps.CTLClient.GetBundleByID(ctx, bundleID)
		if err != nil {
			if errors.Is(err, ctlclient.ErrNotFound) {
				return errFramework(
					ReturnCodeBundleNotFound,
					fmt.Sprintf("bundle not found: bundleId=%s", bundleID),
				), nil
			}
			return errFramework(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("get bundle failed: %v", err),
			), nil
		}
		if bundle.BundleState != "ONLINE" {
			return errFramework(
				ReturnCodeBundleOffline,
				fmt.Sprintf("bundle state=%s (expected ONLINE): bundleId=%s", bundle.BundleState, bundleID),
			), nil
		}
		if bundle.BundleSalesState != "AVAILABLE" {
			return errFramework(
				ReturnCodeBundleSoldOut,
				fmt.Sprintf("bundle sales_state=%s (expected AVAILABLE): bundleId=%s", bundle.BundleSalesState, bundleID),
			), nil
		}

		// (3) §5.2 #4 5 维对账（pid + sv_* + timeSpan + timeUnit + goodsNum）。
		//     pid + sv_* 真源是 trade_bundle_definition；timeSpan / timeUnit / goodsNum 真源
		//     现在没有 trade_order 反查，仅做合法性校验（>0 / 在合法集合内）。
		bundleDef, err := deps.BundleStore.GetBundleDefinitionByID(ctx, bundleID)
		if err != nil {
			if errors.Is(err, store.ErrBundleDefinitionNotFound) {
				return errFramework(
					ReturnCodeBundleNotFound,
					fmt.Sprintf("trade_bundle_definition not found: bundleId=%s", bundleID),
				), nil
			}
			return errFramework(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("get bundle_definition failed: %v", err),
			), nil
		}
		if msg := verifyGoodsDetail(para.GoodsDetail, bundleDef); msg != "" {
			return errFramework(ReturnCodeBusinessParamMismatch, msg), nil
		}

		// (4) §5.2 #3 pay_mode 合法性（0=后付费 / 1=预付费）。
		//     原 §5.2 #3 是"jifei 入参 payMode 与 trade_order 落库 payMode 一致"，但 v1.7.28 BUG-07
		//     时段 trade_order 还未落库（generateDeals 同步链路里 jifei 立即触发 checkCreate），
		//     无法做对账，仅做合法值范围校验。后续若改 placeorder 把 trade_order pre-insert（v2.x），
		//     再恢复对账分支。
		//     payMode 在 jifei 协议层既出现在 para 顶层也出现在 goodsDetail（实测 jifei 两处都发），
		//     优先取 goodsDetail，回退到顶层。
		payMode, payModeOK := goodsDetailIntField(para.GoodsDetail, "payMode")
		if !payModeOK {
			payMode = para.PayMode
			payModeOK = para.PayMode != 0 // 0 后付费, 1 预付费, 0 也合法 — 这里仅检查存在性
		}
		_ = payModeOK // 暂不强制必填，jifei 不一定每次都带
		if payMode != 0 && payMode != 1 {
			return errFramework(
				ReturnCodeBusinessParamMismatch,
				fmt.Sprintf("payMode invalid: expected 0 or 1, got %d", payMode),
			), nil
		}

		// (5) §5.2 #5 quota / 互斥占用（Q66 修订 + Q69 列表非空即互斥）。
		//
		// v1.7.28 BUG-24 修复（2026-05-28）：从 jifei goodsDetail 透传字段 externalUserId 取 user_id。
		//
		// 协议背景：v1.7.28 BUG-22 commit a63ba845 已经验证 trade 出向 placeorder 时把 externalUserId
		// 塞进 goodsDetail（PDF §2.2 "goodsDetail 中字段都是透传"），jifei 在所有同步链路回调里原样回推；
		// 因此 checkCreate handler 直接消费 goodsDetail.externalUserId，**无需** shadow 反查
		// (uin, appId) → externalUserId（这是原 v1.7.28 BUG-07 期间注释里错误的事实判断，被本次修复纠正）。
		//
		// 错误码语义（Q56 严格对齐）：
		//   - 用户已有 pass：返 ReturnCodeQuotaOccupied=600106（B 类业务错码，**非**退款魔法值 352014）；
		//     设计稿 builder.go:18 明确 "checkCreate 不是业务层永久错，**不返** 352014（避免误退款）"。
		//     jifei 拿到非零 returnCode 重试若干次后放弃，相当于"拒绝下单"。
		//   - ctl 5xx / 网络错：返 ReturnCodeUpstreamUnavailable=600107（B 类链路异常）。
		//   - goodsDetail 缺 externalUserId：返 ReturnCodeInvalidPara=600108（trade 出向链路异常，理应必塞）。
		externalUserID, ok := goodsDetailStringField(para.GoodsDetail, "externalUserId")
		if !ok || externalUserID == "" {
			return errFramework(
				ReturnCodeInvalidPara,
				"goodsDetail.externalUserId is required (trade out-bound 透传字段; v1.7.28 BUG-24)",
			), nil
		}
		passes, err := deps.CTLClient.ListPassesByUser(ctx, externalUserID)
		if err != nil {
			return errFramework(
				ReturnCodeUpstreamUnavailable,
				fmt.Sprintf("list passes by user failed: externalUserId=%s, err=%v", externalUserID, err),
			), nil
		}
		if len(passes) > 0 {
			return errFramework(
				ReturnCodeQuotaOccupied,
				fmt.Sprintf("user already holds %d active pass(es): externalUserId=%s",
					len(passes), externalUserID),
			), nil
		}

		// (6) 全部校验通过。
		// data 字段按 PDF §3.1 协议层 checkCreate 出参约定填 `{"status": 0}`
		// (0=可购买；缺失 status 字段 jifei 会判定为协议不合规拒绝下单)。
		return deps.Builder.NewSuccess(map[string]any{"status": 0}), nil
	}
}

// validatePara 做基本必填字段校验；返非 nil 错误时 handler 会用 ReturnCodeInvalidPara 包装。
//
// v1.7.28 BUG-07 修订：删除 dealName / bundleId 顶层必填校验。
//   - dealName: PDF §1.1 明示 checkCreate 阶段 jifei 不发；
//   - bundleId: jifei 协议层无此字段，由 trade 出向时塞进 goodsDetail 透传，handler 内部
//     用 goodsDetailStringField 取，不在顶层。
func validatePara(p *callbackPara) error {
	if p.AppID == 0 {
		return errors.New("appId is required")
	}
	if p.Uin == "" {
		return errors.New("uin is required")
	}
	if p.GoodsDetail == nil {
		return errors.New("goodsDetail is required")
	}
	return nil
}

// verifyGoodsDetail 校验 jifei 回调入参 goodsDetail 与 trade_bundle_definition 一致。
//
// v1.7.28 BUG-07 修订：原 5 维对账（pid + sv_* + timeSpan + timeUnit + goodsNum）的真源
// 拆分原本是 (pid + sv_* → trade_bundle_definition；timeSpan/timeUnit/goodsNum → trade_order)。
// 由于 jifei 在 generateDeals 同步链路里立即触发 checkCreate 回调，trade_order 还未落库，
// 取消 trade_order 对账分支，仅保留：
//   - pid: 与 trade_bundle_definition.Pid 一致（防止 jifei 串号 / 篡改商品配置）
//   - sv_*: 与 trade_bundle_definition.SVList 一致（同上）
//   - timeSpan/timeUnit/goodsNum: 仅做合法范围校验（>0 / 在合法集合内）
//
// 真源拆解：
//   - pid → trade_bundle_definition.Pid（int64，Q71 拍板 2026-05-13）
//   - sv_*（如 sv_lighthouse_lv_compute_xxx）→ trade_bundle_definition.SVList（int64 值，Q71）
//     2026-05-13 起契约变更：运营录入 key **必须**已带 sv_ 前缀；值是 int 直接比较数值，
//     与 jifei 协议层一致（PDF §4.4 line 30/38 "sv_cvm_cpu_s1": 1）。
//
// 任一不一致返非空 message；全部一致返 ""。
func verifyGoodsDetail(goodsDetail map[string]interface{}, def *store.BundleDefinition) string {
	// pid（int64 数值比较）
	pid, ok := goodsDetailInt64Field(goodsDetail, "pid")
	if !ok || pid != def.Pid {
		return fmt.Sprintf("pid mismatch: jifei=%d, bundle_definition=%d", pid, def.Pid)
	}

	// timeSpan: 合法范围校验（>0）
	timeSpan, ok := goodsDetailIntField(goodsDetail, "timeSpan")
	if !ok || timeSpan <= 0 {
		return fmt.Sprintf("timeSpan invalid: expected > 0, got %d", timeSpan)
	}

	// timeUnit: 合法集合校验（y/m/d/h/M/s/p）
	timeUnit, ok := goodsDetailStringField(goodsDetail, "timeUnit")
	if !ok {
		return "timeUnit missing in goodsDetail"
	}
	switch timeUnit {
	case "y", "m", "d", "h", "M", "s", "p":
		// PDF §2.2 timeUnit 合法集合
	default:
		return fmt.Sprintf("timeUnit invalid: expected y/m/d/h/M/s/p, got %q", timeUnit)
	}

	// goodsNum: 合法范围校验（>0）
	goodsNum, ok := goodsDetailIntField(goodsDetail, "goodsNum")
	if !ok || goodsNum <= 0 {
		return fmt.Sprintf("goodsNum invalid: expected > 0, got %d", goodsNum)
	}

	// sv_*：遍历 SVList（int64 值），按 int64 数值比较 jifei 入参 — Q71 推翻 Q66。
	for key, expected := range def.SVList {
		got, ok := goodsDetailInt64Field(goodsDetail, key)
		if !ok || got != expected {
			return fmt.Sprintf("sv field mismatch: jifei[%s]=%d, bundle_definition.sv_list[%s]=%d",
				key, got, key, expected)
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

// goodsDetailInt64Field 从 goodsDetail map 取 int64 字段（用于 pid / sv_* 这种需要保留 BIGINT 精度的字段）。
//
// JSON unmarshal 数字默认走 float64，float64 尾数精度只有 ~52 bit，对于 jifei pid（最多 10 位左右）
// 完全够用；但保留 string / int / int64 兼容性以应对协议层若启用 json.Number 或上游主动传字符串的场景。
//
// Q71 拍板（2026-05-13）：jifei 协议层 pid / sv_* 都是 int（PDF §4.4 / §4.4.1.1.2），
// trade 侧统一用 int64 与 jifei 协议保持一致，verifyGoodsDetail 直接按数值比较，不再 stringify。
func goodsDetailInt64Field(m map[string]interface{}, key string) (int64, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case int:
		return int64(t), true
	case int64:
		return t, true
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}
