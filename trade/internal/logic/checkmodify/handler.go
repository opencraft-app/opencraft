// Package checkmodify 实现 jifei `lightvela.pass.checkModify` 回调的业务校验 handler。
//
// 需求：TAPD 1010132091137784162 §4.1 / §5.2 / §6 / §7.1
//
// 职责边界（与 checkrenew 同范式：无状态、不写 trade_flow、每次实时校验）：
//   - trade 负责计费协议层的自洽：SP / PID / oldConfig / newConfig 与
//     trade_bundle_definition 对账，把 goodsDetail 反解成 (source, target) bundle 对
//   - CTL 负责权益层：pass 归属、状态、套餐升配关系、curDeadline、实例现状
//
// 这条分工线的依据是数据归属：SP/PID/SV 只存在于 trade_bundle_definition，CTL 的
// bundle 表没有这些列；反过来 pass 状态和实例只有 CTL 知道。任何一侧去猜另一侧的
// 事实，就等于在两个服务里各存一份计费真相。
//
// 源 / 目标套餐从哪儿来：checkModify 不带 dealName（与 checkRenew 同），没法反查
// trade_order；而计费只回传协议内字段，goodsDetail 里 trade 自塞的 bundleId /
// newBundleId 会被丢弃（2026-09-02 联调实测）。所以改由协议一等字段
// oldConfig / newConfig 的 SV 集合在同 SP 内反查，详见 resolve.go 顶部说明。
//
// 错误码段 60080x（与 transfer 60070x / renew 60050x 错开）。
package checkmodify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 returnCode。与 checkRenew 一致走 returnCode 通道 + data.status 双写，
// 让计费前台的错误码映射能拿到 trade 业务码。
const (
	// ReturnCodeInvalidPara 参数级问题：JSON 解析失败 / 必填缺失 / payMode ≠ 1 /
	// goodsNum ≠ 1 / goodsDetail 缺 bundleId 或 newBundleId。
	ReturnCodeInvalidPara = 600801

	// ReturnCodeBundleNotFound source 或 target 在 trade_bundle_definition 查不到。
	ReturnCodeBundleNotFound = 600802

	// ReturnCodeConfigMismatch 计费入参与 trade_bundle_definition 对不上：
	// SP 跨产品、PID 不匹配、newConfig 与目标套餐 SV 集合不一致。
	ReturnCodeConfigMismatch = 600803

	// ReturnCodeNotModifiable CTL 判定当前 pass 不可变配（状态、套餐关系、
	// curDeadline 漂移、实例未就绪）。业务永久错，计费不该重试。
	ReturnCodeNotModifiable = 600804

	// ReturnCodeInternalError trade 内部错 / ctl 5xx / 网络超时。基础设施错，计费可重试。
	ReturnCodeInternalError = 600805
)

// 三层超时预算：计费 checkModify 同步硬约束 3s → handler 2s → ctl 子调用 1.2s。
// ctl 侧 check-modify 是纯 DB 读（pass + bundle + 实例列表），1.2s 足够，
// 留出的余量给 trade 自己的 BundleDefinition 反查和序列化。
const (
	HandlerTimeout = 2 * time.Second
	CTLCallTimeout = 1200 * time.Millisecond
)

// Deps 是 handler 的依赖集合。
//
// 比 checkrenew 多一个 BundleStore：变配要把 goodsDetail 里的 SP/PID/newConfig
// 与 trade_bundle_definition 对账，这是 trade 这一侧不可外推的职责。
type Deps struct {
	CTLClient   ctlclient.Client
	BundleStore store.BundleDefinitionStore
	Builder     *jifei.FrameworkBuilder
}

// callbackPara 是 checkModify 回调的 interface.para 字段集。
//
// 与 checkRenew 的差异：不带 timeSpan / timeUnit（变配不改到期时间），
// goodsDetail 多 oldConfig / newConfig 两个对象。
type callbackPara struct {
	Uin        string `json:"uin"`        // PDF: string (quoted)
	OperateUin string `json:"operateUin"` // PDF: string (quoted)
	AppID      int64  `json:"appId"`      // PDF: long (number)
	PayMode    int    `json:"payMode"`    // PDF: int
	ResourceID string `json:"resourceId"` // PDF: string

	// 仅日志透传，不参与等值校验（与 checkRenew 同范式）。
	Region         int    `json:"region"`
	ZoneID         int    `json:"zoneId"`
	ProductCode    string `json:"productCode"`
	SubProductCode string `json:"subProductCode"`

	GoodsDetail map[string]interface{} `json:"goodsDetail"`
}

// Install 把 checkModify 真 handler 注册到 dispatcher。
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameCheckModify, makeHandler(deps))
}

