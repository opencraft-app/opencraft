// Package destroyresource 实现 jifei `lightvela.pass.destroyResource` 回调的异步销毁 handler。
//
// 设计稿引用：.tmp/trade-pass-destroy-design.md
//   - §1 链路总览：jifei → trade → ctl → sandbox/snapshot 端到端销毁链路
//   - §2.1 入向字段表（uin / appId / region / resourceId 必填；productCode / subProductCode 仅日志透传，§11 Q26 productCode 反查决议）
//   - §2.2 出向字段表：data.flowId (BIGINT)；ModifyResourceStatus 出向 productCode 由 trade 端运行时反查 BundleDefinition.ProductCode
//   - §3.4 主流程伪代码 D-1 ~ D-7 切片定义
//   - §11 Q26：productCode 取值方案 A（trade 端按 BundleDefinition 反查 ProductCode）
//
// 切片职责（设计稿 §3.4）：
//   - D-1：trade dispatcher 注册 + FlowType 扩枚举 + handler 骨架（抢占 + 返 flowId，不调 ctl）
//   - D-5b（本文件升级）：补 CTLClient.DestroyPass 反向调 + 失败 DeleteByID 回滚 + classifyCTLError
//   - D-2：trade.DeleteResource internal 端点（ctl→trade）+ ctl 端 user-facing /api/v1/passes/{passID}/delete
//
// 与 isolateresource 的差异：
//   - flowType = "destroy_resource"（store.FlowTypeDestroyResource）
//   - 错误码段 60040x（与 isolate 60030x 错开，避免业务方观测时混淆）
//   - D-5b 起 CTLClient 字段对齐（与 isolateresource.Deps 同型）
package destroyresource

import (
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// Deps 是 destroyResource handler 的依赖集合，由调用方在 server 装配阶段注入。
//
// D-5b 切片字段集（与 isolateresource.Deps 同型）：
//   - FlowStore：§3.4 抢占式幂等核心（TryAcquireSlotForIsolate / DeleteByID）
//   - CTLClient：§3.4 反向调 ctl /internal/ctl/passes/{pass_id}/destroy
//   - Builder：构造 jifei framework 双层出参
//   - SiteKind（v1.7.x 国际站接入新增，A6.2）：trade 内部站点语义字面量
//     （"cn" / "intl"），由 main.go 从 cfg.SiteKind 透传；空 / 非法值由 region.Resolve 兜底为 cn。
//     handler 仅用于校验 jifei 入参 para.region 是否与本站点期望地域一致（cn=1 / intl=9），
//     与出向链路 envelope.resInfo.regionId 同源（A6.1 placeorder）。
//
// 与 createresource / isolateresource Deps 差异：
//   - 不需要 OrderStore（销毁链路与 trade_order 解耦）
//   - 不需要 BundleStore（D-5b 阶段不需要；trade.DeleteResource handler 才需要反查 ProductCode，不在本 handler）
type Deps struct {
	FlowStore      store.FlowStore         // §3.4 抢占式幂等核心
	CTLClient      ctlclient.Client        // §3.4 反向调 ctl /internal/ctl/passes/{pass_id}/destroy（D-5b 新加）
	Builder        *jifei.FrameworkBuilder // 构造 jifei framework 双层出参
	SiteKind       string                  // v1.7.x 国际站接入 A6.2：控制 region 校验期望值
	RegionOverride string                  // 北京 2 预发布接入 2026-06-12：region 字段 override（LIGHTVELA_TRADE_REGION env）
}

// Install 把 destroyResource 真 handler 注册到 dispatcher。
//
// 调用方约定：
//  1. 先 jifei.NewDispatcher(...)
//  2. checkcreate.Install / createresource.Install / resourcequery.Install /
//     isolateresource.Install / queryflow.Install / checkrenew.Install /
//     renewresource.Install / destroyresource.Install 各自 Register 各自的 interfaceName
//  3. dispatcher.Register 内部对重复注册 panic — 同一 interfaceName 全仓只允许一处 Install
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameDestroyResource, makeHandler(deps))
}
