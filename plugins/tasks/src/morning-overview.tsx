import { PeopleIcon as Users, PulseIcon as Activity, BoxesIcon as Boxes, SendIcon as Send } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import "./morning-overview.scss";

/** Morning is reserved for risk and exploration disclosure, separate from task follow-up. */
export function MorningOverview() {
  const zh = useIntl().locale.startsWith("zh");
  const text = (cn: string, en: string) => zh ? cn : en;
  const metrics = [
    { label: text("用户规模", "Users"), icon: Users, hint: text("累计用户与新增趋势", "Total users and growth") },
    { label: text("活跃用户", "Active users"), icon: Activity, hint: text("日活与近期活跃趋势", "Daily activity and recent trends") },
    { label: text("库存水位", "Instance inventory"), icon: Boxes, hint: text("可分配实例与地域分布", "Available instances by region") },
    { label: text("投稿水位", "Submission level"), icon: Send, hint: text("统计口径与数据待补充", "Definition and data to be added") },
  ];
  return <section className="tasks-morning" aria-label={text("晨会总览", "Morning overview")}>
    <div className="tasks-morning__intro"><h3>{text("风险与关键探索", "Risks and key explorations")}</h3>
      <p>{text("晨会聚焦需要披露的风险和关键探索事项，具体内容待补充。", "Morning will highlight risks and key explorations. Content is to be added.")}</p>
    </div>
    <section className="tasks-morning__metrics" aria-label={text("产品核心数据", "Core product metrics")}>
      {metrics.map(({ label, icon: Icon, hint }) => <section className="tasks-morning__metric" key={label} aria-label={label}>
        <div><Icon size={18} aria-hidden="true" /><h3>{label}</h3></div>
        <p className="tasks-morning__metric-value">{text("待补充", "To be added")}</p><span>{hint}</span>
      </section>)}
    </section>
  </section>;
}
