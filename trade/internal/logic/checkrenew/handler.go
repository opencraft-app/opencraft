// Package checkrenew 实现 jifei `lightvela.pass.checkRenew` 回调的业务校验 handler。
//
// 设计稿引用（.tmp/trade-pass-renew-design.md）：
//   - §2.3 checkRenew 入参字段集（与 renewResource 相比关键差异：不传 dealName / 不传 retry）
//   - §2.4 checkRenew 出参（data.status 通道：0=可购买 / 非 0=不可购买；returnCode 走协议层错）
//   - §4.5 checkRenew handler 主流程（无状态校验，不写 trade_flow，与 checkCreate 同语义）
//   - §12 Q14=a（5 码归并表）/ Q12=a（timeUnit 严格 ∈ {y,m,d}，本期不支持 'p'）
//   - §2.6 三层超时设定（jifei 3s → handler ≤1s 纯反查）
//
// 与 checkcreate 的对偶关系：
//   - checkcreate 是新购前置校验，反查 trade_order + bundle + 互斥占用
//   - checkrenew 是续费前置校验，反查 ctl.pass（pass 已存在，互斥语义已天然满足）
//   - 共同点：都不写 trade_flow，每次独立实时校验；任一失败返非零业务码 status，jifei 不进入下一阶段
//
// 错误码段（与 isolate 600301~600304 / checkcreate 60010x / createresource 60020x 错开）：
//   - 600401 InvalidPara          — Q14=a + Q12=a：参数级问题（payMode / timeUnit / goodsNum / period 等）
//   - 600402 PassNotFound         — Q14=a：resourceId(=passId) 在 ctl.pass 表查不到
//   - 600403 PassNotRenewable     — Q14=a：pass 不归属当前 uin / status ∉ {active, isolated} / 已删除
//   - 600404 CurDeadlineMismatch  — Q14=a：goodsDetail.curDeadline ≠ ctl.pass.expired_time
//   - 600406 InternalError        — Q14=a：ctl 调用超时 / 5xx 系统错误（Q14 表中 InternalError 一档）
//
// 注：600405 在 §4.5 草案中预留 PassPayModeMismatch / PassUinMismatch 细分。
// **本期落地策略**：v3.8 §12 Q14=a 5 码归并 — payMode/uin 异常归并到 InvalidPara/PassNotRenewable
// 已有码段，不单开 600405。计费前端配置文档 ID 237110816 对齐时如需细分，再补 600405。
package checkrenew

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
)

// 业务层 returnCode（Q14=a 5 码归并表，区间 60040x 与既有段错开）。
//
// jifei 在 checkRenew 阶段的返回语义（PDF §3.2 + 设计稿 §2.4）：
//   - returnCode == 0 表示协议层无报错；data.status 通道承载业务校验结果（0=可购 / 非 0=不可购）
//   - returnCode != 0 表示协议层错误（如 trade 内部异常 / 三段式不合法等）
//
// 落地决策（§2.4 ✅ Q14=a）：本 handler 全部错误统一走 returnCode 通道（returnCode = 60040x），
// 设计稿 ✅ Q14=a 落地约束 ③ "checkRenew 走 data.status 通道，不走 returnCode" 是一种**未来对齐**
// 状态 — 在计费前端配置文档 ID 237110816 status 值落地之前，我们用 returnCode 通道兼容现有
// FrameworkBuilder 范式（与 checkCreate / isolateResource 一致），R-pre 阶段对齐时再切换。
const (
	// ReturnCodeInvalidPara = Q14=a InvalidPara：jifei 入参 JSON 解析失败 / 必填字段缺失 /
	// payMode != 1 / goodsNum > 1 / timeSpan <= 0 / timeUnit ∉ {y,m,d}（Q12=a 严格白名单）。
	ReturnCodeInvalidPara = 600401

	// ReturnCodePassNotFound = Q14=a PassNotFound：resourceId(=passId) 在 ctl.pass 表查不到。
	// 触发场景：pass 已被删除 / pass_id 串号 / appId 不匹配（ctl.ListPassesByResourceIDs 按 (appID, [passID]) 反查）。
	ReturnCodePassNotFound = 600402

	// ReturnCodePassNotRenewable = Q14=a PassNotRenewable：pass 存在但不可续费。
	// 触发场景：
	//   - pass.uin != para.uin（拥有关系不匹配 — Q14=a 收敛 PassUinMismatch 到此码）
	//   - pass.status ∉ {active, isolated}（renewing / isolating 中已有续费链路占用）
	//   - pass.deleted_time != NULL（已删除）
	ReturnCodePassNotRenewable = 600403

	// ReturnCodeCurDeadlineMismatch = Q14=a CurDeadlineMismatch：goodsDetail.curDeadline 不等于
	// ctl.pass.expired_time（YYYY-MM-DD HH:MM:SS 严格对比）。
	// 这是 jifei 防"用户续费表单陈旧 / 计费侧缓存"的强约束（PDF §2.2）。
	ReturnCodeCurDeadlineMismatch = 600404

	// ReturnCodeInternalError = Q14=a InternalError：trade 内部错 / ctl 调用 5xx / 网络超时。
	// 与 isolate 600304 / checkcreate 600107 同语义但码段独立。
	ReturnCodeInternalError = 600406
)

