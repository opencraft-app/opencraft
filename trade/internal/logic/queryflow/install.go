// Package queryflow 实现 jifei `lightvela.pass.queryFlow` 回调的只读状态查询 handler。
//
// 设计稿引用：.tmp/trade-pass-isolate-design.md
//   - §2.3 入参 / 出参（核心反查键 = trade_flow.id PK；status 五态枚举本期使用 0 / 2 / 3）
//   - §3.4 主流程伪代码
//   - §11 Q5=c：flow_id 找不到 → returnCode=600304；任务永久失败 → status=3
//
// 与 isolateresource handler 的差异：
//   - 只读链路（不写 trade_flow）
//   - 不调 ctl（trade_flow.status 是 source-of-truth，由 ctl→trade callback 推进）
//   - 不需要超时收紧到 4s（PDF queryFlow 同步 3s 即可；本 handler 走 4s 与 isolate 对齐 — 反正只读 DB）
package queryflow

import (
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// Deps 是 queryFlow handler 的依赖集合。
//
// v1.7.x 国际站接入（A6.2）新增：
//   - SiteKind：trade 内部站点语义字面量（"cn" / "intl"），由 main.go 从 cfg.SiteKind 透传；
//     空 / 非法值由 region.Resolve 兜底为 cn。handler 仅用于校验 jifei 入参 para.region
//     是否与本站点期望地域一致（cn=1 / intl=9）。
type Deps struct {
	FlowStore      store.FlowStore         // §3.4 GetByID 反查
	Builder        *jifei.FrameworkBuilder // 构造 jifei framework 双层出参
	SiteKind       string                  // v1.7.x 国际站接入 A6.2：控制 region 校验期望值
	RegionOverride string                  // 北京 2 预发布接入 2026-06-12：region 字段 override（LIGHTVELA_TRADE_REGION env）
}

// Install 把 queryFlow 真 handler 注册到 dispatcher。
func Install(d *jifei.Dispatcher, deps Deps) {
	d.Register(jifei.InterfaceNameQueryFlow, makeHandler(deps))
}
