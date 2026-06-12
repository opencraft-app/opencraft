// Package isolateresource 实现 jifei `lightvela.pass.isolateResource` 回调的异步隔离 handler。
//
// 设计稿引用：.tmp/trade-pass-isolate-design.md
//   - §2.1 入参表（uin / appId / region / resourceId 必填；dealName / productCode / subProductCode 仅日志透传）
//   - §2.2 出参 schema：data.flowId (BIGINT)
//   - §3.3 主流程伪代码（Q19=a 修订版抢占式幂等；Q7=a + Q21=a1 ctl 调用失败 DELETE 回滚）
//   - §11 Q1=a：interfaceName = "lightvela.pass.isolateResource"
//   - §11 Q5=c：永久失败由 queryFlow 透出 status=3，不在本 handler 直接退款
//   - §11 Q14=a：trade_flow.uin 列；§11 Q17=d：uin/appId trade ↔ ctl 全 string
//   - §11 Q19=a 修订版：(resource_id, flow_type, status='in_progress') 强约束 + reconcile 兜底，无 5min 时间窗口
//   - §11 Q22-I-E：trade → ctl 反向调 POST /internal/ctl/passes/{pass_id}/isolate（body 空）
package isolateresource

import (
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// Deps 是 isolateResource handler 的依赖集合，由调用方在 server 装配阶段注入。
//
// 与 createresource.Deps 的差异：
//   - 不需要 OrderStore（isolate 链路与 trade_order 解耦：jifei 调隔离时只关心 pass_id）
//   - 不需要 OrderUpdater（同上）
//   - 不需要 BundleStore（隔离不涉及 bundle 对账）
//   - FlowStore + CTLClient + Builder 三件齐备
//
// v1.7.x 国际站接入（A6.2）新增：
//   - SiteKind：trade 内部站点语义字面量（"cn" / "intl"），由 main.go 从 cfg.SiteKind 透传；
//     空 / 非法值由 region.Resolve 兜底为 cn。handler 仅用于校验 jifei 入参 para.region
//     是否与本站点期望地域一致（cn=1 / intl=9）。
type Deps struct {
	FlowStore      store.FlowStore         // §3.3 抢占式幂等核心（TryAcquireSlotForIsolate / DeleteByID）
	CTLClient      ctlclient.Client        // §3.5 反向调 ctl /internal/ctl/passes/{pass_id}/isolate
	Builder        *jifei.FrameworkBuilder // 构造 jifei framework 双层出参
	SiteKind       string                  // v1.7.x 国际站接入 A6.2：控制 region 校验期望值
	RegionOverride string                  // 北京 2 预发布接入 2026-06-12：region 字段 override（LIGHTVELA_TRADE_REGION env）
}

// Install 把 isolateResource 真 handler 注册到 dispatcher。
//
// 调用方约定：
//  1. 先 jifei.NewDispatcher(...)
//  2. checkcreate.Install / createresource.Install / resourcequery.Install / isolateresource.Install / queryflow.Install
//     各自 Register 各自的 interfaceName，互不干扰
//  3. dispatcher.Register 内部对重复注册 panic — 同一 interfaceName 全仓只允许一处 Install
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameIsolateResource, makeHandler(deps))
}