// HandlerTimeout 是 checkRenew handler 的总超时（设计稿 §2.6 + §4.5）。
//
// 内部预算：
//   - jifei → trade 同步硬约束 3s（PDF §1.2）
//   - handler 总预算 2s（与 checkCreate 同型；纯反查 + 校验，无 task / 无写库）
//   - trade → ctl ListPassesByResourceIDs 子上下文 1.5s（与 isolate / resourcequery 一致）
const HandlerTimeout = 2 * time.Second

// CTLCallTimeout 是反查 ctl pass 的子上下文超时（与 isolate / resourcequery 同型）。
const CTLCallTimeout = 1500 * time.Millisecond

// pass 合法续费状态集合（§4.5 校验项 b：pass.status ∉ {active, isolated} → PassNotRenewable）。
var renewableStatuses = map[string]struct{}{
	"active":   {},
	"isolated": {},
}

// Deps 是 handler 的依赖集合，由调用方在 server 装配阶段注入。
//
// checkRenew 是无状态校验，不需要 OrderStore / FlowStore / BundleStore — 仅需 ctlclient + Builder。
// 这与 checkcreate.Deps（4 个依赖）形成对比：
//   - checkcreate 必须反查 trade_order（拿 BundleID/Period/PayMode 做 5 维校验）+ trade_bundle_definition（pid/sv_*）
//   - checkrenew 完全靠 jifei 入参 + ctl.pass 自校验 — pass 实体已是真源（pid/sv_* 等无须校验，已在新购阶段固化）
type Deps struct {
	CTLClient ctlclient.Client        // §4.5 校验项 b：反查 ctl.pass(pass_id, app_id)
	Builder   *jifei.FrameworkBuilder // 构造 jifei framework 双层出参
}

// callbackPara 是 jifei `lightvela.pass.checkRenew` 回调的 interface.para 业务字段集（设计稿 §2.3）。
//
// 字段保真度（与 PDF 续费检查接口 §2.2 入参表对齐）：
//   - 必填：Uin / AppID / PayMode / ResourceID
//   - 日志透传不消费：OperateUin / Region / ZoneID / ProductCode / SubProductCode
//     （与 isolateResource 同语义，pass 实体不持有 region/zone）
//   - GoodsDetail 子字段：必带 timeSpan / timeUnit / curDeadline / goodsNum
//
// jifei 入参 appId / payMode 都是 int 类型；其它都是 string。
type callbackPara struct {
	// 必填字段（每个字段都标注 PDF 协议类型，铁律见 jifei/envelope.go 包注释）
	Uin        string `json:"uin"`        // PDF: string (quoted)
	OperateUin string `json:"operateUin"` // PDF: string (quoted)
	AppID      int64  `json:"appId"`      // PDF: long (number)
	PayMode    int    `json:"payMode"`    // PDF: int
	ResourceID string `json:"resourceId"` // PDF: string

	// 仅日志透传（不参与等值校验，与 isolateResource 同范式）
	Region         int    `json:"region"`         // PDF: int
	ZoneID         int    `json:"zoneId"`         // PDF: int
	ProductCode    string `json:"productCode"`    // PDF: string
	SubProductCode string `json:"subProductCode"` // PDF: string

	// GoodsDetail 子字段集合（§2.3 表，必带 timeSpan/timeUnit/curDeadline/goodsNum；
	// 其余 autoRenewFlag/pid/sv_xxx 仅日志透传，本期 pass 实体不持有 pid/sv_*，不做校验）
	GoodsDetail map[string]interface{} `json:"goodsDetail"`
}

