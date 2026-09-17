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
    expect(page).toContain("{showMultiBotOnboarding ? (");
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
    // 必须把 profileId 一并返回，否则面板只能去猜，可能写进别的 bot
    expect(handler).toContain("profileId: newBot.profileId");
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
    expect(handler).toContain("sourceBotId: params.sourceBotId");
    expect(handler).toContain('createMode: "clone"');
    // 没选到来源时必须拦下，不能静默建出一个空白 bot
    expect(handler).toContain("if (!params.sourceBotId)");
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

  it("lists every bot as a clone source, defaulting to the main one", () => {
    const page = readPageSource();
    /*
     * 候选必须来自 bot 列表，而不是「当前 / 主 Bot」两个硬编码模式；
     * 否则在某个 bot 页面下打开，其他 bot 根本不会出现在下拉里。
     */
    expect(page).toContain("const cloneSourceChoices = useMemo(");
    expect(page).toContain("[...visibleBots]");
    // 主 bot 排最前 + 打角标
    expect(page).toContain("Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault))");
    expect(page).toContain("setCloneSourceBotId(defaultBot?.id || activeBot?.id || \"\");");
  });

  it("drops the blank-create option from the clone picker", () => {
    const page = readPageSource();
    const panel = readFileSync(
      "src/pages/marketing/agent-onboarding-panel.tsx",
      "utf8",
    );
    /*
     * 只查下拉选项本身，不按整份文件查「空白创建」四个字 ——
     * 那样连注释里提到它都会误判。
     *
     * 注意：首个 bot（账号下还没有任何 bot）仍然走空白创建，那条路没有
     * 可复制的来源，本来就只能空白建。这里限定的是「从其他 Bot 复制」
     * 这个下拉：它的语义是选一个来源 bot，混进「不复制」并不合理。
     */
    const picker = panel.slice(
      panel.indexOf('id="lv-onboarding-clone"'),
      panel.indexOf("</Select>"),
    );
    expect(picker).toContain("cloneOptions.choices.map");
    expect(picker).not.toContain("空白创建");
    // 候选来自 bot 列表，不该再有硬编码的模式项
    expect(page).not.toContain('id: "blank" as const');
    expect(page).not.toContain('id: "clone-main" as const');
  });

  it("hides the sidebar while any onboarding is on screen", () => {
    const page = readPageSource();
    /*
     * 引导页要全屏居中。侧边栏若同时显示，新用户一进来就面对一排
     * 还点不了的入口；配置完成后导航才该出现。
     */
    expect(page).toContain("}) && !showBuddyOnboarding && !showMultiBotOnboarding;");
    // 侧边栏本体与它占的栅格列都要跟着条件走，只藏一个会留下空白列
    expect(page).toContain("{hasSidebarLayout ? (\n                  <aside");
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
   * 这条守的是一个会静默吞掉整个模板配置的回归。
   *
   * 引导面板一旦被放进 key={activeBot.id} 的容器里，创建过程中 refreshBots
   * 让新 bot 进入 visibleBots，activeTabId 的兜底改写就会换掉 activeBot，
   * 于是整棵子树在写配置的半途重挂载：phase 回到 form（表现为「喂完咖啡又
   * 回到创建表单」），effect cleanup 把 cancelled 置 true，人设 / 技能 /
   * 定时任务一个都写不进去，而且没有任何报错。
   */
  it("renders the multi-bot onboarding outside the activeBot-keyed container", () => {
    const page = readPageSource();
    const keyedContainer = 'key={`${activeBot.id}-${activeSection}`}';
    expect(page).toContain(keyedContainer);
    // 引导分支必须出现在 keyed 容器之前，即不被它包住
    expect(page.indexOf("{showMultiBotOnboarding ? (")).toBeLessThan(
      page.indexOf(keyedContainer),
    );
    // 且引导自己的容器不带 activeBot key
    const branch = page.slice(
      page.indexOf("{showMultiBotOnboarding ? ("),
      page.indexOf(keyedContainer),
    );
    expect(branch).toContain('<div className="_lh-claw-bot-panel">');
    expect(branch).not.toContain("key={");
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
