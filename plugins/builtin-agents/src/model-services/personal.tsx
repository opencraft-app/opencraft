import { useEffect, useRef, useState, type ComponentType } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  SettingsButton,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import { BrandMark } from "./brand-mark";
import { NavigationList, NavigationItem } from "@opencraft/design-system-web/navigation";

export interface PersonalModelConnection {
  kind?: "subscription" | "api-key" | "platform";
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  enabled: boolean;
  owned: boolean;
  scope: "personal" | "team";
  revision: number;
  template: boolean;
  models: { id: string; name: string; enabled: boolean }[];
}
export interface PersonalModelsDocument {
  subscriptionAvailable?: boolean;
  actor: string;
  period: string;
  usedTokens: number;
  heldTokens: number;
  canManage: boolean;
  limit: { monthlyTokens: number; requestTokens: number; concurrency: number } | null;
  personalLimit: { monthlyTokens: number | null; revision: number };
  directory: PersonalModelConnection[];
}
const path = "/__opencraft_model_gateway";
const errors: Record<string, string> = {
  gateway_revision_conflict: "设置已在其他位置修改。请刷新后重试，当前输入已保留。",
  gateway_identity_changed: "登录状态已改变，请重新打开设置。",
  gateway_endpoint_not_approved: "这个服务或模型已不可用，请重新选择。",
  gateway_contribution_forbidden: "无法修改这条连接，请刷新后重试。",
  gateway_sharing_consent_required: "请确认是否允许其他人使用你的额度。",
};
export async function readPersonalModels(fetcher: typeof fetch = globalThis.fetch): Promise<PersonalModelsDocument> {
  const response = await fetcher(path, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw Error("无法读取我的模型，请稍后重试。");
  const document = await response.json();
  if (typeof document.actor !== "string" || !Array.isArray(document.directory) || !document.personalLimit)
    throw Error("我的模型暂不可用。");
  return document;
}
export function createPersonalModelServicesView(
  fetcher: typeof fetch = globalThis.fetch,
  PlatformView?: ComponentType<ExtensionSettingsViewProps>,
) {
  return function PersonalModelServicesView(_props: ExtensionSettingsViewProps) {
    const [managePlatform, setManagePlatform] = useState(false);
    const [doc, setDoc] = useState<PersonalModelsDocument | null>(null),
      [selected, setSelected] = useState<string | null>(null);
    const [adding, setAdding] = useState(false),
      [name, setName] = useState(""),
      [templateId, setTemplateId] = useState(""),
      [modelId, setModelId] = useState(""),
      [key, setKey] = useState("");
    const [busy, setBusy] = useState(false),
      [error, setError] = useState(""),
      [message, setMessage] = useState(""),
      [query, setQuery] = useState("");
    const [scopeOpen, setScopeOpen] = useState(false),
      [scope, setScope] = useState<"personal" | "team">("personal"),
      [consent, setConsent] = useState(false);
    const [connectionType, setConnectionType] = useState("api-key");
    const [login, setLogin] = useState<{
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
    } | null>(null);
    const [limitDraft, setLimitDraft] = useState(""),
      [limitOpen, setLimitOpen] = useState(false);
    const lifetime = useRef(0),
      identity = useRef<string | null>(null),
      pending = useRef(false);
    const apply = (next: PersonalModelsDocument) => {
      if (identity.current !== null && identity.current !== next.actor) {
        setLogin(null);
        setKey("");
        setName("");
        setAdding(false);
        setSelected(null);
        setScopeOpen(false);
        setLimitOpen(false);
      }
      identity.current = next.actor;
      setDoc(next);
    };
    const refresh = async () => {
      const epoch = lifetime.current;
      try {
        const next = await readPersonalModels(fetcher);
        if (epoch === lifetime.current) {
          apply(next);
          setError("");
        }
      } catch (e) {
        if (epoch === lifetime.current) setError((e as Error).message);
      }
    };
    useEffect(() => {
      void refresh();
      return () => {
        lifetime.current++;
      };
    }, []);
    const write = async (body: Record<string, unknown>, success?: (result: any) => void) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      setMessage("");
      const epoch = lifetime.current,
        actor = identity.current;
      try {
        const response = await fetcher(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw Error(errors[result.error] ?? "未能保存，请检查输入并重试。");
        const next = await readPersonalModels(fetcher);
        if (epoch !== lifetime.current) return;
        apply(next);
        if (next.actor !== actor) {
          setError("登录状态已改变，请重新检查设置。");
          return;
        }
        success?.(result);
        setMessage(
          body.action === "subscription"
            ? result.status === "complete"
              ? "订阅已连接"
              : result.status === "pending"
                ? "等待你完成登录"
                : ""
            : "已保存",
        );
      } catch (e) {
        if (epoch === lifetime.current) setError((e as Error).message);
      } finally {
        pending.current = false;
        if (epoch === lifetime.current) setBusy(false);
      }
    };
    const subscriptionResult = (result: any) => {
      if (result.status === "complete") {
        setLogin(null);
        setSelected(result.providerId);
        setAdding(false);
      } else if (result.login) setLogin(result.login);
      else if (result.status === "error") {
        setLogin(null);
        setError("登录未完成，请重新登录。");
      }
    };
    useEffect(() => {
      if (!login) return;
      const timer = setInterval(() => {
        if (Date.now() >= login.expiresAt) {
          setLogin(null);
          setError("登录已过期，请重新登录。");
          return;
        }
        void write({ action: "subscription", operation: "poll", sessionId: login.sessionId }, subscriptionResult);
      }, 3000);
      return () => clearInterval(timer);
    }, [login]);
    const connections = doc?.directory ?? [],
      templates = connections.filter((c) => c.template && c.models.length);
    const connection = connections.find((c) => c.id === selected) ?? connections.find((c) => c.owned) ?? connections[0];
    const template = templates.find((c) => c.id === templateId) ?? templates[0],
      model = template?.models.find((m) => m.id === modelId) ?? template?.models[0];
    const visible = connections.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
    const pick = (id: string) => {
      setSelected(id);
      setAdding(false);
      setScopeOpen(false);
      setError("");
      setMessage("");
    };
    const add = () => {
      setAdding(true);
      setScopeOpen(false);
      setError("");
      setMessage("");
    };
    const row = (c: PersonalModelConnection) => (
      <NavigationItem
        key={c.id}
        className="model-services-personal__connection"
        aria-current={!adding && connection?.id === c.id ? "page" : undefined}
        onClick={() => pick(c.id)}
      >
        <BrandMark kind="provider" id={c.id} size={24} />
        <span>
          {c.name}
          <small>{c.owned ? (c.scope === "personal" ? "仅自己" : "已开放使用") : "平台提供"}</small>
        </span>
      </NavigationItem>
    );
    if (managePlatform && doc?.canManage && PlatformView)
      return (
        <div className="model-services-personal__platform">
          <SettingsButton variant="quiet" onClick={() => setManagePlatform(false)}>
            返回我的模型
          </SettingsButton>
          <PlatformView {..._props} />
        </div>
      );
    return (
      <div className="model-services">
        <SettingsPageHeader title="模型服务" />
        <aside className="model-services__navigation" aria-label="模型连接">
          <div className="model-services__search">
            <SettingsTextInput
              aria-label="搜索连接"
              placeholder="搜索连接"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <SettingsButton
              aria-label="添加我的连接"
              disabled={!doc || busy || (!templates.length && !doc.subscriptionAvailable)}
              onClick={add}
            >
              添加
            </SettingsButton>
          </div>
          <details open>
            <summary className="ui-native-disclosure">我的模型</summary>
            <NavigationList label="我的模型">{visible.filter((c) => c.owned).map(row)}</NavigationList>
            {doc && !connections.some((c) => c.owned) ? (
              <p className="model-services__muted">还没有添加自己的连接</p>
            ) : null}
          </details>
          <details open>
            <summary className="ui-native-disclosure">平台提供</summary>
            <NavigationList label="平台模型">{visible.filter((c) => !c.owned).map(row)}</NavigationList>
          </details>
          {doc?.canManage && PlatformView ? (
            <SettingsButton variant="quiet" disabled={busy} onClick={() => setManagePlatform(true)}>
              管理平台连接
            </SettingsButton>
          ) : null}
        </aside>
        <div className="model-services__main">
          <div className="model-services__mobile-select">
            <SettingsSelect
              aria-label="选择连接"
              value={adding ? "" : (connection?.id ?? "")}
              onChange={(e) => pick(e.target.value)}
            >
              <option value="">选择连接</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SettingsSelect>
            <SettingsButton
              aria-label="添加我的连接"
              disabled={!doc || busy || (!templates.length && !doc.subscriptionAvailable)}
              onClick={add}
            >
              添加
            </SettingsButton>
          </div>
          <div className="model-services__detail">
            {!doc ? (
              <SettingsNotice>
                {error || "正在读取模型连接…"}
                <SettingsButton disabled={busy} onClick={() => void refresh()}>
                  重试
                </SettingsButton>
              </SettingsNotice>
            ) : null}
            {doc && adding ? (
              <section className="model-services__config" aria-label="添加我的连接">
                <header>
                  <h2>添加我的连接</h2>
                </header>
                {doc.subscriptionAvailable ? (
                  <div className="model-services__row">
                    <label htmlFor="personal-model-type">连接方式</label>
                    <SettingsSelect
                      id="personal-model-type"
                      value={connectionType}
                      disabled={busy || !!login}
                      onChange={(e) => setConnectionType(e.target.value)}
                    >
                      <option value="api-key">填写 API key</option>
                      <option value="subscription">登录 Codex 订阅</option>
                    </SettingsSelect>
                  </div>
                ) : null}
                {connectionType === "subscription" && doc.subscriptionAvailable ? (
                  <>
                    <div className="model-services__row">
                      <div>
                        <label>我的 Codex 订阅</label>
                        <p>仅你和帮你办事的助手使用，订阅可用额度以服务商为准。</p>
                      </div>
                    </div>
                    {login ? (
                      <SettingsNotice>
                        <p>
                          打开登录页面，输入验证码：<strong>{login.userCode}</strong>
                        </p>
                        <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
                          打开登录页面
                        </a>
                        <p>完成登录后会自动连接。</p>
                      </SettingsNotice>
                    ) : null}
                    <div className="model-services__connection-actions">
                      <SettingsButton
                        disabled={busy}
                        onClick={() => {
                          if (login)
                            void write(
                              { action: "subscription", operation: "cancel", sessionId: login.sessionId },
                              () => {
                                setLogin(null);
                                setAdding(false);
                              },
                            );
                          else setAdding(false);
                        }}
                      >
                        取消
                      </SettingsButton>
                      <SettingsButton
                        variant="primary"
                        disabled={busy || !!login}
                        onClick={() => void write({ action: "subscription", operation: "start" }, subscriptionResult)}
                      >
                        登录并连接
                      </SettingsButton>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-name">名称</label>
                      <SettingsTextInput
                        id="personal-model-name"
                        value={name}
                        disabled={busy}
                        placeholder="例如：我的编程模型"
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-service">服务</label>
                      <SettingsSelect
                        id="personal-model-service"
                        disabled={busy}
                        value={template?.id ?? ""}
                        onChange={(e) => {
                          setTemplateId(e.target.value);
                          setModelId("");
                          setKey("");
                        }}
                      >
                        {templates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-model">模型</label>
                      <SettingsSelect
                        id="personal-model-model"
                        disabled={busy}
                        value={model?.id ?? ""}
                        onChange={(e) => setModelId(e.target.value)}
                      >
                        {template?.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <div className="model-services__row">
                      <div>
                        <label htmlFor="personal-model-key">API key</label>
                        <p>{template?.baseUrl}</p>
                      </div>
                      <SettingsTextInput
                        id="personal-model-key"
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={key}
                        disabled={busy}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </div>
                    <div className="model-services__row">
                      <div>
                        <label>可供使用</label>
                        <p>你和帮你办事的助手可以用，别人的任务不能用。</p>
                      </div>
                      <span>仅自己</span>
                    </div>
                    <div className="model-services__connection-actions">
                      <SettingsButton
                        disabled={busy}
                        onClick={() => {
                          setAdding(false);
                          setKey("");
                        }}
                      >
                        取消
                      </SettingsButton>
                      <SettingsButton
                        variant="primary"
                        disabled={busy || !name.trim() || !key.trim() || !template || !model}
                        onClick={() =>
                          void write(
                            {
                              action: "contribute",
                              name,
                              apiKey: key,
                              baseUrl: template!.baseUrl,
                              protocol: template!.protocol,
                              model: model!.id,
                              scope: "personal",
                            },
                            (result) => {
                              setKey("");
                              setName("");
                              setSelected(result.providerId);
                              setAdding(false);
                            },
                          )
                        }
                      >
                        保存
                      </SettingsButton>
                    </div>
                  </>
                )}
              </section>
            ) : doc && connection ? (
              <>
                <section className="model-services__config" aria-label="连接设置">
                  <header>
                    <BrandMark kind="provider" id={connection.id} size={24} />
                    <h2>{connection.name}</h2>
                  </header>
                  <div className="model-services__connection-summary">
                    <span>
                      {connection.owned ? "连接已配置" : "平台提供"} · {connection.enabled ? "已启用" : "未启用"}
                    </span>
                  </div>
                  {connection.owned ? (
                    <div className="model-services__row">
                      <div>
                        <label>可供使用</label>
                        {connection.scope === "personal" ? <p>你和帮你办事的助手可以用，别人的任务不能用。</p> : null}
                      </div>
                      <div className="model-services__row-end">
                        <span>{connection.scope === "personal" ? "仅自己" : "此平台的用户"}</span>
                        {connection.kind !== "subscription" ? (
                          <Popover.Root
                            open={scopeOpen}
                            onOpenChange={(open) => {
                              if (busy) return;
                              setScopeOpen(open);
                              if (open) {
                                setScope(connection.scope);
                                setConsent(false);
                              }
                            }}
                          >
                            <Popover.Trigger asChild>
                              <SettingsButton variant="quiet" disabled={busy}>
                                更改
                              </SettingsButton>
                            </Popover.Trigger>
                            <Popover.Portal>
                              <Popover.Content
                                className="model-services-actions model-services-personal__scope"
                                align="end"
                                sideOffset={6}
                                collisionPadding={12}
                                aria-label="谁可以使用"
                              >
                                <strong>谁可以使用</strong>
                                <SettingsSelect
                                  aria-label="使用范围"
                                  value={scope}
                                  disabled={busy}
                                  onChange={(e) => {
                                    setScope(e.target.value as "personal" | "team");
                                    setConsent(false);
                                  }}
                                >
                                  <option value="personal">仅自己</option>
                                  <option value="team">此平台的用户</option>
                                </SettingsSelect>
                                {scope === "team" ? (
                                  <>
                                    <p>别人也能选择这条连接，上游 API 费用仍由你的 key 所属账户承担。</p>
                                    <div className="model-services__row">
                                      <span>允许其他人使用</span>
                                      <SettingsSwitch
                                        label="允许其他人使用"
                                        checked={consent}
                                        disabled={busy}
                                        onCheckedChange={setConsent}
                                      />
                                    </div>
                                  </>
                                ) : (
                                  <p>你和帮你办事的助手可以用，别人的任务不能用。</p>
                                )}
                                <div className="model-services__connection-actions">
                                  <SettingsButton disabled={busy} onClick={() => setScopeOpen(false)}>
                                    取消
                                  </SettingsButton>
                                  <SettingsButton
                                    variant="primary"
                                    disabled={busy || scope === connection.scope || (scope === "team" && !consent)}
                                    onClick={() =>
                                      void write(
                                        {
                                          action: "scope",
                                          provider: connection.id,
                                          scope,
                                          revision: connection.revision,
                                          shareWithTeam: scope === "team",
                                        },
                                        () => setScopeOpen(false),
                                      )
                                    }
                                  >
                                    保存
                                  </SettingsButton>
                                </div>
                                {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
                              </Popover.Content>
                            </Popover.Portal>
                          </Popover.Root>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </section>
                <section className="model-services__models" aria-label="模型列表">
                  <div className="model-services__model-heading">
                    <h3>模型</h3>
                  </div>
                  {connection.models.map((m) => (
                    <div className="model-services__model" key={m.id}>
                      <BrandMark kind="model" id={m.id} size={32} />
                      <div>
                        <strong>{m.name}</strong>
                        <small>{m.id}</small>
                      </div>
                      <span>{connection.enabled && m.enabled ? "可用" : "未启用"}</span>
                    </div>
                  ))}
                </section>
                <details className="model-services__advanced">
                  <summary className="ui-native-disclosure">高级设置</summary>
                  <div className="model-services__row">
                    <span>{connection.kind === "subscription" ? "连接方式" : "服务地址"}</span>
                    <span>{connection.kind === "subscription" ? "订阅登录 · 仅自己" : connection.baseUrl}</span>
                  </div>
                  {connection.owned ? (
                    <div className="model-services__row">
                      <div>
                        <label>停用连接</label>
                        <p>停止后续调用，已经发出的请求仍会结算。</p>
                      </div>
                      <SettingsButton
                        disabled={busy}
                        onClick={() =>
                          void write({ action: "withdraw", provider: connection.id }, () => setSelected(null))
                        }
                      >
                        停用
                      </SettingsButton>
                    </div>
                  ) : null}
                </details>
              </>
            ) : doc ? (
              <SettingsNotice>暂时没有可用的模型服务。</SettingsNotice>
            ) : null}
            {doc && !adding ? (
              <section className="model-services__config" aria-label="我的用量">
                <header>
                  <h3>我的连接用量</h3>
                </header>
                <div className="model-services__row">
                  <span>本月已用</span>
                  <span className="model-services__row-end">{doc.usedTokens.toLocaleString()} tokens</span>
                </div>
                {doc.heldTokens > 0 ? (
                  <div className="model-services__row">
                    <span>处理中或待确认</span>
                    <span className="model-services__row-end">{doc.heldTokens.toLocaleString()} tokens</span>
                  </div>
                ) : null}
                <div className="model-services__row">
                  <div>
                    <label>用量限制</label>
                    <p>按 token 控制后续请求，不是金额上限；单次请求可能超过预留量。</p>
                  </div>
                  <div className="model-services__row-end">
                    <span>
                      {doc.limit
                        ? `${Math.min(doc.limit.monthlyTokens, doc.personalLimit.monthlyTokens ?? Infinity).toLocaleString()} tokens / 月`
                        : "平台尚未配置额度"}
                    </span>
                    <SettingsButton
                      variant="quiet"
                      disabled={busy || !doc.limit}
                      onClick={() => {
                        setLimitDraft(String(doc.personalLimit.monthlyTokens ?? doc.limit?.monthlyTokens ?? 0));
                        setLimitOpen(!limitOpen);
                      }}
                    >
                      更改
                    </SettingsButton>
                  </div>
                </div>
                {limitOpen ? (
                  <div className="model-services__row">
                    <label htmlFor="personal-model-limit">每月最多使用</label>
                    <div>
                      <SettingsTextInput
                        id="personal-model-limit"
                        type="number"
                        min={0}
                        step={1}
                        value={limitDraft}
                        disabled={busy}
                        onChange={(e) => setLimitDraft(e.target.value)}
                      />
                      <div className="model-services__connection-actions">
                        <SettingsButton disabled={busy} onClick={() => setLimitOpen(false)}>
                          取消
                        </SettingsButton>
                        <SettingsButton
                          disabled={
                            busy ||
                            limitDraft.trim() === "" ||
                            !Number.isSafeInteger(Number(limitDraft)) ||
                            Number(limitDraft) < 0
                          }
                          onClick={() =>
                            void write(
                              {
                                action: "personalLimit",
                                monthlyTokens: Number(limitDraft),
                                revision: doc.personalLimit.revision,
                              },
                              () => setLimitOpen(false),
                            )
                          }
                        >
                          保存限制
                        </SettingsButton>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
            {error && doc && !scopeOpen ? (
              <SettingsNotice tone="error">
                {error}
                <SettingsButton disabled={busy} onClick={() => void refresh()}>
                  刷新
                </SettingsButton>
              </SettingsNotice>
            ) : null}
            <p className="model-services__status" role="status">
              {busy ? "正在保存…" : message}
            </p>
          </div>
        </div>
      </div>
    );
  };
}