// Install 把 checkRenew 真 handler 注册到 dispatcher。
//
// 调用方约定（与 checkcreate / isolateresource 同范式）：
// server 装配阶段先调 jifei.NewDispatcher，再调 checkrenew.Install 注册真 handler。
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameCheckRenew, makeHandler(deps))
}

// makeHandler 构造闭包 handler；导出便于单元测试直接构造而无需走 dispatcher（与 checkcreate 同范式）。
func makeHandler(deps Deps) jifei.Handler {
	// errFramework 是 NewErrorWithData 的本地包装，统一在 data 内塞 PDF §3.4 要求的
	// status 字段（=本次 returnCode）。这样 jifei 前台错误码映射能拿到 trade 业务错码。
	// PDF §3.1：失败时 data.status 必带；§3.4：returnCode 非 0 时 status 错误码也会生效。
	errFramework := func(code int, message string) jifei.Framework {
		return deps.Builder.NewErrorWithData(code, message, map[string]any{"status": code})
	}

	return func(ctx context.Context, paraRaw json.RawMessage) (jifei.Framework, error) {
		// (0) 总超时兜底（§2.6 + §4.5）。
		ctx, cancel := context.WithTimeout(ctx, HandlerTimeout)
		defer cancel()

		// (1) 解码 + 必填字段校验
		var para callbackPara
		if err := json.Unmarshal(paraRaw, &para); err != nil {
			return errFramework(
				ReturnCodeInvalidPara,
				fmt.Sprintf("invalid para json: %v", err),
			), nil
		}
		if err := validatePara(&para); err != nil {
			return errFramework(ReturnCodeInvalidPara, err.Error()), nil
		}

		// (2) 反查 ctl.pass — 用 ListPassesByResourceIDs(appID, [passID]) 单元素列表反查
		// （ctlclient 当前没有 GetPass 单查 API；ListPassesByResourceIDs 是按 (app_id, pass_ids) 集合
		//  反查，单元素列表语义等价于"按 pass_id 单查"，与 §4.5 校验项 b 兼容）。
		ctlCtx, ctlCancel := context.WithTimeout(ctx, CTLCallTimeout)
		defer ctlCancel()

		passes, err := deps.CTLClient.ListPassesByResourceIDs(ctlCtx, para.AppID, []string{para.ResourceID})
		if err != nil {
			// ctlclient.ErrNotFound 在 ListPassesByResourceIDs 路径上几乎不会触发
			// （ctl 行为：不存在 pass 不返回 404 而是返空列表 — PDF §1.2 约束），
			// 但保留兼容（rare：ctl 路由配置异常时）走 PassNotFound。
			if errors.Is(err, ctlclient.ErrNotFound) {
				return errFramework(
					ReturnCodePassNotFound,
					fmt.Sprintf("ctl pass not found: passId=%s appId=%d", para.ResourceID, para.AppID),
				), nil
			}
			// 其他错（5xx / 401 / 网络）→ InternalError 让 jifei 重试
			return errFramework(
				ReturnCodeInternalError,
				fmt.Sprintf("ctl ListPassesByResourceIDs: %v", err),
			), nil
		}

		// PDF §1.2：不存在的 / 已销毁的 pass 不返回（数组减少元素，不报错）。
		// 这里入参就一个 passID，返回空数组即"该 pass 在 ctl 视角不存在"。
		if len(passes) == 0 {
			return errFramework(
				ReturnCodePassNotFound,
				fmt.Sprintf("ctl pass not found in resource list: passId=%s appId=%d",
					para.ResourceID, para.AppID),
			), nil
		}
		pass := passes[0]

		// (3) §4.5 校验项 b：pass 归属 + 状态 + 删除标记
		if msg := verifyPassRenewable(pass, &para); msg != "" {
			return errFramework(ReturnCodePassNotRenewable, msg), nil
		}

		// (4) §4.5 校验项 c：goodsDetail.curDeadline ≡ ctl.pass.expired_time（YYYY-MM-DD HH:MM:SS 严格对比）
		if msg := verifyCurDeadline(para.GoodsDetail, pass.ExpiredTime); msg != "" {
			return errFramework(ReturnCodeCurDeadlineMismatch, msg), nil
		}

		// (5) 全部校验通过。
		// data 字段按 PDF §3.1 checkRenew 出参约定填 `{"status": 0}`
		// (0=可购买；缺失 status 字段 jifei 会判定为协议不合规拒绝下单)。
		return deps.Builder.NewSuccess(map[string]any{"status": 0}), nil
	}
}

