import { useEffect, useState } from "react";
import { Button, Dialog, Input, Label, ListGroup, RadioGroup, Spinner, TextArea, TextField } from "heroui-native";
import { ArrowLeft, ChevronRight, Clock3, Plus, RefreshCw } from "lucide-react-native";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AutomationDraft, AutomationJob } from "@opencraft/mobile-bot-bridge";
import type { AutomationAction, AutomationView } from "./use-mobile-automations";
import { buildMobileSchedule, initialMobileSchedule, localDateTomorrow, type MobileScheduleDraft } from "../runtime/mobile-automation-schedule";
import { mobileVisualTokens as tokens } from "../runtime/mobile-visual-tokens";

type Editor = { mode: "create" | "edit"; job: AutomationJob | null };

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: tokens.color.contentCanvas },
  scroll: { flex: 1, minHeight: 0 },
  body: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 32, gap: 16, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  heading: { flex: 1, minWidth: 0, fontSize: 24, lineHeight: 32, color: tokens.color.text, fontWeight: "700" },
  subtitle: { color: tokens.color.label, fontSize: 14, lineHeight: 21 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: tokens.color.text },
  card: { backgroundColor: tokens.color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.color.separator, borderRadius: 18, padding: 16, gap: 12 },
  row: { minHeight: 76, paddingVertical: 11, paddingHorizontal: 12 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: tokens.color.text },
  rowDescription: { fontSize: 12, lineHeight: 18, color: tokens.color.label, marginTop: 4 },
  status: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  info: { color: tokens.color.rowText, fontSize: 14, lineHeight: 21 },
  hint: { color: tokens.color.label, fontSize: 13, lineHeight: 20 },
  error: { color: tokens.color.statusFailed, fontSize: 13, lineHeight: 20 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  action: { minHeight: 44 },
  iconAction: { width: 44, height: 44, minWidth: 44 },
  field: { gap: 6 },
  modes: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
  dialog: { width: "100%", maxWidth: 420, padding: 20, gap: 14 },
});