func makeHandler(deps Deps) jifei.Handler {
	errFramework := func(code int, message string) jifei.Framework {
		return deps.Builder.NewErrorWithData(code, message, map[string]any{"status": code})
	}

	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return errFramework(ReturnCodeInvalidPara, fmt.Sprintf("invalid para json: %v", err)), nil
		}
		if err := validatePara(&para); err != nil {
			return errFramework(ReturnCodeInvalidPara, err.Error()), nil
		}

		// trade 侧对账：SP / PID / oldConfig / newConfig ↔ trade_bundle_definition，
		// 同时把两个 config 反解成 (source, target) bundle 对。
		sourceBundleID, targetBundleID, verdict, err := verifyBillingConfig(ctx, deps.BundleStore, &para)
		if err != nil {
			return errFramework(ReturnCodeInternalError,
				fmt.Sprintf("resolve bundle definitions: %v", err)), nil
		}
		if verdict.code != 0 {
			return errFramework(verdict.code, verdict.message), nil
		}

		// CTL 侧校验：pass 状态、套餐升配关系、curDeadline、实例现状。
		curDeadline, msg := parseCurDeadline(para.GoodsDetail)
		if msg != "" {
			return errFramework(ReturnCodeInvalidPara, msg), nil
		}

		ctlCtx, ctlCancel := context.WithTimeout(ctx, CTLCallTimeout)
		defer ctlCancel()

		_, err = deps.CTLClient.CheckPassModify(ctlCtx, para.ResourceID, &ctlclient.CheckPassModifyRequest{
			SourceBundleID: sourceBundleID,
			TargetBundleID: targetBundleID,
			Uin:            parseUinOrZero(para.Uin),
			AppID:          para.AppID,
			ProductCode:    para.ProductCode,
			SubProductCode: para.SubProductCode,
			CurDeadline:    curDeadline,
		})
		if err != nil {
			code, message := classifyCTLError(err, para.ResourceID)
			return errFramework(code, message), nil
		}

		// data.status = 0 是"可变配"的协议信号；缺这个字段计费会判协议不合规。
		return deps.Builder.NewSuccess(map[string]any{"status": 0}), nil
	}
}

// validatePara 做参数级校验。
//
// 不校验 timeSpan / timeUnit：变配不改到期时间，计费在这个动作上也不传时长。
func validatePara(p *callbackPara) error {
	if uin, err := strconv.ParseInt(p.Uin, 10, 64); err != nil || uin <= 0 {
		return errors.New("uin must be a positive int64")
	}
	if p.AppID <= 0 {
		return errors.New("appId is required")
	}
	if p.ResourceID == "" {
		return errors.New("resourceId is required")
	}
	if p.PayMode != 1 {
		return fmt.Errorf("payMode mismatch: expected 1 (prepaid), got %d", p.PayMode)
	}
	if p.GoodsDetail == nil {
		return errors.New("goodsDetail is required")
	}
	if goodsNum, ok := goodsDetailIntField(p.GoodsDetail, "goodsNum"); !ok || goodsNum != 1 {
		return fmt.Errorf("goodsDetail.goodsNum must be 1, got %d (provided=%v)", goodsNum, ok)
	}
	// oldConfig / newConfig 是套餐身份的唯一来源（见 resolve.go）：两者都必须是非空对象，
	// 缺任意一个都无法判定"从哪升到哪"，只能拒。
	//
	// 不校验 bundleId / newBundleId：trade 出向确实塞了这两个字段，但计费不回传自定义键，
	// 曾按"必填"校验导致每笔变配下单固定 600801 → 计费包成 700002（2026-09-02 实测）。
	if oldConfig := jifeiproto.GoodsDetailSVMap(p.GoodsDetail, "oldConfig"); len(oldConfig) == 0 {
		return errors.New("goodsDetail.oldConfig is required and must be a non-empty object")
	}
	if newConfig := jifeiproto.GoodsDetailSVMap(p.GoodsDetail, "newConfig"); len(newConfig) == 0 {
		return errors.New("goodsDetail.newConfig is required and must be a non-empty object")
	}
	return nil
}

type configVerdict struct {
	code    int
	message string
}