// validatePara 做参数级校验（Q14=a InvalidPara 落点 + Q12=a timeUnit 严格白名单）。
//
// 校验项（与 §4.5 校验项 a/d/e 对齐）：
//   - uin / resourceId / appId 必填非空 / payMode == 1
//   - goodsDetail 必填 + timeSpan > 0 + timeUnit ∈ {y, m, d}（Q12=a 严格白名单，本期不支持 'p'）
//   - goodsNum == 1（本期不支持批量续费 — §4.5 校验项 e）
func validatePara(p *callbackPara) error {
	if p.Uin == "" {
		return errors.New("uin is required")
	}
	if p.AppID <= 0 {
		return errors.New("appId is required")
	}
	if p.ResourceID == "" {
		return errors.New("resourceId is required")
	}
	// §4.5 校验项 a：payMode == 1（预付费）
	if p.PayMode != 1 {
		return fmt.Errorf("payMode mismatch: expected 1 (prepaid), got %d", p.PayMode)
	}
	if p.GoodsDetail == nil {
		return errors.New("goodsDetail is required")
	}

	// §4.5 校验项 d：timeSpan > 0 && timeUnit ∈ {y, m, d}
	timeSpan, ok := goodsDetailIntField(p.GoodsDetail, "timeSpan")
	if !ok || timeSpan <= 0 {
		return fmt.Errorf("goodsDetail.timeSpan must be > 0, got %d (provided=%v)", timeSpan, ok)
	}
	timeUnit, ok := goodsDetailStringField(p.GoodsDetail, "timeUnit")
	if !ok {
		return errors.New("goodsDetail.timeUnit is required")
	}
	// Q12=a 严格白名单：{y, m, d}（双层校验：trade renewResource + checkRenew，本处是 checkRenew 层）
	switch timeUnit {
	case "y", "m", "d":
	default:
		return fmt.Errorf("goodsDetail.timeUnit ∉ {y,m,d}: got %q (Q12=a strict whitelist)", timeUnit)
	}

	// §4.5 校验项 e：goodsNum == 1（本期不支持批量续费）
	goodsNum, ok := goodsDetailIntField(p.GoodsDetail, "goodsNum")
	if !ok || goodsNum != 1 {
		return fmt.Errorf("goodsDetail.goodsNum must be 1, got %d (provided=%v)", goodsNum, ok)
	}

	return nil
}