function dateLabel(value: string | null, zh: boolean): string {
  if (!value) return zh ? "尚未安排" : "Not scheduled";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(zh ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : value;
}

function statusLabel(job: AutomationJob, zh: boolean): string {
  if (job.executionStatus === "running") return zh ? "正在执行" : "Running";
  if (!job.enabled || job.state.toLowerCase() === "paused") return zh ? "已暂停" : "Paused";
  if (["failed", "error"].includes(job.state.toLowerCase())) return zh ? "需要处理" : "Needs attention";
  return zh ? "运行中" : "Active";
}

function ScheduleFields({ value, onChange, zh }: {
  value: MobileScheduleDraft;
  onChange(value: MobileScheduleDraft): void;
  zh: boolean;
}) {
  const modes = ["daily", "interval", "once"] as const;
  return <View style={styles.field}>
    <Label>{zh ? "执行时间" : "When to run"}</Label>
    {value.mode === "keep" ? <Text style={styles.info}>{value.label}</Text> : null}
    <RadioGroup style={styles.modes} value={value.mode === "keep" ? undefined : value.mode}
      onValueChange={next => {
        const mode = next as "daily" | "interval" | "once";
        onChange(mode === "daily" ? { mode, time: "09:00" }
          : mode === "interval" ? { mode, count: "1", unit: "d" }
            : { mode, date: localDateTomorrow(), time: "09:00" });
      }}>
      {modes.map(mode => <RadioGroup.Item key={mode} value={mode} style={{ minHeight: 44 }}>
        {mode === "daily" ? zh ? "每天" : "Daily" : mode === "interval" ? zh ? "每隔" : "Every" : zh ? "单次" : "Once"}
      </RadioGroup.Item>)}
    </RadioGroup>
    {value.mode === "daily" ? <TextField><Label>{zh ? "时间（24 小时）" : "Time (24 hour)"}</Label>
      <Input value={value.time} onChangeText={time => onChange({ mode: "daily", time })} placeholder="09:00" keyboardType="numbers-and-punctuation" />
    </TextField> : null}
    {value.mode === "interval" ? <View style={styles.actions}>
      <View style={{ flex: 1, minWidth: 110 }}><TextField><Label>{zh ? "间隔" : "Interval"}</Label>
        <Input value={value.count} onChangeText={count => onChange({ ...value, count })} keyboardType="number-pad" /></TextField></View>
      <RadioGroup style={styles.modes} value={value.unit} onValueChange={unit => onChange({ ...value, unit: unit as "h" | "d" })}>
        <RadioGroup.Item value="h" style={{ minHeight: 44 }}>{zh ? "小时" : "Hours"}</RadioGroup.Item>
        <RadioGroup.Item value="d" style={{ minHeight: 44 }}>{zh ? "天" : "Days"}</RadioGroup.Item>
      </RadioGroup>
    </View> : null}
    {value.mode === "once" ? <View style={styles.actions}>
      <View style={{ flex: 1, minWidth: 150 }}><TextField><Label>{zh ? "日期" : "Date"}</Label>
        <Input value={value.date} onChangeText={date => onChange({ ...value, date })} placeholder="2026-10-10" /></TextField></View>
      <View style={{ flex: 1, minWidth: 100 }}><TextField><Label>{zh ? "时间" : "Time"}</Label>
        <Input value={value.time} onChangeText={time => onChange({ ...value, time })} placeholder="09:00" keyboardType="numbers-and-punctuation" /></TextField></View>
    </View> : null}
  </View>;
}

/** Native visual surface. The packaged controller remains the command authority. */
export function MobileAutomations({ botId, zh, view, run }: {
  botId: string;
  zh: boolean;
  view: AutomationView;
  run(action: AutomationAction, payload?: { jobId?: string; draft?: AutomationDraft; dependentIds?: string[] }): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<MobileScheduleDraft>(() => initialMobileSchedule());
  const [deliver, setDeliver] = useState("local");
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  useEffect(() => { setSelectedId(null); setEditor(null); setDeleteId(null); setSubmittedAt(null); }, [botId]);
  useEffect(() => {
    if (submittedAt !== null && view.completed > submittedAt && !view.pending && !view.error
      && (view.lastCompletedAction === "create" || view.lastCompletedAction === "edit")) {
      setEditor(null); setSelectedId(null); setSubmittedAt(null);
    }
  }, [submittedAt, view.completed, view.pending, view.error, view.lastCompletedAction]);
  const selected = view.jobs.find(job => job.id === selectedId) ?? null;
  const deleting = view.jobs.find(job => job.id === deleteId) ?? null;
  const busy = view.pending !== null;
  const openEditor = (job: AutomationJob | null) => {
    setEditor({ mode: job ? "edit" : "create", job });
    setName(job?.name ?? ""); setPrompt(job?.prompt ?? "");
    setSchedule(initialMobileSchedule(job?.schedule, job?.scheduleDisplay));
    setDeliver(job?.deliver ?? "local");
    setSubmittedAt(null);
  };
  const planned = buildMobileSchedule(schedule);
  const canSave = name.trim().length > 0 && name.trim().length <= 60 && prompt.trim().length > 0
    && prompt.trim().length <= 1000 && planned !== null && !busy;
  const save = () => {
    if (!canSave || !planned) return;
    const draft: AutomationDraft = { name: name.trim(), prompt: prompt.trim(), schedule: planned, deliver };
    setSubmittedAt(view.completed);
    if (editor?.mode === "edit" && editor.job) run("edit", { jobId: editor.job.id, draft });
    else run("create", { draft });
  };
  const title = editor ? editor.mode === "create" ? zh ? "新建定时任务" : "New automation" : zh ? "编辑定时任务" : "Edit automation"
    : selected ? selected.name : zh ? "定时任务" : "Automations";
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
      <View style={styles.header}>
        {editor || selected ? <Button variant="ghost" isIconOnly style={styles.iconAction} accessibilityLabel={zh ? "返回任务列表" : "Back to automations"}
          onPress={() => { if (editor) setEditor(null); else setSelectedId(null); }}><ArrowLeft size={20} color={tokens.color.icon} /></Button> : null}
        <Text numberOfLines={2} style={styles.heading}>{title}</Text>
        {!editor && !selected ? <Button variant="primary" isIconOnly style={styles.iconAction} accessibilityLabel={zh ? "新建智能体任务" : "New agent automation"}
          onPress={() => openEditor(null)}><Plus size={20} color="white" /></Button> : null}
      </View>
      {view.error ? <View style={styles.card}><Text accessibilityRole="alert" style={styles.error}>{view.error}</Text>
        <Button variant="secondary" size="sm" onPress={() => run("list")}>{zh ? "重试" : "Try again"}</Button></View> : null}
      {editor ? <>
        <Text style={styles.subtitle}>{zh ? "设置任务内容和执行时间" : "Set the task and when it runs"}</Text>
        <View style={styles.card}>
          <TextField isRequired><Label>{zh ? "名称" : "Name"}</Label>
            <Input value={name} onChangeText={setName} maxLength={60} placeholder={zh ? "给任务起个名字" : "Name this task"} /></TextField>
          <TextField isRequired><Label>{zh ? "要做的事" : "Instructions"}</Label>
            <TextArea value={prompt} onChangeText={setPrompt} maxLength={1000} multiline numberOfLines={5}
              placeholder={zh ? "告诉智能体要完成什么" : "Describe what the agent should do"} /></TextField>
          <ScheduleFields value={schedule} onChange={setSchedule} zh={zh} />
          {planned === null ? <Text style={styles.error}>{zh ? "请检查执行时间" : "Check the schedule"}</Text> : null}
          <Label>{zh ? "完成后" : "After completion"}</Label>
          <RadioGroup value={deliver} onValueChange={setDeliver}>
            <RadioGroup.Item value="local" style={{ minHeight: 44 }}>{zh ? "仅保存记录" : "Save only"}</RadioGroup.Item>
            {editor?.job && editor.job.deliver !== "local" ? <RadioGroup.Item value={editor.job.deliver} style={{ minHeight: 44 }}>
              {zh ? "沿用原通知" : "Keep notification"}</RadioGroup.Item> : null}
          </RadioGroup>
        </View>
        <View style={styles.footer}>
          <Button variant="ghost" onPress={() => setEditor(null)}>{zh ? "取消" : "Cancel"}</Button>
          <Button variant="primary" isDisabled={!canSave} onPress={save}>{busy ? zh ? "保存中" : "Saving" : zh ? "保存" : "Save"}</Button>
        </View>
      </> : selected ? <>
        <Text style={styles.subtitle}>{statusLabel(selected, zh)}</Text>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{zh ? "计划" : "Schedule"}</Text>
          <Text style={styles.info}>{selected.scheduleDisplay || selected.schedule}</Text>
          <Text style={styles.hint}>{zh ? "下次执行：" : "Next run: "}{dateLabel(selected.nextRunAt, zh)}</Text>
        </View>
        {selected.kind !== "agent" ? <Text style={styles.hint}>{selected.kind === "script"
          ? zh ? "脚本任务" : "Script task" : zh ? "通知任务" : "Notification task"}</Text> : null}
        {selected.prompt ? <View style={styles.card}><Text style={styles.sectionTitle}>{zh ? "任务说明" : "Instructions"}</Text>
          <Text selectable style={styles.info}>{selected.prompt}</Text></View> : null}
        <View style={styles.card}><Text style={styles.sectionTitle}>{zh ? "最近一次" : "Last run"}</Text>
          <Text style={styles.info}>{dateLabel(selected.lastRunAt, zh)}</Text>
          {selected.lastStatus ? <Text style={styles.hint}>{selected.lastStatus}</Text> : null}</View>
        {view.runs.some(run => run.jobId === selected.id) ? <View style={styles.card}>
          <Text style={styles.sectionTitle}>{zh ? "执行记录" : "Run history"}</Text>
          {view.runs.filter(run => run.jobId === selected.id).map(run => <View key={run.id} style={styles.actions}>
            <Text style={styles.info}>{dateLabel(run.at, zh)}</Text>
            {run.status ? <Text style={styles.hint}>{run.status}</Text> : null}
          </View>)}
        </View> : null}
        <View style={styles.actions}>
          {selected.kind === "agent" ? <Button variant="secondary" style={styles.action} isDisabled={busy} onPress={() => openEditor(selected)}>{zh ? "编辑" : "Edit"}</Button> : null}
          <Button variant="secondary" style={styles.action} isDisabled={busy} onPress={() => run(selected.enabled ? "pause" : "resume", { jobId: selected.id })}>
            {selected.enabled ? zh ? "暂停" : "Pause" : zh ? "恢复" : "Resume"}</Button>
          <Button variant="secondary" style={styles.action} isDisabled={busy} onPress={() => run("test", { jobId: selected.id })}>{zh ? "测试运行" : "Test run"}</Button>
          <Button variant="danger" style={styles.action} isDisabled={busy} onPress={() => setDeleteId(selected.id)}>{zh ? "删除" : "Delete"}</Button>
        </View>
        {selected.kind !== "agent" ? <Text style={styles.hint}>{zh ? "此类任务暂不能在这里编辑。" : "Editing this task is not available here yet."}</Text> : null}
      </> : <>
        <Text style={styles.subtitle}>{zh ? "让你的智能体伙伴按计划自动完成任务。" : "Let your agent run tasks on a schedule."}</Text>
        {view.loading && view.jobs.length === 0 ? <View style={styles.card}><Spinner size="sm" color={tokens.color.accent} /></View> : null}
        {!view.loading && view.jobs.length === 0 && !view.error ? <View style={styles.card}>
          <Clock3 size={26} color={tokens.color.label} /><Text style={styles.sectionTitle}>{zh ? "还没有定时任务" : "No automations yet"}</Text>
          <Button variant="primary" onPress={() => openEditor(null)}>{zh ? "新建智能体任务" : "Create agent automation"}</Button>
        </View> : null}
        {view.jobs.length ? <ListGroup variant="transparent">
          {view.jobs.map(job => <ListGroup.Item key={job.id} accessibilityRole="button" accessibilityLabel={`${job.name}，${statusLabel(job, zh)}`}
            style={styles.row} onPress={() => setSelectedId(job.id)}>
            <ListGroup.ItemPrefix><View style={[styles.status, { backgroundColor: job.enabled ? tokens.color.statusRunning : tokens.color.statusPending }]} /></ListGroup.ItemPrefix>
            <ListGroup.ItemContent style={{ minWidth: 0 }}><ListGroup.ItemTitle numberOfLines={1} style={styles.rowTitle}>{job.name}</ListGroup.ItemTitle>
              <ListGroup.ItemDescription numberOfLines={2} style={styles.rowDescription}>{statusLabel(job, zh)} · {job.scheduleDisplay || job.schedule}</ListGroup.ItemDescription>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix><ChevronRight size={17} color={tokens.color.iconSoft} /></ListGroup.ItemSuffix>
          </ListGroup.Item>)}
        </ListGroup> : null}
        <Button variant="ghost" isDisabled={busy || view.loading} onPress={() => run("list")}>
          <RefreshCw size={16} color={tokens.color.icon} />{zh ? "刷新" : "Refresh"}
        </Button>
      </>}
    </ScrollView>
    <Dialog isOpen={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleteId(null); }}>
      <Dialog.Portal unstable_accessibilityContainerViewIsModal><Dialog.Overlay />
        <Dialog.Content style={styles.dialog}>
          <Dialog.Title>{zh ? "删除定时任务？" : "Delete automation?"}</Dialog.Title>
          <Dialog.Description>{deleting && view.jobs.some(job => job.contextFrom.includes(deleting.id))
            ? zh ? "此任务与其他任务有关联，删除后关联关系也会更新。" : "Related tasks will be updated."
            : zh ? "删除后无法恢复。" : "This cannot be undone."}</Dialog.Description>
          <View style={styles.footer}>
            <Button variant="ghost" onPress={() => setDeleteId(null)}>{zh ? "取消" : "Cancel"}</Button>
            <Button variant="danger" isDisabled={busy} onPress={() => {
              if (deleting) run("remove", { jobId: deleting.id,
                dependentIds: view.jobs.filter(job => job.contextFrom.includes(deleting.id)).map(job => job.id) });
              setDeleteId(null);
            }}>{zh ? "删除" : "Delete"}</Button>
          </View>
        </Dialog.Content></Dialog.Portal>
    </Dialog>
  </KeyboardAvoidingView>;
}