// verifyBillingConfig 把 goodsDetail 与 trade_bundle_definition 对账，并反解出
// (sourceBundleID, targetBundleID)。
//
// 反查即对账：oldConfig / newConfig 必须各自**恰好**等于某个在册套餐的 SV 集合，
// 否则直接拒。这一条同时替代了原先"newConfig ≡ 目标套餐 SV 集合"的显式比对——
// 能反查出目标套餐，就已经证明两者相等。它保证"计费准备扣的钱"和"我们准备发的货"
// 描述同一个规格：运营改了 SV 却没同步计费接入单时，这里会 fail-closed，
// 而不是让用户按巡游价拿到启航配置。
//
// 校验项，全部 fail-closed：
//  1. oldConfig / newConfig 各自唯一命中一个在册套餐
//  2. 两者 subProductCode 一致（本期只支持同 SP 变配）
//  3. 源 ≠ 目标（相同意味着 0 元差价，用户付钱却什么都不变）
//  4. goodsDetail.pid（若计费带了）与源套餐 PID 一致
//
// 检索域从哪儿取：用 para 的 productCode + subProductCode（计费视角）。两者缺任一都拒——
// 没有检索域就只能全表反查，会把跨 SP 的套餐纳入候选，违背本期"只做同 SP"的边界。
// 实测计费 checkModify 回调这两个字段都带（2026-09-02），所以要求必填不会误伤真实流量。
func verifyBillingConfig(
	ctx context.Context,
	bundleStore store.BundleDefinitionStore,
	para *callbackPara,
) (string, string, configVerdict, error) {
	if para.SubProductCode == "" || para.ProductCode == "" {
		return "", "", configVerdict{ReturnCodeInvalidPara,
			fmt.Sprintf("productCode and subProductCode are required to resolve bundle definitions, got productCode=%q subProductCode=%q",
				para.ProductCode, para.SubProductCode)}, nil
	}

	oldConfig := jifeiproto.GoodsDetailSVMap(para.GoodsDetail, "oldConfig")
	newConfig := jifeiproto.GoodsDetailSVMap(para.GoodsDetail, "newConfig")

	sourceDef, targetDef, verdict, err := resolveBundlesBySV(
		ctx, bundleStore, para.ProductCode, para.SubProductCode, oldConfig, newConfig)
	if err != nil {
		return "", "", configVerdict{}, err
	}
	if verdict.code != 0 {
		return "", "", verdict, nil
	}

	if sourceDef.BundleID == targetDef.BundleID {
		return "", "", configVerdict{ReturnCodeConfigMismatch,
			fmt.Sprintf("source and target bundle are identical: %q", sourceDef.BundleID)}, nil
	}
	if sourceDef.SubProductCode != targetDef.SubProductCode {
		return "", "", configVerdict{ReturnCodeConfigMismatch,
			fmt.Sprintf("cross sub product modify is not supported: source sp=%q target sp=%q",
				sourceDef.SubProductCode, targetDef.SubProductCode)}, nil
	}
	if pid, ok := goodsDetailIntField(para.GoodsDetail, "pid"); ok && int64(pid) != sourceDef.Pid {
		return "", "", configVerdict{ReturnCodeConfigMismatch,
			fmt.Sprintf("pid mismatch: goodsDetail=%d source bundle definition=%d", pid, sourceDef.Pid)}, nil
	}
	return sourceDef.BundleID, targetDef.BundleID, configVerdict{}, nil
}

// classifyCTLError 把 ctl 错误映射到 returnCode。
//
// 4xx 一律 NotModifiable（业务永久错，计费不该重试），5xx / 网络错走 InternalError。
// 不按 ctl 的具体 code 细分：计费前台只需要"能不能变配"这一个判断，
// 细分只会让 trade 复制一份 CTL 的错误分类表，然后随 CTL 改动漂移。
func classifyCTLError(err error, passID string) (int, string) {
	var ctlErr *ctlclient.Error
	if errors.As(err, &ctlErr) && ctlErr.HTTPStatus >= 400 && ctlErr.HTTPStatus < 500 {
		return ReturnCodeNotModifiable,
			fmt.Sprintf("ctl rejected modify: passId=%s code=%s message=%s",
				passID, ctlErr.Code, ctlErr.Message)
	}
	if errors.Is(err, ctlclient.ErrNotFound) {
		return ReturnCodeNotModifiable, fmt.Sprintf("ctl pass not found: passId=%s", passID)
	}
	return ReturnCodeInternalError, fmt.Sprintf("ctl CheckPassModify: passId=%s err=%v", passID, err)
}

// parseCurDeadline 解析 goodsDetail.curDeadline 为绝对时刻。
//
// 时区必须用 jifeiproto.CurDeadlineLocation（CST）：计费传的是北京时间字面值，
// 用 time.Local 在 UTC 的 pod 里会错 8 小时，把正常请求判成到期时间漂移（BUG-33 同因）。
//
// 预付费协议必带 curDeadline；缺失必须拒绝，避免 CTL 收到 nil 后跳过期限校验。
func parseCurDeadline(goodsDetail map[string]interface{}) (*time.Time, string) {
	raw, ok := goodsDetailStringField(goodsDetail, "curDeadline")
	if !ok || raw == "" {
		return nil, "goodsDetail.curDeadline is required for prepaid modify"
	}
	parsed, err := time.ParseInLocation(jifeiproto.CurDeadlineLayout, raw, jifeiproto.CurDeadlineLocation)
	if err != nil {
		return nil, fmt.Sprintf("goodsDetail.curDeadline invalid format %q (expected %q): %v",
			raw, jifeiproto.CurDeadlineLayout, err)
	}
	return &parsed, ""
}

// parseUinOrZero 只用于 validatePara 已确认合法的正整数 UIN。
// 调用方必须先验证，不能把错误返回值 0 传给 CTL 绕过归属校验。
func parseUinOrZero(uin string) int64 {
	v, err := strconv.ParseInt(uin, 10, 64)
	if err != nil {
		return 0
	}
	return v
}