// verifyPassRenewable 实现 §4.5 校验项 b：pass 归属 + 状态 + 删除标记。
//
// 真源拆解：
//   - pass.Uin（int64）vs para.Uin（string）：统一转 int64 再比较，与 jifei 协议层 uin 类型对齐；
//     转换失败说明 jifei 入参 uin 非法数字 — 但 validatePara 阶段未做数字校验（与 isolate 同范式
//     uin 是 string 透传），此处转换失败按 PassNotRenewable 归并（拥有关系不匹配的一种）。
//   - pass.DeletedTime（*time.Time）：非 nil 即"已删除" → PassNotRenewable
//   - pass.IsolatedTime：通过 pass status 间接体现（active=未隔离 / isolated=已隔离），不直接消费
//
// 注：ctlclient.PassDetail 当前不暴露 status 字段（参见 §11 jifei.go ctl 同步出参精简），
// **本期需要 ctl 侧补出 status 字段**或我们用 IsolatedTime/DeletedTime 间接推导：
//   - DeletedTime != nil          → status = deleted
//   - IsolatedTime != nil 且 ≠零值 → status = isolated（合法续费）
//   - IsolatedTime == nil         → status = active（合法续费）
//
// 间接推导的盲区：renewing / isolating 中间态在反查侧看不到（active 视角无法区分），
// **理论上**这两态对应的 pass 不会出现在 isolated/active 视图，jifei 入口本期通过本 handler 的
// "并发同 pass 续费已有 trade_flow 占用" 兜底（renewResource 抢占式幂等会拒第二笔）。
//
// 决策：本期接受这个间接推导 — checkRenew 是无状态前置校验，renewResource 才是真正的关键路径。
// 如未来需要严格区分 renewing/isolating，再让 ctl 在 PassResponse 里补 status 字段。
func verifyPassRenewable(pass *ctlclient.PassDetail, para *callbackPara) string {
	if pass == nil {
		return "pass is nil (defensive guard)"
	}

	// (b1) DeletedTime 非 nil → 已删除
	if pass.DeletedTime != nil {
		return fmt.Sprintf("pass deleted: passId=%s deleted_time=%s",
			pass.PassID, pass.DeletedTime.Format(time.RFC3339))
	}

	// (b2) Uin 拥有关系
	paraUin, err := strconv.ParseInt(para.Uin, 10, 64)
	if err != nil {
		return fmt.Sprintf("invalid para.uin (not a int64): %q err=%v", para.Uin, err)
	}
	if pass.Uin != paraUin {
		return fmt.Sprintf("uin mismatch: pass.uin=%d, para.uin=%d", pass.Uin, paraUin)
	}

	// (b3) AppID 拥有关系（与 uin 双层校验，jifei 入参 appId 必须与 ctl pass 落库一致）
	if pass.AppID != para.AppID {
		return fmt.Sprintf("appId mismatch: pass.app_id=%d, para.appId=%d", pass.AppID, para.AppID)
	}

	// (b4) status ∈ {active, isolated} —— 通过 IsolatedTime 间接推导
	derivedStatus := "active"
	if pass.IsolatedTime != nil && !pass.IsolatedTime.IsZero() {
		derivedStatus = "isolated"
	}
	if _, ok := renewableStatuses[derivedStatus]; !ok {
		return fmt.Sprintf("pass status not renewable: derived=%q (expected ∈ {active, isolated})", derivedStatus)
	}

	return ""
}

// verifyCurDeadline 实现 §4.5 校验项 c：goodsDetail.curDeadline 严格 == ctl.pass.expired_time。
//
// 比较语义：
//   - jifei goodsDetail.curDeadline 是 string，按 layout "2006-01-02 15:04:05" 解析
//   - ctl pass.ExpiredTime 是 time.Time（RFC3339 / DB DATETIME → Go time.Time）
//   - 用 time.Time.Equal 比较绝对时刻（与 == 不同，Equal 跨 location 也安全）
//
// 解析失败也归到本码（CurDeadlineMismatch）— 字面"curDeadline 不一致"覆盖"格式不一致"语义。
func verifyCurDeadline(goodsDetail map[string]interface{}, expiredTime time.Time) string {
	curDeadlineStr, ok := goodsDetailStringField(goodsDetail, "curDeadline")
	if !ok || curDeadlineStr == "" {
		return "goodsDetail.curDeadline is required"
	}

	// 按 PDF §2.2 layout 解析；location 必须用 jifeiproto.CurDeadlineLocation（北京时间 UTC+8），
	// 与 trade 输出端 resourcequery/mapper.go 把 expireTime 字段格式化为北京时间字面值的契约对齐
	// （BUG-33 修复：之前用 time.Local 在 trade pod 跑 UTC 时会与输出端 CST 错位 8h）。
	curDeadline, err := time.ParseInLocation(jifeiproto.CurDeadlineLayout, curDeadlineStr, jifeiproto.CurDeadlineLocation)
	if err != nil {
		return fmt.Sprintf("goodsDetail.curDeadline invalid format %q (expected %q): %v",
			curDeadlineStr, jifeiproto.CurDeadlineLayout, err)
	}

	if !curDeadline.Equal(expiredTime) {
		// 错误信息里把 ctl.pass.expired_time 也按北京时间展示，便于排障对比
		// （否则展示成 UTC 字面值，会误导读者以为 trade 拿到的是 UTC 字符串）。
		return fmt.Sprintf("curDeadline mismatch: jifei=%q, ctl.pass.expired_time=%q",
			curDeadlineStr, jifeiproto.FormatCurDeadline(expiredTime))
	}

	return ""
}

// goodsDetailStringField 从 goodsDetail map 取字符串字段；与 checkcreate 同型实现，避免循环依赖。
//
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

// goodsDetailIntField 从 goodsDetail map 取整数字段；与 checkcreate 同型实现，避免循环依赖。
//
// 兼容 string / float64 — JSON unmarshal 数字默认走 float64。
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
