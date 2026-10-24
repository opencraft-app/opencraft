import { useEffect, useRef, useState } from "react";
import { CONVERSATION_SCHEDULES as METHODS, nextCalendarRun, nextIntervalRun, validScheduleCalendar, validScheduleWindow, type ScheduleCalendar, type ScheduleWindow } from "@opencraft/appserver-protocol";
import { SettingsButton, SettingsNotice, SettingsPanel, SettingsSelect, SettingsTextInput } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import type { HostScheduleCatalog } from "../runtime/scheduled-task-catalog-context";
import { ModalSurface } from "./modal";
import { useAsyncNotices } from "./async-notices";
import { scheduleCreateMessages as messages } from "./schedule-create-messages";
import "../styles/schedule-create-dialog.scss";
const localDate = (stamp: number) => new Date(stamp - new Date(stamp).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const allDays = [0, 1, 2, 3, 4, 5, 6];
type Options = Awaited<ReturnType<NonNullable<HostScheduleCatalog["creation"]>["options"]>>;
export function ScheduleCreateDialog({ hosts, onClose, returnFocus, onCreated }: {
  hosts: readonly HostScheduleCatalog[]; onClose(): void; returnFocus(): HTMLElement | null;
  onCreated(hostId: string, threadId: string): void;
}) {
  const intl = useIntl(), notices = useAsyncNotices();
  const text = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const available = hosts.filter(host => host.creation && host.port);
  const [scope, setScope] = useState(available[0]?.scope ?? "");
  const host = available.find(h => h.scope === scope);
  const [options, setOptions] = useState<Options | null>(null), [loadError, setLoadError] = useState(false), [reload, setReload] = useState(0);
  const [name, setName] = useState(""), [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState("once"), [period, setPeriod] = useState<ScheduleCalendar["period"]>("daily");
  const [when, setWhen] = useState(() => localDate(Date.now() + 300000));
  const [times, setTimes] = useState(["09:00"]), [weekdays, setWeekdays] = useState([1]), [monthdays, setMonthdays] = useState("1");
  const [amount, setAmount] = useState("1"), [unit, setUnit] = useState("60"), [intervalDays, setIntervalDays] = useState(allDays);
  const [permissions, setPermissions] = useState(""), [skills, setSkills] = useState<string[]>([]);
  const [start, setStart] = useState(""), [end, setEnd] = useState("");
  const [pending, setPending] = useState(false), [invalid, setInvalid] = useState(false), [uncertain, setUncertain] = useState(false);
  const receipt = useRef<{ scope: string; threadId: string } | null>(null);
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = detectedZone && detectedZone !== "Etc/Unknown" ? detectedZone : "UTC";
  useEffect(() => {
    let active = true; setOptions(null); setLoadError(false);
    if (host?.creation) void host.creation.options().then(value => { if (active) setOptions(value); }, () => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [scope, reload, host?.creation === undefined]);
  const calendar: ScheduleCalendar | null = kind === "recurring" ? { period, times, days: period === "weekly" ? weekdays : period === "monthly" ? monthdays.split(/[,，\s]+/).filter(Boolean).map(Number) : [] } : null;
  const window: ScheduleWindow | null = host?.creation?.calendar && kind !== "once" && (start || end || kind === "interval")
    ? { startAt: start ? new Date(start).getTime() : null, endAt: end ? new Date(end).getTime() : null, weekdays: kind === "interval" ? intervalDays : allDays } : null;
  const interval = kind === "interval" ? Number(amount) * Number(unit) : null;
  const anchor = new Date(when).getTime();
  const valid = Boolean(name.trim() && prompt.trim() && (!calendar || validScheduleCalendar(calendar))
    && (kind !== "interval" || interval && Number.isInteger(interval) && interval >= 1 && interval <= 525600 && intervalDays.length)
    && (!window || validScheduleWindow(window)) && (calendar || Number.isFinite(anchor) && anchor > Date.now()));
  const next = valid ? calendar ? nextCalendarRun(calendar, zone, Date.now() + 1000, window)
    : interval ? nextIntervalRun(anchor, interval, zone, anchor, window) : anchor : null;
  const dayPicker = (values: number[], change: (v: number[]) => void) => <fieldset className="schedule-create__days"><legend>{text("days")}</legend>{[1, 2, 3, 4, 5, 6, 0].map(day => <label key={day}><input type="checkbox" checked={values.includes(day)} onChange={() => change(values.includes(day) ? values.filter(d => d !== day) : [...values, day])} />{intl.formatDate(new Date(Date.UTC(2026, 9, 18 + day, 12)), { weekday: "short", timeZone: "UTC" })}</label>)}</fieldset>;
  const submit = async () => {
    if (submitting.current || uncertain || !host?.creation || !host.port) return;
    if (!valid || next === null || !Number.isFinite(next) || next <= Date.now() || next > Date.now() + 5 * 366 * 86400000 || window?.endAt != null && next >= window.endAt) { setInvalid(true); return; }
    submitting.current = true; setPending(true); setInvalid(false);
    const owner = host;
    try {
      if (!receipt.current) {
        try { receipt.current = { scope, threadId: await owner.creation!.createConversation() }; }
        catch { setUncertain(true); throw new Error("Unconfirmed conversation"); }
      }
      if (receipt.current.scope !== scope) throw new Error("Schedule scope changed");
      const threadId = receipt.current.threadId;
      await owner.creation!.nameConversation(threadId, name.trim());
      const current = await owner.port!.request(METHODS.read, { threadId });
      const same = current.schedule;
      if (!same) await owner.port!.request(METHODS.save, { threadId, expectedRevision: 0, prompt: prompt.trim(), permissions: permissions || null,
        nextRunAt: next, intervalMinutes: interval, timeZone: zone, calendar, window, ...(owner.creation?.calendar ? { skills } : {}) });
      else if (same.prompt !== prompt.trim() || JSON.stringify(same.calendar ?? null) !== JSON.stringify(calendar) || same.permissions !== (permissions || null)
        || same.intervalMinutes !== interval || !calendar && same.nextRunAt !== next || JSON.stringify(same.skills ?? []) !== JSON.stringify(skills) || JSON.stringify(same.window ?? null) !== JSON.stringify(window)) throw new Error("Schedule was changed; manage the confirmed conversation");
      if (alive.current) { onCreated(owner.hostId, threadId); onClose(); }
      void owner.retry();
    } catch {
      if (alive.current) notices.error({ key: "schedule-create", message: text(receipt.current ? "error" : "unknown") });
    } finally { submitting.current = false; if (alive.current) setPending(false); }
  };
  return <ModalSurface label={text("title")} size="wide" appearance="utility" onDismiss={() => { if (!submitting.current) onClose(); }} dismissOnOutsidePress={false} showCloseButton={!pending} returnFocus={returnFocus}>
    <SettingsPanel title={text("title")} footer={<div className="schedule-create__actions"><SettingsButton disabled={pending} onClick={onClose}>{text("cancel")}</SettingsButton><SettingsButton type="submit" form="schedule-create" variant="primary" aria-busy={pending} disabled={!host || !options || pending || uncertain}>{text(pending ? "saving" : "create")}</SettingsButton></div>}>
      <form id="schedule-create" className="schedule-create" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <SettingsNotice>{text("hint")}</SettingsNotice>
        <fieldset disabled={pending} className="schedule-create__fields">
          <label>{text("server")}<SettingsSelect aria-label={text("server")} value={scope} disabled={Boolean(receipt.current) || uncertain} onChange={event => { setScope(event.target.value); setSkills([]); setPermissions(""); }}><option value="" disabled>{text("server")}</option>{available.map(h => <option key={h.scope} value={h.scope}>{h.hostLabel}</option>)}</SettingsSelect></label>
          <label>{text("name")}<SettingsTextInput required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
          <fieldset className="schedule-create__frequency"><legend>{text("timing")}</legend>{["once", ...(host?.creation?.calendar ? ["recurring"] : []), "interval"].map(value => <SettingsButton type="button" key={value} aria-pressed={kind === value} variant={kind === value ? "secondary" : "quiet"} onClick={() => setKind(value)}>{text(value as "once" | "recurring" | "interval")}</SettingsButton>)}</fieldset>
          {kind === "once" || kind === "interval" ? <label>{text(kind === "once" ? "date" : "first")}<SettingsTextInput type="datetime-local" required value={when} onChange={event => setWhen(event.target.value)} /></label> : null}
          {kind === "recurring" ? <>
            <label>{text("period")}<SettingsSelect value={period} onChange={event => setPeriod(event.target.value as typeof period)}>{["daily", "weekly", "monthly"].map(value => <option key={value} value={value}>{text(value as typeof period)}</option>)}</SettingsSelect></label>
            {period === "weekly" ? dayPicker(weekdays, setWeekdays) : null}
            {period === "monthly" ? <label>{text("monthdays")}<SettingsTextInput required value={monthdays} onChange={event => setMonthdays(event.target.value)} placeholder="1, 15" /></label> : null}
            <fieldset className="schedule-create__times"><legend>{text("times")}</legend>{times.map((time, index) => <div key={index}><SettingsTextInput type="time" aria-label={`${text("times")} ${index + 1}`} required value={time} onChange={event => setTimes(values => values.map((t, i) => i === index ? event.target.value : t))} />{times.length > 1 ? <SettingsButton type="button" onClick={() => setTimes(values => values.filter((_, i) => i !== index))}>{text("removeTime")}</SettingsButton> : null}</div>)}{period === "daily" ? <SettingsButton type="button" disabled={times.length >= 24} onClick={() => setTimes(values => [...values, "18:00"])}>{text("addTime")}</SettingsButton> : null}</fieldset>
          </> : null}
          {kind === "interval" ? <><div className="schedule-create__row"><label>{text("amount")}<SettingsTextInput type="number" min={1} max={525600} required value={amount} onChange={event => setAmount(event.target.value)} /></label><label>{text("unit")}<SettingsSelect value={unit} onChange={event => setUnit(event.target.value)}><option value="1">{text("minutes")}</option><option value="60">{text("hours")}</option><option value="1440">{text("daysUnit")}</option></SettingsSelect></label></div>{host?.creation?.calendar ? dayPicker(intervalDays, setIntervalDays) : null}</> : null}
          <SettingsNotice>{text("zone")}: {zone}{next && Number.isFinite(next) ? ` · ${intl.formatMessage(messages.next, { time: intl.formatDate(next, { dateStyle: "medium", timeStyle: "short", timeZone: zone }) })}` : ""}</SettingsNotice>
          <label>{text("prompt")}<textarea className="settings-control-input" required rows={4} maxLength={32000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
          <SettingsNotice>{text("delivery")}</SettingsNotice>
          <details><summary className="ui-native-disclosure">{text("advanced")}</summary><div className="schedule-create__fields">
            {!options ? <SettingsNotice>{text(loadError ? "error" : "loading")}{loadError ? <SettingsButton type="button" onClick={() => setReload(value => value + 1)}>{text("retry")}</SettingsButton> : null}</SettingsNotice> : <>
              <label>{text("permissions")}<SettingsSelect value={permissions} onChange={event => setPermissions(event.target.value)}><option value="">{text("default")}</option>{options.permissions.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.allowed}>{profile.openCraftLabel ?? profile.id}</option>)}</SettingsSelect></label>
              {options.permissions.find(p => p.id === permissions)?.openCraftMode === "full" ? <SettingsNotice>{text("fullHint")}</SettingsNotice> : null}
              {host?.creation?.calendar ? <fieldset className="schedule-create__skills"><legend>{text("skills")}</legend>{options.skills.length ? options.skills.map(skill => <label key={skill.name} title={skill.description}><input type="checkbox" checked={skills.includes(skill.name)} disabled={skills.length >= 32 && !skills.includes(skill.name)} onChange={() => setSkills(values => values.includes(skill.name) ? values.filter(s => s !== skill.name) : [...values, skill.name])} />{skill.name}</label>) : <SettingsNotice>{text("noSkills")}</SettingsNotice>}</fieldset> : null}
            </>}
            {host?.creation?.calendar && kind !== "once" ? <fieldset className="schedule-create__fields"><legend>{text("window")}</legend><label>{text("start")}<SettingsTextInput type="datetime-local" value={start} onChange={event => setStart(event.target.value)} /></label><label>{text("end")}<SettingsTextInput type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} /></label></fieldset> : null}
          </div></details>
        </fieldset>
        {invalid || uncertain ? <SettingsNotice role="alert">{text(uncertain ? "unknown" : "invalid")}</SettingsNotice> : null}
      </form>
    </SettingsPanel>
  </ModalSurface>;
}
