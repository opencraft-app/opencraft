import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readPageSource = () => readFileSync(
  "src/pages/marketing/agent-settings-page.tsx",
  "utf8",
);

/**
 * 多 bot 创建入口的流程守卫。
 *
 * 需求：无论订阅开通还是多 bot，都走同一个「选头像 + 填名字」的配置引导，
 * 不要再先弹一次只问名字的旧弹窗 —— 两者并存会让用户填两次名字。
 */
describe("multi-bot creation goes through the onboarding panel", () => {
  it("opens the onboarding panel instead of the legacy dialog", () => {
    const page = readPageSource();
    // 点「新建 Bot」时进引导，而不是 setShowCreateConfirm(true)
    expect(page).toContain("setShowMultiBotOnboarding(true);");
    /*
     * 只能有一个挂载点，且条件里不含 activeBot。
     *
     * 原来是两条互补分支（`!activeBot` 与 `activeBot ?`），分别放在设置区之前
     * 和设置区内部。创建过程中新 bot 转 running 进入 visibleBots，activeBot
     * 从空变真 → React 卸载一个挂载另一个 → AgentOnboardingPanel 的 phase
     * 重置回 "form"，用户填完表单后又看到一次创建表单（真实故障：新用户订阅
     * 后创建 Bot 要填两遍）。
     */
    expect(page).toContain("{showMultiBotOnboarding && !isModifying && (");
    expect(page).not.toContain("{showMultiBotOnboarding && activeBot ? (");
    expect(page).not.toContain("{showMultiBotOnboarding && !activeBot");
    // 全文件只出现一次挂载条件，避免以后又分叉出第二处
    expect(page.split("{showMultiBotOnboarding && !isModifying && (").length - 1).toBe(1);
    /*
     * 挂载条件不得带 isCreating / showEarlyOnboarding：
     * 这两个量会在本页建出 provisioning 实例后翻转，一翻转分支就消失、
     * 渲染跳到订阅分支，面板被重挂载、配置流程被取消。
     * 互斥性改由订阅分支上的 !showMultiBotOnboarding 单向保证。
     */
    expect(page).toContain("showEarlyOnboarding && !showMultiBotOnboarding && (");
  });

  it("creates the instance from inside the panel, not before it", () => {
    const page = readPageSource();
    /*
     * 实例必须在引导页点「创建」时才建 —— 因为「复制哪个 bot」是用户
     * 在引导页里选的。提前建会导致 clone 模式无法反映用户选择。
     */
    expect(page).toContain("onCreateBot={handleOnboardingCreateBot}");    expect(page).toContain("const handleOnboardingCreateBot");
  });

  it("does not navigate away while the panel is still writing config", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleOnboardingCreateBot"),
      page.indexOf("const handleConfirmCreate"),
    );
    expect(handler.length).toBeGreaterThan(0);
    /*
     * 跳 ?creating= 会让引导面板卸载，配置写到一半断掉。
     * 旧的 createBotAndNavigate 会跳转，这个新回调不能跳。
     */
    expect(handler).not.toContain("navigate(");
    expect(handler).toContain('recoveryUrl.searchParams.set("bot", newBot.id)');
    expect(handler).toContain('window.history.replaceState(window.history.state, "", recoveryUrl)');
    /*
     * 必须把 profileId 一并返回，否则面板只能去猜，可能写进别的 bot。
     * 现在先落到 createdProfileId 中间变量上（要先过 "main" 守卫再返回），
     * 所以断言取值来源与最终返回两处。
     */
    expect(handler).toContain("const createdProfileId = newBot.profileId");
    expect(handler).toContain("profileId: createdProfileId");
  });

  it("clones from the bot the user picked, by id", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleOnboardingCreateBot"),
      page.indexOf("const handleConfirmCreate"),
    );
    /*
     * 从「模式」（复制当前 / 复制主 Bot）改成「按 id 选 bot」——
     * 模式只能表达两个来源，用户在 A bot 下想复制 B bot 就没法表达。
     */
    expect(handler).toContain("sourceBotId: isBlank ? undefined : params.sourceBotId");
    expect(handler).toContain('createMode: isBlank ? "blank" : "clone"');
  });

  it("keeps the quota gate on the new path", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleOnboardingCreateBot"),
      page.indexOf("const handleConfirmCreate"),
    );
    // 换了入口不等于放行额度
    expect(handler).toContain("if (createLimitMessage)");
  });

  it("lands on the newly created bot's overview after setup finishes", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleBuddyCreated"),
      page.indexOf("const isFirstBotCreation"),
    );
    /*
     * 配置完成后必须切到刚建的那个 bot，否则用户停在创建前那个 bot 的
     * 总览页，看不到自己刚建的东西。
     *
     * 这里要求同时写 activeTabId 和 URL 的 ?bot=：新 bot 此刻多半还在
     * provisioning，会被 visibleBots 过滤掉，只设 activeTabId 会被
     * 「指向的 bot 不在列表里就回落第一个」那条兜底改回去；URL 上的
     * requestedBotId 优先级更高，能在 refreshBots 之后把状态拉正。
     */
    expect(handler).toContain("setActiveTabId(createdBotId);");
    expect(handler).toContain("AGENT_SECTION_PATH_BY_ID.overview, createdBotId");
    // 回调签名要能接住 botId
    expect(page).toContain("const handleBuddyCreated = useCallback((createdBotId?: string)");
    expect(page).toContain("handleBuddyCreated(createdBotId);");
  });

  /*
   * 这条守的是「静默写脏主 bot」。
   *
   * addBot 在后端没返回 profile_id 时会兜底成 "main"（agent-context 里的
   * `created.profileId ?? "main"`），而 "main" 正是主 bot 的 profile。多 bot
   * 场景下若照此往下走，模板的技能与定时任务会全部写进主 bot：新 bot 里空
   * 空如也，主 bot 那边莫名多出几条，且全程无报错 —— 正是之前真实发生过的
   * 现象。宁可报错让用户重试，也不能写错目标。
   */
  it("refuses to write the setup plan when the profile id is unresolved", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleOnboardingCreateBot"),
      page.indexOf("const handleConfirmCreate"),
    );
    expect(handler).toContain('createdProfileId === "main"');
    // activeBot 存在 = 在已有 bot 之上再建一个，它的 profile 不可能是 main
    expect(handler).toContain("if (activeBot && (!createdProfileId");
    expect(handler).toContain("return null;");
  });

  it("lists every bot as a clone source", () => {
    const page = readPageSource();
    /*
     * 候选必须来自 bot 列表，而不是「当前 / 主 Bot」两个硬编码模式；
     * 否则在某个 bot 页面下打开，其他 bot 根本不会出现在下拉里。
     */
    expect(page).toContain("const cloneSourceChoices = useMemo(");
    expect(page).toContain("[...visibleBots]");
    // 主 bot 排最前 + 打角标
    expect(page).toContain("Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault))");
    // 默认空白创建，不预选任何来源 bot
    expect(page).toContain('setCloneSourceBotId("");');
  });

  it("offers blank creation as the default, with bots listed as clone sources", () => {
    const page = readPageSource();
    const panel = readFileSync(
      "src/pages/marketing/agent-onboarding-panel.tsx",
      "utf8",
    );
    /*
     * 「空白创建」是默认项：复制会把来源 bot 的人设、技能、记忆一并带过来，
     * 属于进阶用法；新建的默认预期是拿到一个干净的 bot。
     *
     * 空串代表空白创建，但 Radix Select 不接受空串作为 item value
     * （它把空串当「未选中」），所以界面层用哨兵值顶一下，读写时转换。
     */
    const picker = panel.slice(
      panel.indexOf("<Select\n"),
      panel.indexOf("</Select>"),
    );
    expect(picker).toContain("空白创建");
    expect(picker).toContain("cloneOptions.choices.map");
    expect(panel).toContain('const BLANK_CREATE_VALUE = "__blank__";');
    // 哨兵值必须双向转换，否则空白创建会被当成一个真实的 botId 传下去
    expect(picker).toContain("cloneOptions.value || BLANK_CREATE_VALUE");
    expect(picker).toContain('next === BLANK_CREATE_VALUE ? "" : next');

    // 打开创建页时默认就是空白创建（空串）
    expect(page).toContain('setCloneSourceBotId("");');

    // 候选仍来自 bot 列表，不该回到「复制当前 / 复制主 Bot」那套硬编码模式
    expect(page).not.toContain('id: "clone-main" as const');
  });

  it("maps an empty source to blank create instead of erroring out", () => {
    const page = readPageSource();
    const handler = page.slice(
      page.indexOf("const handleOnboardingCreateBot"),
      page.indexOf("const handleConfirmCreate"),
    );
    /*
     * 空 sourceBotId 是合法的默认值，必须走 createMode: "blank"，
     * 而不是像之前那样报「找不到可克隆的 Bot」。
     */
    expect(handler).toContain("const isBlank = !params.sourceBotId;");
    expect(handler).toContain('createMode: isBlank ? "blank" : "clone"');
    expect(handler).toContain("sourceBotId: isBlank ? undefined : params.sourceBotId");
    expect(handler).not.toContain("找不到可克隆的 Bot，请稍后重试。");
    // 额度校验不能因此被绕过
    expect(handler).toContain("if (createLimitMessage)");
  });

  it("only preserves the inherited persona when actually cloning", () => {
    const panel = readFileSync(
      "src/pages/marketing/agent-onboarding-panel.tsx",
      "utf8",
    );
    /*
     * 空白创建没有可继承的人设，读 SOUL 只会拿到空值、白等一次沙箱命令；
     * 选了模板则该由模板覆盖。两种情况都不进保留分支。
     */
    expect(panel).toContain("const shouldPreserveSoul = !pendingSetup.template");
    expect(panel).toContain("preserveSoul: !template && Boolean(runtimeRef.current.cloneValue)");
    expect(panel).toContain("&& pendingSetup.preserveSoul;");
    expect(panel).toContain("if (shouldPreserveSoul) {");
  });

  it("hides the sidebar while any onboarding is on screen", () => {
    const page = readPageSource();
    /*
     * 引导页要全屏居中。侧边栏若同时显示，新用户一进来就面对一排
     * 还点不了的入口；配置完成后导航才该出现。
     */
    expect(page).toContain("}) && !showBuddyOnboarding && !showMultiBotOnboarding;");
    // 侧边栏本体与它占的栅格列都要跟着条件走，只藏一个会留下空白列
    expect(page).toMatch(/\{hasSidebarLayout \? \(\s*<AgentSidebar>/);
    expect(page).toContain('hasSidebarLayout && "lg:grid-cols-[248px_minmax(0,1fr)]"');
    // 没有侧边栏时内容区自己居中
    expect(page).toContain('hasSidebarLayout ? "lg:col-start-2" : "mx-auto w-full max-w-[860px]"');
  });

  it("keeps clone options collapsed behind an Advanced toggle", () => {
    const panel = readFileSync(
      "src/pages/marketing/agent-onboarding-panel.tsx",
      "utf8",
    );
    // 主路径是「起个名字就走」，复制来源不该平铺占位
    expect(panel).toContain("const [advancedOpen, setAdvancedOpen] = useState(false);");
    expect(panel).toContain("aria-expanded={advancedOpen}");
    // 折叠内用项目统一的 Select 组件（同模型 tab），不是原生 <select>
    expect(panel).toContain('id="lv-onboarding-clone"');
    expect(panel).toContain("<SelectTrigger");
    expect(panel).not.toContain("<select");
  });

  /*
   * 订阅路径：实例已由后端随订阅建好（进页面就是 running），页面上有三个
   * effect 会判定「创建已完成」—— 两个关 loading、一个把 ?creating= 改写成
   * ?bot=。它们不知道引导表单正在进行，一跑就把引导面板卸载。
   * 真实故障：点「育儿参谋」模板后没进创建流程，直接回到了表单。
   *
   * 这里只守「三处都让位 + 锁会复位」这个结构约束；
   * 真正的行为验证在 agent-subscribe-template-flow.test.tsx（真实渲染），
   * 因为文本断言只能证明代码长这样，证明不了行为对 —— 同一现象我靠文本
   * 断言修过两次都没修对。
   */
  it("locks the creating state while the onboarding panel is mounted", () => {
    const page = readPageSource();

    // 引导一旦可见就上锁（ref 而非 state：要同一帧生效，避免 effect 抢跑）
    expect(page).toContain("if (isOnboardingVisible) onboardingLockRef.current = true;");
    // 三个会关 loading / 改 URL 的 effect 都必须让位
    expect(page.split("if (onboardingLockRef.current) return;").length - 1).toBe(4);
    // 完成后要复位，否则后续创建态永远退不出 loading
    expect(page).toContain("onboardingLockRef.current = false;");
  });

  /*
   * 这条守的是一个会静默吞掉整个模板配置的回归。
   *
   * 引导面板只要在创建过程中被重挂载，phase 就回到 form（表现为「填完表单又
   * 回到创建表单」），effect cleanup 把 cancelled 置 true，人设 / 技能 /
   * 定时任务一个都写不进去，而且没有任何报错。
   *
   * 两种触发方式都要守住：
   *   1. 被放进 key={activeBot.id} 的容器里 —— activeTabId 兜底改写会换 key
   *   2. 挂载条件里含 activeBot —— 新 bot 转 running 进入 visibleBots 时条件翻转
   * 第 2 种就是「新用户订阅后要填两遍表单」的成因。
   */
  it("keeps a single onboarding mount point that never remounts mid-flight", () => {
    const page = readPageSource();
    const keyedContainer = 'key={`${activeBot.id}-${activeSection}`}';
    const mountCondition = "{showMultiBotOnboarding && !isModifying && (";
    expect(page).toContain(keyedContainer);
    expect(page).toContain(mountCondition);
    // 挂载点必须在 keyed 容器之前，即不被它包住
    expect(page.indexOf(mountCondition)).toBeLessThan(page.indexOf(keyedContainer));
    // 挂载条件不得依赖 activeBot（会在创建途中翻转）
    expect(mountCondition).not.toContain("activeBot");
    /*
     * 面板自己那一小段容器不带 key。
     *
     * 只截到 <AgentOnboardingPanel 开标签为止 —— 不能截到 keyedContainer，
     * 那中间跨越了整个设置区，必然包含其它无关的 key={...}。
     */
    const mountStart = page.indexOf(mountCondition);
    const wrapper = page.slice(mountStart, page.indexOf("<AgentOnboardingPanel", mountStart));
    expect(wrapper).toContain("_lh-claw-bot-panel__cards");
    expect(wrapper).not.toContain("key={");
  });

  it("shows the setup checklist from the moment the coffee starts", () => {
    const panel = readFileSync(
      "src/pages/marketing/agent-onboarding-panel.tsx",
      "utf8",
    );
    /*
     * 建实例 + 等沙箱是整个流程最慢的一截。计划不依赖 botId，必须在进
     * creating 的同一帧就铺出来，否则用户在最需要反馈的几分钟里只看到
     * 一只咖啡杯，完全看不到「安装技能」这类步骤。
     */
    const handlerStart = panel.indexOf("const handleCreate = useCallback(");
    const handler = panel.slice(
      handlerStart,
      panel.indexOf("useEffect(() => {", handlerStart),
    );
    expect(handler).toContain("buildBuddySetupPlan({");
    expect(handler).toContain('status: "pending" as const');
    // 铺清单必须发生在切 phase 之前
    expect(handler.indexOf("setSteps(")).toBeLessThan(
      handler.indexOf('setPhase("creating")'),
    );
  });
});
