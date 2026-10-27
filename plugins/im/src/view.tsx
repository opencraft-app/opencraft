import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "@opencraft/i18n/react";
import { ChevronLeftIcon, ArrowRightIcon } from "@opencraft/design-system-web/action-icons";
import * as Dialog from "@radix-ui/react-dialog";
import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
import {
  SettingsActions,
  SettingsButton as Button,
  SettingsGroup,
  SettingsListItem,
  SettingsPageHeader,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsTextInput as Input,
  SettingsNotice,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import {
  ImController,
  type ImChannel,
  type ImDocument,
  type ImRecord,
} from "./client";
import { sourceRoute, stewardRoute } from "./templates";
import "./styles.scss";

const stateLabel = (value: string) =>
  ({
    ready: "已连接",
    connecting: "连接中",
    authenticating: "认证中",
    closed: "已停止",
    disconnected: "连接中断",
    disabled: "已停用",
  })[value] ?? "未连接";
const messageLabel = (value: string) =>
  ({
    routing: "正在确定去向",
    accepted: "已接纳",
    submitted: "执行中",
    reply_pending: "等待发送",
    reply_attempting: "正在发送",
    delivered: "已送达",
    reply_unknown: "送达待确认",
    reply_failed: "回复不可用",
    failed: "路由失败",
    ignored: "已忽略",
    unknown: "接纳待确认",
  })[value] ?? value;
const errorLabel = (value: string) =>
  ({
    revision_conflict: "配置已在其他窗口更新。请重新载入，合并草稿后再启用。",
    human_authentication_required: "请登录后管理 IM 渠道。",
    authentication_required: "服务器登录已失效，请重新登录当前站点。",
    instance_access_denied: "当前账号没有此服务器的访问权限。",
    actor_access_denied: "当前自然人身份未通过服务器准入。",
    actor_resource_interface_required: "机器人凭据不能用于管理 IM 渠道，请使用自然人账号。",
    access_denied: "入口服务拒绝了此次请求。",
    im_unavailable: "服务器的 IM 服务暂不可用，请稍后重试。",
    relay_unavailable: "入口暂时无法连接目标服务器，请稍后重试。",
    invalid_server_response: "服务器未返回有效的渠道响应。",
    same_origin_required: "请求来源校验失败，请重新打开当前站点后重试。",
    bot_already_configured: "这个机器人已配置，请使用已有渠道。",
    connection_failed: "暂时无法连接，请核对凭据后重试。",
    channel_denied: "当前账号无权执行此操作。",
    route_failed: "路由函数未通过，请检查代码和运行限制。",
    target_denied: "目标会话不存在、不可访问或当前执行端不支持。",
    delivery_unconfirmed: "平台尚未确认送达；再次发送可能重复。",
    admission_interrupted: "接纳过程中服务中断，未自动重新执行。",
    reply_expired: "原平台回复位置已过期，请打开会话查看结果。",
    result_unavailable: "暂时未能取得任务结果。任务可能仍在继续。",
    reply_unavailable: "原回复位置不可用。",
    operation_failed: "操作未完成，请检查配置后重试。",
  })[value] ?? "操作未完成，请检查输入和权限后重试。";
function Status({ value }: { value: string }) {
  return (
    <span className="im-status" data-state={value}>
      {stateLabel(value)}
    </span>
  );
}

export function createImView(controller: ImController) {
  return function ImChannels(props: ExtensionSettingsViewProps) {
    const modalOpener = useRef<HTMLElement | null>(null);
    const [document, setDocument] = useState<ImDocument | null>(null),
      [loadError, setLoadError] = useState<string | null>(null),
      [selected, setSelected] = useState<string | null>(null),
      [tab, setTab] = useState("route");
    const [pending, setPending] = useState<string | null>(null),
      [modal, setModal] = useState<string | null>(null),
      [createProvider, setCreateProvider] = useState<"wecom" | "slack">(
        "wecom",
      );
    const [form, setForm] = useState({
        name: "",
        botId: "",
        secret: "",
        botToken: "",
        appToken: "",
      }),
      [invalid, setInvalid] = useState(false);
    const [renderVersion, update] = useState(0),
      [sample, setSample] = useState("group"),
      [preview, setPreview] = useState<unknown>(null),
      [records, setRecords] = useState<ImRecord[]>([]),
      [challenge, setChallenge] = useState(""),
      [filter, setFilter] = useState("all");
    const generation = useRef(0),
      alive = useRef(true),
      previewGeneration = useRef(0),
      tabRefs = useRef<(HTMLButtonElement | null)[]>([]),
      selection = useRef(selected),
      actorRef = useRef<string | null>(null);
    selection.current = selected;
    const client = controller.client;
    const current = document?.channels.find((c) => c.id === selected) ?? null;
    const draft = current ? controller.draft(current) : null;
    const touch = () => update((v) => v + 1);
    const report = (error: unknown) =>
      props.reportError?.({
        key: "im:" + selected,
        message: errorLabel(
          error instanceof Error ? error.message : "operation_failed",
        ),
      });
    const reload = async () => {
      const own = ++generation.current;
      try {
        const value = await client.request<ImDocument>({ action: "list" });
        if (alive.current && own === generation.current) {
          if (actorRef.current && actorRef.current !== value.actorId) {
            controller.dispose();
            setSelected(null);
            setForm({
              name: "",
              botId: "",
              secret: "",
              botToken: "",
              appToken: "",
            });
            setModal(null);
            setChallenge("");
          }
          actorRef.current = value.actorId;
          setDocument(value);
          setLoadError(null);
        }
      } catch (error) {
        if (alive.current && own === generation.current) {
          setLoadError(errorLabel(error instanceof Error ? error.message : "operation_failed"));
          if (
            error instanceof Error &&
            ["human_authentication_required", "channel_denied"].includes(
              error.message,
            )
          ) {
            controller.dispose();
            setDocument(null);
            setSelected(null);
            setForm({
              name: "",
              botId: "",
              secret: "",
              botToken: "",
              appToken: "",
            });
            setModal(null);
            setChallenge("");
          }
          report(error);
        }
      }
    };
    useEffect(() => {
      alive.current = true;
      void reload();
      const timer = setInterval(() => void reload(), 5000);
      return () => {
        alive.current = false;
        generation.current++;
        clearInterval(timer);
      };
    }, []);
    useEffect(() => {
      setPreview(null);
      previewGeneration.current++;
      setRecords([]);
    }, [selected]);
    const run = async (key: string, fn: () => Promise<void>) => {
      if (pending) return;
      setPending(key);
      try {
        await fn();
      } catch (error) {
        if (alive.current) report(error);
      } finally {
        if (alive.current) setPending(null);
      }
    };
    const select = (c: ImChannel) => {
      setSelected(c.id);
      setTab(c.canManage ? "route" : "people");
    };
    const saved = (c: ImChannel) => {
      setDocument((value) =>
        value
          ? {
              ...value,
              channels: value.channels.some((x) => x.id === c.id)
                ? value.channels.map((x) => (x.id === c.id ? c : x))
                : [...value.channels, c],
            }
          : value,
      );
    };
    const mutateDraft = (change: () => void) => {
      change();
      previewGeneration.current++;
      setPreview(null);
      touch();
    };
    const chooseMode = (mode: "source" | "steward" | "custom") => {
      if (!draft) return;
      mutateDraft(() => {
        draft.mode = mode;
        if (mode === "source") draft.source = sourceRoute;
        if (mode === "steward" && parseConversationRef(draft.reference))
          draft.source = stewardRoute(draft.reference);
      });
    };
    const publish = () =>
      run("publish", async () => {
        if (!current || !draft) return;
        let source = draft.source;
        if (draft.mode === "steward") source = stewardRoute(draft.reference);
        const result = await client.request<{ channel: ImChannel }>({
          action: "route",
          id: current.id,
          revision: draft.revision,
          source,
          publish: true,
        });
        saved(result.channel);
        draft.revision = result.channel.revision;
        draft.source = result.channel.route;
        setModal(null);
        touch();
      });
    const loadRecords = async () => {
      if (!current) return;
      const id = current.id;
      const result = await client.request<{ messages: ImRecord[] }>({
        action: "messages",
        id,
      });
      if (alive.current && selection.current === id)
        setRecords(result.messages);
    };
    useEffect(() => {
      if (tab === "messages" && current) void run("messages", loadRecords);
    }, [tab, selected]);
    const routePreview = () =>
      run("preview", async () => {
        if (!current || !draft || !document) return;
        const own = ++previewGeneration.current;
        const source =
          draft.mode === "steward"
            ? stewardRoute(draft.reference)
            : draft.source;
        if (!source) {
          setPreview({
            kind: "legacy",
            text: "沿用当前渠道的来源范围和已有会话映射。",
          });
          return;
        }
        const event = {
          id: "preview-only",
          channelId: current.id,
          platform: current.provider,
          chat: {
            id: sample === "direct" ? "preview-private" : "preview-group",
            type: sample === "direct" ? "direct" : "group",
            ...(sample === "thread" ? { threadId: "preview-thread" } : {}),
          },
          sender: { id: "preview-sender", actorId: document.actorId },
          text: "请继续跟进这个任务。",
        };
        const result = await client.request<{ decision: unknown }>({
          action: "preview",
          id: current.id,
          source,
          event,
        });
        if (alive.current && own === previewGeneration.current)
          setPreview(result.decision);
      });
    const updateChannel = (enabled: boolean) =>
      run("connection", async () => {
        if (!current || !draft) return;
        const result = await client.request<{
          channel: ImChannel;
          connectionError?: boolean;
        }>({
          action: "update",
          id: current.id,
          revision: current.revision,
          config: { name: draft.name, enabled },
          credentials: draft.credentials,
        });
        saved(result.channel);
        draft.revision = result.channel.revision;
        draft.credentials = {};
        setModal(null);
        touch();
        if (result.connectionError) report(Error("connection_failed"));
      });
    const dialogTitle =
      modal === "conversations"
        ? "选择管家会话"
        : modal === "unlink"
          ? "解除这个 IM 身份？"
          : modal === "join"
            ? "关联已有渠道"
            : modal === "add"
              ? "添加 IM 渠道"
              : modal === "publish"
                ? "启用路由更改"
                : modal === "disable"
                  ? "停用这个渠道？"
                  : modal === "delete"
                    ? "删除这个渠道？"
                    : modal === "identity"
                      ? "关联我的 IM 身份"
                      : modal === "resend"
                        ? "重发原回复？"
                        : modal === "conflict"
                          ? "重新载入线上版本？"
                          : "IM 渠道";
    const [deliveryId, setDeliveryId] = useState(""),
      [existingId, setExistingId] = useState(""),
      [unlinkSender, setUnlinkSender] = useState(""),
      [conversationQuery, setConversationQuery] = useState(""),
      [conversationChoices, setConversationChoices] = useState<
        { reference: string; title: string; engine?: string }[]
      >([]),
      [conversationCursor, setConversationCursor] = useState<string | null>(
        null,
      );
    const loadConversations = (cursor: string | null = null) =>
      run("conversations", async () => {
        const owner = selected;
        const value = await client.request<{
          conversations: { reference: string; title: string; engine?: string }[];
          nextCursor: string | null;
        }>({
          action: "conversations",
          id: current!.id,
          search: conversationQuery,
          cursor,
        });
        if (alive.current && selection.current === owner) {
          setConversationChoices((rows) =>
            cursor ? [...rows, ...value.conversations] : value.conversations,
          );
          setConversationCursor(value.nextCursor);
          setModal("conversations");
        }
      });
    const selectedRecords = records.filter(
      (m) =>
        filter === "all" ||
        ["failed", "reply_failed", "reply_unknown", "unknown"].includes(
          m.state,
        ),
    );
    return (
      <div className="im-settings" data-render-version={renderVersion}>
        <div className="im-heading">
        {current ? (
          <Button variant="quiet" onClick={() => setSelected(null)}>
            <ChevronLeftIcon size={16} /><FormattedMessage id="im.channels.back" defaultMessage="IM channels" />
          </Button>
        ) : null}
        <SettingsPageHeader
          title={current ? current.name : "IM 渠道"}
          description={
            current ? (
              <Status value={current.state} />
            ) : (
              "连接聊天工具，决定消息去向。"
            )
          }
        />
        </div>
        {!document ? (
          <SettingsNotice>
            {loadError ? `暂时无法读取渠道。${loadError}` : "正在加载渠道…"}
            <Button onClick={() => void reload()}>重试</Button>
          </SettingsNotice>
        ) : !current ? (
          <>
            <SettingsSection
              title="我的渠道"
              action={
                <SettingsActions>
                  <Button variant="quiet" onClick={() => setModal("join")}>关联已有渠道</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setInvalid(false);
                      setModal("add");
                    }}
                  >
                    添加渠道
                  </Button>
                </SettingsActions>
              }
            >
              {document.channels.length ? (
                <SettingsGroup appearance="plain">
                  {document.channels.map((c) => (
                    <SettingsListItem
                      key={c.id}
                      label={
                        <button
                          className="im-object-link"
                          onClick={() => select(c)}
                        >
                          {c.name}
                        </button>
                      }
                      description={`${c.provider === "wecom" ? "企业微信" : "Slack"} · ${c.route === null ? "兼容默认路由" : c.route === sourceRoute ? "按来源分会话" : "路由函数"} · v${c.revision}`}
                      metadata={<Status value={c.state} />}
                      actions={
                        <Button variant="quiet" onClick={() => select(c)}>
                          管理
                        </Button>
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : (
                <div className="im-empty">
                  <h3>连接你的第一个 IM 渠道</h3>
                  <p>连接机器人后，可以按来源继续会话，或把消息交给管家。</p>
                </div>
              )}
            </SettingsSection>
            <p className="im-hint">
              一个渠道可接收多个聊天。每条回复回到触发消息的原聊天。
            </p>
          </>
        ) : (
          <>
            <div className="im-tabs" role="tablist" aria-label="渠道设置">
              {[
                ["route", "消息路由"],
                ["connection", "连接配置"],
                ["people", "使用者"],
                ["messages", "消息记录"],
              ]
                .filter(
                  ([id]) =>
                    current.canManage || ["people", "messages"].includes(id),
                )
                .map(([id, label], i) => (
                  <button
                    key={id}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={"im-panel-" + id}
                    id={"im-tab-" + id}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    onKeyDown={(e) => {
                      if (
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          e.key,
                        )
                      )
                        return;
                      e.preventDefault();
                      const tabs = tabRefs.current.filter(
                        (x): x is HTMLButtonElement => !!x,
                      );
                      const n =
                        e.key === "Home"
                          ? 0
                          : e.key === "End"
                            ? tabs.length - 1
                            : (i +
                                (e.key === "ArrowRight" ? 1 : -1) +
                                tabs.length) %
                              tabs.length;
                      tabs[n]?.click();
                      tabs[n]?.focus();
                    }}
                  >
                    {label}
                  </button>
                ))}
            </div>
            <section
              role="tabpanel"
              id={"im-panel-" + tab}
              aria-labelledby={"im-tab-" + tab}
            >
              {tab === "route" && draft && current.canManage ? (
                <>
                  <SettingsSection
                    title="消息交给谁"
                    action={
                      <span className="im-hint">
                        已启用 v{current.revision}
                      </span>
                    }
                  >
                    <div className="im-presets">
                      {[
                        [
                          "source",
                          "按来源分会话",
                          "私聊、群成员各自继续；话题共享",
                        ],
                        [
                          "steward",
                          "交给管家",
                          "进入指定会话，由 Agent 继续分派",
                        ],
                        ["custom", "自定义函数", "按群、发送人或消息内容决定"],
                      ].map(([value, label, note]) => (
                        <button
                          key={value}
                          aria-pressed={draft.mode === value}
                          onClick={() => chooseMode(value as typeof draft.mode)}
                        >
                          <strong>{label}</strong>
                          <small>{note}</small>
                        </button>
                      ))}
                    </div>
                    {current.route === null ? (
                      <p className="im-hint">
                        当前沿用已有来源范围和映射。选择新预设并启用后才改变后续消息去向。
                      </p>
                    ) : null}
                  </SettingsSection>
                  {draft.mode === "steward" ? (
                    <SettingsGroup>
                      <SettingsRow
                        label="管家会话"
                        htmlFor="im-steward"
                        description="多个来源进入同一会话时共享上下文；回复仍各自返回。"
                        layout="stacked"
                      >
                        <Button onClick={() => void loadConversations()}>
                          选择已有会话…
                        </Button>
                        <Input
                          id="im-steward"
                          placeholder="粘贴 opencraft:// 会话引用"
                          value={draft.reference}
                          onChange={(e) =>
                            mutateDraft(() => {
                              draft.reference = e.target.value;
                              if (parseConversationRef(draft.reference))
                                draft.source = stewardRoute(draft.reference);
                            })
                          }
                        />
                      </SettingsRow>
                    </SettingsGroup>
                  ) : null}
                  <div className="im-route-workspace">
                    <section>
                      <div className="im-editor">
                        <div className="im-editor-heading">
                          route.js{" "}
                          <span>
                            {draft.mode === "custom"
                              ? "自定义函数"
                              : "预设生成"}
                          </span>
                        </div>
                        <textarea
                          aria-label="路由函数"
                          className="im-code"
                          spellCheck={false}
                          wrap="off"
                          readOnly={draft.mode !== "custom"}
                          value={
                            draft.source ??
                            "// 沿用已有来源范围和会话映射。\n// 选择预设或在此基础上自定义。"
                          }
                          onChange={(e) =>
                            mutateDraft(() => {
                              draft.source = e.target.value;
                            })
                          }
                        />
                      </div>
                      {draft.mode !== "custom" ? (
                        <Button
                          variant="quiet"
                          onClick={() =>
                            mutateDraft(() => {
                              draft.mode = "custom";
                              draft.source ??= sourceRoute;
                            })
                          }
                        >
                          <FormattedMessage id="im.route.customize" defaultMessage="Customize this route" /><ArrowRightIcon size={16} />
                        </Button>
                      ) : (
                        <p className="im-hint">
                          返回稳定 key、已有会话引用，或 {"{ ignore: true }"}
                          。函数不执行任务。
                        </p>
                      )}
                    </section>
                    <section className="im-preview">
                      <h3>路由预览</h3>
                      <p className="im-hint">
                        仅计算去向，不创建会话或发送消息。
                      </p>
                      <label htmlFor="im-sample">示例消息</label>
                      <SettingsSelect
                        id="im-sample"
                        value={sample}
                        onChange={(e) => {
                          setSample(e.target.value);
                          setPreview(null);
                          previewGeneration.current++;
                        }}
                      >
                        <option value="direct">私聊</option>
                        <option value="group">群聊 @机器人</option>
                        <option value="thread">话题回复</option>
                      </SettingsSelect>
                      <SettingsActions>
                        <Button
                          loading={pending === "preview"}
                          onClick={() => void routePreview()}
                        >
                          运行预览
                        </Button>
                      </SettingsActions>
                      <div className="im-preview-result" aria-live="polite">
                        {preview ? (
                          <>
                            <span>预览结果</span>
                            <pre>{JSON.stringify(preview, null, 2)}</pre>
                            <p className="im-hint">
                              实际接纳时仍检查目标权限。稳定 key
                              无映射时才创建会话。
                            </p>
                          </>
                        ) : (
                          <p className="im-hint">
                            选择示例消息，查看草稿的路由结果。
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                  <SettingsActions align="between">
                    <div className="im-hint">
                      {draft.source === current.route
                        ? "与线上版本一致"
                        : "有未启用的更改"}
                      <br />
                      更改只影响之后接纳的消息。
                    </div>
                    <div className="im-actions">
                      <Button
                        loading={pending === "draft"}
                        onClick={() =>
                          void run("draft", async () => {
                            const result = await client.request<{
                              channel: ImChannel;
                            }>({
                              action: "route",
                              id: current.id,
                              revision: draft.revision,
                              source: draft.source,
                              publish: false,
                            });
                            saved(result.channel);
                            draft.revision = result.channel.revision;
                            touch();
                          })
                        }
                      >
                        保存草稿
                      </Button>
                      <Button
                        variant="primary"
                        disabled={
                          draft.source === current.route ||
                          pending !== null ||
                          (draft.mode === "steward" &&
                            !parseConversationRef(draft.reference))
                        }
                        onClick={() => setModal("publish")}
                      >
                        启用更改
                      </Button>
                    </div>
                  </SettingsActions>
                  {draft.revision !== current.revision ? (
                    <Button onClick={() => setModal("conflict")}>
                      线上版本已更新，重新载入…
                    </Button>
                  ) : null}
                  <details className="im-history">
                    <summary className="ui-native-disclosure">版本与回退</summary>
                    <SettingsGroup appearance="plain">
                      {current.versions.length ? (
                        current.versions.map((v) => (
                          <SettingsListItem
                            key={v.revision}
                            label={"v" + v.revision}
                            description={new Date(
                              v.created_at,
                            ).toLocaleString()}
                            actions={
                              <Button
                                onClick={() =>
                                  mutateDraft(() => {
                                    draft.source = v.source;
                                    draft.mode =
                                      v.source === null ? "source" : "custom";
                                  })
                                }
                              >
                                载入为草稿
                              </Button>
                            }
                          />
                        ))
                      ) : (
                        <p className="im-hint">
                          启用新版本后，旧版本保留在这里。
                        </p>
                      )}
                    </SettingsGroup>
                  </details>
                </>
              ) : null}
              {tab === "connection" && draft && current.canManage ? (
                <>
                  <SettingsGroup>
                    <SettingsRow
                      label="渠道 ID"
                      description="将此 ID 提供给使用者，即可从渠道列表关联自己的身份。"
                    >
                      <span className="im-break">{current.id}</span>
                      <Button
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(current.id)
                            .catch(report)
                        }
                      >
                        复制
                      </Button>
                    </SettingsRow>
                    <SettingsRow label="渠道名称" htmlFor="im-name">
                      <Input
                        id="im-name"
                        value={draft.name}
                        onChange={(e) =>
                          mutateDraft(() => {
                            draft.name = e.target.value;
                          })
                        }
                      />
                    </SettingsRow>
                    {current.botId ? (
                      <SettingsRow label="Bot ID">
                        <span className="im-break">{current.botId}</span>
                      </SettingsRow>
                    ) : null}
                    {(current.provider === "wecom"
                      ? ["secret"]
                      : ["botToken", "appToken"]
                    ).map((key) => (
                      <SettingsRow
                        key={key}
                        label={
                          key === "secret"
                            ? "Secret"
                            : key === "botToken"
                              ? "Bot Token"
                              : "App Token"
                        }
                        htmlFor={"im-" + key}
                        description="密钥只写入，留空保留原值。"
                      >
                        <Input
                          id={"im-" + key}
                          type="password"
                          autoComplete="new-password"
                          placeholder="已配置 · 输入新值以更换"
                          value={draft.credentials[key] ?? ""}
                          onChange={(e) => {
                            draft.credentials[key] = e.target.value;
                            touch();
                          }}
                        />
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                  <SettingsActions>
                    <Button
                      variant="primary"
                      loading={pending === "connection"}
                      disabled={!draft.name.trim()}
                      onClick={() => void updateChannel(current.enabled)}
                    >
                      保存更改
                    </Button>
                  </SettingsActions>
                  <SettingsSection title="连接管理">
                    <SettingsGroup>
                      <SettingsRow
                        label="连接状态"
                        description="重连复用当前受管连接，不额外创建测试连接。"
                      >
                        <Status value={current.state} />
                        <Button
                          loading={pending === "reconnect"}
                          disabled={!current.enabled}
                          onClick={() =>
                            void run("reconnect", async () => {
                              await client.request({
                                action: "reconnect",
                                id: current.id,
                              });
                              await reload();
                            })
                          }
                        >
                          重新连接
                        </Button>
                      </SettingsRow>
                      <SettingsRow
                        label="启用渠道"
                        description="停用保留路由、映射与会话历史。"
                      >
                        <Button
                          onClick={() =>
                            current.enabled
                              ? setModal("disable")
                              : void updateChannel(true)
                          }
                        >
                          {current.enabled ? "停用渠道" : "启用渠道"}
                        </Button>
                      </SettingsRow>
                    </SettingsGroup>
                    <SettingsActions align="start">
                      <Button
                        variant="quiet"
                        onClick={() => setModal("delete")}
                      >
                        删除渠道…
                      </Button>
                    </SettingsActions>
                  </SettingsSection>
                </>
              ) : null}
              {tab === "people" ? (
                <SettingsSection
                  title="使用者"
                  description="外部 IM 身份关联到已有自然人。消息以发送者本人权限执行。"
                  action={
                    <Button
                      loading={pending === "identity"}
                      onClick={() =>
                        void run("identity", async () => {
                          const result = await client.request<{
                            command: string;
                          }>({ action: "identity", id: current.id });
                          setChallenge(result.command);
                          setModal("identity");
                        })
                      }
                    >
                      关联我的身份
                    </Button>
                  }
                >
                  <SettingsGroup appearance="plain">
                    {current.senders.length ? (
                      current.senders.map((s) => (
                        <SettingsListItem
                          key={s.senderId}
                          label={
                            s.actorId === document.actorId ? "我" : s.actorId
                          }
                          description={s.senderId}
                          metadata="已关联"
                          actions={
                            <Button
                              variant="quiet"
                              onClick={() => {
                                setUnlinkSender(s.senderId);
                                setModal("unlink");
                              }}
                            >
                              解除关联…
                            </Button>
                          }
                        />
                      ))
                    ) : (
                      <p className="im-hint">还没有已关联的使用者。</p>
                    )}
                  </SettingsGroup>
                </SettingsSection>
              ) : null}
              {tab === "messages" ? (
                <SettingsSection
                  title="消息记录"
                  description="查看接纳时确定的去向，以及最终回复是否送达。"
                  action={
                    <Button
                      loading={pending === "messages"}
                      onClick={() => void run("messages", loadRecords)}
                    >
                      刷新
                    </Button>
                  }
                >
                  <SettingsSelect
                    aria-label="消息筛选"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">全部消息</option>
                    <option value="failed">需要处理</option>
                  </SettingsSelect>
                  <SettingsGroup appearance="plain">
                    {selectedRecords.length ? (
                      selectedRecords.map((m) => {
                        const source = JSON.parse(m.source);
                        let target: {
                          serverId: string;
                          threadId: string;
                        } | null = null;
                        try {
                          target = m.conversation_ref
                            ? JSON.parse(m.conversation_ref)
                            : null;
                        } catch {}
                        return (
                          <SettingsListItem
                            key={m.id}
                            label={`${source.chatType === "direct" ? "私聊" : "群聊"} · ${source.chatId}`}
                            description={`v${m.route_revision} · ${messageLabel(m.state)} · ${new Date(m.created_at).toLocaleString()}`}
                            metadata={
                              <>
                                {target ? (
                                  <button
                                    className="im-object-link"
                                    onClick={() =>
                                      void Promise.resolve(
                                        props.host.openConversation?.(
                                          document.servers?.find(server => server.serverId === target!.serverId)?.hostId ?? (target!.serverId === document.serverId
                                            ? document.workbenchHostId
                                            : target!.serverId),
                                          target!.threadId,
                                        ),
                                      ).catch(report)
                                    }
                                  >
                                    {target.threadId}
                                  </button>
                                ) : null}
                                {m.error ? (
                                  <span className="im-hint">
                                    {errorLabel(m.error)}
                                  </span>
                                ) : null}
                              </>
                            }
                            actions={
                              [
                                "accepted",
                                "submitted",
                                "reply_pending",
                              ].includes(m.state) &&
                              m.error &&
                              current.canManage ? (
                                <Button
                                  onClick={() =>
                                    void run("resume", async () => {
                                      await client.request({
                                        action: "resume",
                                        id: current.id,
                                      });
                                      await loadRecords();
                                    })
                                  }
                                >
                                  继续取结果
                                </Button>
                              ) : ["reply_unknown", "reply_failed"].includes(
                                  m.state,
                                ) && current.canManage ? (
                                <Button
                                  onClick={() => {
                                    setDeliveryId(m.id);
                                    setModal("resend");
                                  }}
                                >
                                  重发原回复…
                                </Button>
                              ) : undefined
                            }
                          />
                        );
                      })
                    ) : (
                      <div className="im-empty">
                        <p>还没有对应消息。</p>
                      </div>
                    )}
                  </SettingsGroup>
                </SettingsSection>
              ) : null}
            </section>
          </>
        )}
        <Dialog.Root
          open={modal !== null}
          onOpenChange={(open) => {
            if (!open && !pending) setModal(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="modal-surface__scrim" data-appearance="utility" />
            <Dialog.Content className="modal-surface im-dialog" data-appearance="utility" data-size="default"
              onOpenAutoFocus={() => { modalOpener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null; }}
              onCloseAutoFocus={(event) => { if (modalOpener.current?.isConnected) { event.preventDefault(); modalOpener.current.focus({ preventScroll: true }); } }}
            >
              <SettingsPanel title={<Dialog.Title asChild><span>{dialogTitle}</span></Dialog.Title>}>
              <div className="settings-panel-form">
              <Dialog.Description className="im-hint">
                {modal === "add"
                  ? "选择平台，凭据保存于当前服务。"
                  : current?.name}
              </Dialog.Description>
              {modal === "conversations" ? (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadConversations();
                    }}
                  >
                    <SettingsRow
                      label="搜索会话"
                      htmlFor="im-conversation-query"
                      layout="stacked"
                    >
                      <Input
                        id="im-conversation-query"
                        value={conversationQuery}
                        onChange={(e) => setConversationQuery(e.target.value)}
                      />
                    </SettingsRow>
                    <SettingsActions>
                      <Button
                        type="submit"
                        loading={pending === "conversations"}
                      >
                        搜索
                      </Button>
                    </SettingsActions>
                  </form>
                  <SettingsGroup appearance="plain">
                    {conversationChoices.length ? (
                      conversationChoices.map((c) => (
                        <SettingsListItem
                          key={c.reference}
                          label={c.title}
                          description={c.engine}
                          actions={
                            <Button
                              onClick={() => {
                                if (!draft) return;
                                mutateDraft(() => {
                                  draft.reference = c.reference;
                                  draft.source = stewardRoute(c.reference);
                                });
                                setModal(null);
                              }}
                            >
                              选择
                            </Button>
                          }
                        />
                      ))
                    ) : (
                      <SettingsNotice>
                        没有找到会话。可以调整搜索词，或从会话菜单复制引用。
                      </SettingsNotice>
                    )}
                  </SettingsGroup>
                  <SettingsActions>
                    {conversationCursor ? (
                      <Button
                        loading={pending === "conversations"}
                        onClick={() =>
                          void loadConversations(conversationCursor)
                        }
                      >
                        加载更多
                      </Button>
                    ) : null}
                    <Dialog.Close asChild>
                      <Button>关闭</Button>
                    </Dialog.Close>
                  </SettingsActions>
                </>
              ) : modal === "unlink" ? (
                <>
                  <p>
                    此 IM
                    身份将无法发送新任务或收到尚未发送的回复。已有会话和任务保留。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      loading={pending === "unlink"}
                      onClick={() =>
                        void run("unlink", async () => {
                          await client.request({
                            action: "unlink",
                            id: current!.id,
                            senderId: unlinkSender,
                          });
                          setModal(null);
                          await reload();
                        })
                      }
                    >
                      解除关联
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "join" ? (
                <>
                  <SettingsRow
                    label="渠道 ID"
                    htmlFor="im-existing"
                    layout="stacked"
                  >
                    <Input
                      id="im-existing"
                      value={existingId}
                      onChange={(e) => setExistingId(e.target.value)}
                    />
                  </SettingsRow>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      variant="primary"
                      disabled={!existingId.trim()}
                      loading={pending === "identity"}
                      onClick={() =>
                        void run("identity", async () => {
                          const result = await client.request<{
                            command: string;
                          }>({ action: "identity", id: existingId.trim() });
                          setChallenge(result.command);
                          setModal("identity");
                        })
                      }
                    >
                      生成关联指令
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "add" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setInvalid(true);
                    const keys =
                      createProvider === "wecom"
                        ? ["name", "botId", "secret"]
                        : ["name", "botToken", "appToken"];
                    if (keys.some((k) => !form[k as keyof typeof form].trim()))
                      return;
                    void run("create", async () => {
                      const credentials =
                        createProvider === "wecom"
                          ? { secret: form.secret }
                          : {
                              botToken: form.botToken,
                              appToken: form.appToken,
                            };
                      const result = await client.request<{
                        channel: ImChannel;
                        connectionError?: boolean;
                      }>({
                        action: "create",
                        config: {
                          name: form.name,
                          provider: createProvider,
                          ...(createProvider === "wecom"
                            ? { botId: form.botId }
                            : {}),
                        },
                        credentials,
                      });
                      saved(result.channel);
                      controller.drafts.delete(result.channel.id);
                      setForm({
                        name: "",
                        botId: "",
                        secret: "",
                        botToken: "",
                        appToken: "",
                      });
                      setModal(null);
                      select(result.channel);
                      if (result.connectionError)
                        report(Error("connection_failed"));
                    });
                  }}
                >
                  <SettingsRow
                    label="平台"
                    htmlFor="im-provider"
                    layout="stacked"
                  >
                    <SettingsSelect
                      id="im-provider"
                      value={createProvider}
                      onChange={(e) => {
                        setCreateProvider(
                          e.target.value as typeof createProvider,
                        );
                        setInvalid(false);
                      }}
                    >
                      <option value="wecom">企业微信</option>
                      <option value="slack">Slack</option>
                    </SettingsSelect>
                  </SettingsRow>
                  {(createProvider === "wecom"
                    ? ["name", "botId", "secret"]
                    : ["name", "botToken", "appToken"]
                  ).map((key) => (
                    <SettingsRow
                      key={key}
                      label={
                        {
                          name: "渠道名称",
                          botId: "Bot ID",
                          secret: "Secret",
                          botToken: "Bot Token",
                          appToken: "App Token",
                        }[key]
                      }
                      htmlFor={"new-" + key}
                      layout="stacked"

                    >
                      <Input
                        id={"new-" + key}
                        type={
                          ["name", "botId"].includes(key) ? "text" : "password"
                        }
                        autoComplete="off"
                        aria-describedby={"new-" + key + "-error"}
                        value={form[key as keyof typeof form]}
                        aria-invalid={
                          (invalid && !form[key as keyof typeof form].trim()) ||
                          undefined
                        }
                        onChange={(e) =>
                          setForm((v) => ({ ...v, [key]: e.target.value }))
                        }
                      />
                      <span
                        id={"new-" + key + "-error"}
                        className="im-validation"
                        role={invalid && !form[key as keyof typeof form].trim() ? "alert" : undefined}
                      >
                        {invalid && !form[key as keyof typeof form].trim() ? "请填写此字段。" : "\u00a0"}
                      </span>
                    </SettingsRow>
                  ))}
                  {createProvider === "slack" ? (
                    <p className="im-hint">
                      Slack App 需要启用 Socket Mode，并订阅
                      app_mention、message.im 及授予对应权限。
                    </p>
                  ) : null}
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button type="button" disabled={pending !== null}>取消</Button>
                    </Dialog.Close>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={pending === "create"}
                    >
                      保存并连接
                    </Button>
                  </SettingsActions>
                </form>
              ) : modal === "publish" ? (
                <>
                  <p>
                    之后接纳的消息使用新版本。已接纳消息与待发送回复保留原去向；稳定
                    key 不变时继续已有会话。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button disabled={pending !== null}>继续编辑</Button>
                    </Dialog.Close>
                    <Button
                      variant="primary"
                      loading={pending === "publish"}
                      onClick={() => void publish()}
                    >
                      启用新版本
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "disable" ? (
                <>
                  <p>
                    停止接收新消息和发送尚未发出的回复。已接纳的核心任务继续，结果可在会话查看。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      loading={pending === "connection"}
                      onClick={() => void updateChannel(false)}
                    >
                      停用渠道
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "delete" ? (
                <>
                  <p>
                    删除连接配置、专属凭据和该渠道映射。所有 OpenCraft
                    会话及历史保留。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      variant="danger"
                      loading={pending === "delete"}
                      onClick={() =>
                        void run("delete", async () => {
                          await client.request({
                            action: "delete",
                            id: current!.id,
                          });
                          controller.drafts.delete(current!.id);
                          setSelected(null);
                          setModal(null);
                          await reload();
                        })
                      }
                    >
                      删除渠道
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "identity" ? (
                <>
                  <p>
                    在这个机器人的私聊中发送以下一次性指令。五分钟内有效，仅关联当前账号，不改变路由。
                  </p>
                  <pre className="im-reference">{challenge}</pre>
                  <SettingsActions>
                    <Button
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(challenge)
                          .catch(report)
                      }
                    >
                      复制指令
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        setModal(null);
                        void reload();
                      }}
                    >
                      完成后刷新
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "resend" ? (
                <>
                  <p>
                    上一条回复可能已经送达，再次发送可能重复。沿用原回复内容和目的地，不重新执行
                    Agent。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      loading={pending === "resend"}
                      onClick={() =>
                        void run("resend", async () => {
                          await client.request({
                            action: "resend",
                            id: current!.id,
                            messageId: deliveryId,
                          });
                          setModal(null);
                          await loadRecords();
                        })
                      }
                    >
                      重发原回复
                    </Button>
                  </SettingsActions>
                </>
              ) : modal === "conflict" && current && draft ? (
                <>
                  <p>
                    重新载入当前版本号与线上配置。你正在编辑的路由代码保留，可核对后重新启用。
                  </p>
                  <SettingsActions>
                    <Dialog.Close asChild>
                      <Button>取消</Button>
                    </Dialog.Close>
                    <Button
                      onClick={() => {
                        draft.revision = current.revision;
                        setModal(null);
                        touch();
                      }}
                    >
                      更新版本号并保留草稿
                    </Button>
                  </SettingsActions>
                </>
              ) : null}
              </div>
              </SettingsPanel>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    );
  };
}
