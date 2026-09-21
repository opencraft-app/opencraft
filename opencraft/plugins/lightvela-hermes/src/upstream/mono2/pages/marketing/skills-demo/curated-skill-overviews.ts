// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { CURATED_SKILL_OVERVIEWS_ZH } from "./curated-skill-overviews.zh";
import { CURATED_SKILL_OVERVIEWS_ID } from "./curated-skill-overviews.id";
import { CURATED_SKILL_OVERVIEWS_ES } from "./curated-skill-overviews.es";
import { CURATED_SKILL_OVERVIEWS_JA } from "./curated-skill-overviews.ja";
import { CURATED_SKILL_OVERVIEWS_KO } from "./curated-skill-overviews.ko";

export type CuratedSkillBullet = {
  title: string;
  description: string;
};

export type CuratedSkillOverview = {
  overview: readonly [string, string];
  whoShouldUse: readonly CuratedSkillBullet[];
  problemsItSolves: readonly CuratedSkillBullet[];
  keyCapabilities: readonly CuratedSkillBullet[];
  basicUsage: string;
  examplePrompt: string;
};

export type CuratedSkillOverviewLocale = "en-US" | "zh-CN" | "id-ID" | "es" | "ja-JP" | "ko-KR";

function overview(
  firstParagraph: string,
  secondParagraph: string,
  whoShouldUse: readonly CuratedSkillBullet[],
  problemsItSolves: readonly CuratedSkillBullet[],
  keyCapabilities: readonly CuratedSkillBullet[],
  basicUsage: string,
  examplePrompt: string,
): CuratedSkillOverview {
  return {
    overview: [firstParagraph, secondParagraph],
    whoShouldUse,
    problemsItSolves,
    keyCapabilities,
    basicUsage,
    examplePrompt,
  };
}

const audience = (first: string, second: string, third: string): readonly CuratedSkillBullet[] => [
  { title: "Analysts", description: first },
  { title: "Operators", description: second },
  { title: "Decision makers", description: third },
];

const capabilities = (first: string, second: string, third: string, fourth: string): readonly CuratedSkillBullet[] => [
  { title: "Structured analysis", description: first },
  { title: "Context-aware guidance", description: second },
  { title: "Clear outputs", description: third },
  { title: "Repeatable workflow", description: fourth },
];

export const CURATED_SKILL_OVERVIEWS: Readonly<Record<string, CuratedSkillOverview>> = {
  "mattpocock/skills/teach": overview(
    "Teach turns a topic into a persistent learning workspace with short, self-contained lessons that build across sessions.",
    "Provide the reason you want to learn, the topic, and any preferences or constraints. It grounds lessons in trusted resources, adds citations, and uses retrieval practice so progress continues instead of restarting each time.",
    [
      { title: "People learning over time", description: "They want a course that continues across multiple sessions instead of a one-off explanation." },
      { title: "New team members", description: "They need a structured way to learn a codebase, framework, process, or domain." },
      { title: "Hands-on learners", description: "They want short lessons, practice, and records of what they have demonstrated." },
    ],
    [
      { title: "Scattered learning", description: "Keeps the mission, sources, lessons, and learning records together in one workspace." },
      { title: "Untrusted explanations", description: "Encourages high-trust resources and citations before lessons are written." },
      { title: "Fluency without retention", description: "Uses retrieval practice, spacing, and feedback to support long-term storage strength." },
    ],
    [
      { title: "Persistent workspace", description: "Maintains a mission, resources, lessons, references, and learning records across sessions." },
      { title: "Source-grounded lessons", description: "Builds lessons from researched resources and links claims back to the sources." },
      { title: "Interactive practice", description: "Uses quizzes or real-world steps with feedback to make learning durable." },
      { title: "Adaptive progression", description: "Uses the mission and learning records to choose a suitably challenging next lesson." },
    ],
    "Run Teach in a dedicated learning workspace, state what you want to learn and why, then continue with prompts such as next lesson. Keep the workspace separate from the product repository so the course can accumulate safely.",
    "Teach me the fundamentals of this codebase over several short lessons. Start by interviewing me about my mission, gather high-trust resources, and do not write the first lesson until the sources are recorded.",
  ),
  "mattpocock/skills/grill-me": overview(
    "Grill Me turns a rough plan or design into a focused interview that exposes assumptions, missing decisions, and risks before implementation.",
    "Provide the plan, design, or idea and ask to be grilled. The questioning is meant to sharpen your own thinking, not to replace your decision, so answer each question and use the discovered gaps to improve the plan.",
    [
      { title: "Product builders", description: "They want to pressure-test an idea before investing in implementation." },
      { title: "Design and architecture reviewers", description: "They need a structured way to uncover missing decisions and edge cases." },
      { title: "Teams preparing execution", description: "They want shared understanding before a plan becomes work." },
    ],
    [
      { title: "Unstated assumptions", description: "Surfaces decisions that are implicit in the current plan." },
      { title: "Late discovery", description: "Finds edge cases and unanswered questions before they become expensive rework." },
      { title: "False confidence", description: "Makes the plan earn approval through clear answers rather than momentum." },
    ],
    [
      { title: "Systematic questioning", description: "Interviews the plan across its important product, design, and implementation dimensions." },
      { title: "Decision-tree depth", description: "Follows answers into the next relevant branch instead of stopping at surface-level questions." },
      { title: "Codebase awareness", description: "Can use available code context to answer questions and reduce repeated back-and-forth." },
      { title: "Pre-build validation", description: "Creates a clearer shared understanding before implementation begins." },
    ],
    "Invoke Grill Me with the plan or design you want to sharpen. Answer the questions directly, record any decisions that change, and revise the plan before asking for implementation.",
    "Grill me on this plan. Ask one focused question at a time, follow important answers into their next decision branch, and keep going until the scope, risks, and acceptance criteria are clear.",
  ),
  "flowkit-labs/skills/reddit-automation": overview(
    "Reddit Automation helps find Reddit discussions where a product can genuinely help and drafts useful replies for human review.",
    "Provide the product context, audience, and what you can honestly offer. It focuses on a small number of relevant threads, requires transparent affiliation, and keeps the final decision to review and post with the user.",
    [
      { title: "Founders and marketers", description: "They want to discover relevant Reddit conversations without turning outreach into spam." },
      { title: "Developer advocates", description: "They need a repeatable way to find questions where a thoughtful answer is useful." },
      { title: "Community-minded teams", description: "They want product participation to be honest, helpful, and reviewable." },
    ],
    [
      { title: "Finding the right threads", description: "Narrows a broad community into conversations where the product can actually answer the question." },
      { title: "Low-value promotion", description: "Keeps the workflow centered on genuine contribution and explicit disclosure." },
      { title: "Reply drafting overhead", description: "Turns relevant threads into useful draft replies that a person can review before posting." },
    ],
    [
      { title: "Opportunity discovery", description: "Finds recent Reddit questions and discussions that match the product context." },
      { title: "Helpful reply drafting", description: "Creates a reply that addresses the question before mentioning the product when relevant." },
      { title: "Transparent participation", description: "Prompts honest disclosure of affiliation and avoids hidden promotion." },
      { title: "Human review gate", description: "Keeps the user in control of what is posted and where." },
    ],
    "Give the skill your product context, the communities or problem space to search, and the time window. Review every suggested thread and draft, disclose your affiliation, and post only when the reply genuinely helps.",
    "Find Reddit threads this week where our product can genuinely help. For each candidate, explain why it is relevant, draft a useful reply with transparent affiliation, and wait for my review before anything is posted.",
  ),
  "charon-fan/agent-playbook/self-improving-agent": overview(
    "Self-Improving Agent helps an agent learn from skill outcomes, errors, and feedback so repeated workflows can improve over time.",
    "Provide the skill run context, what happened, and any correction or feedback. It helps turn those events into validated, reusable guidance rather than silently changing behavior.",
    [
      { title: "Agent builders", description: "They want reusable workflows to learn from real execution results." },
      { title: "Workflow maintainers", description: "They need to track recurring mistakes and improvements across skills." },
      { title: "Teams with feedback loops", description: "They want corrections and successful patterns to remain useful in later runs." },
    ],
    [
      { title: "Repeated mistakes", description: "Captures useful error and correction patterns instead of losing them after a run." },
      { title: "Forgotten learnings", description: "Connects relevant execution history with future skill use." },
      { title: "Unverified advice", description: "Encourages validation before a proposed improvement becomes reusable guidance." },
    ],
    [
      { title: "Execution memory", description: "Organizes useful experience from completed, failed, and corrected skill runs." },
      { title: "Lifecycle hooks", description: "Supports learning around skill start, completion, and error events." },
      { title: "Self-correction", description: "Turns feedback into candidate improvements that can be checked before reuse." },
      { title: "Traceable evolution", description: "Keeps changes connected to the experience and skill context that produced them." },
    ],
    "Install and enable the workflow, then use your normal skills. When a run succeeds, fails, or needs correction, provide the outcome and feedback so the agent can evaluate a future improvement.",
    "Review this failed skill run. Identify the reusable lesson, explain how to validate it, and propose a narrowly scoped improvement for the next run.",
  ),
  "vercel-labs/skills/find-skills": overview(
    "Find Skills helps an agent discover specialized skills when a task needs a capability that is not already available.",
    "Describe the task, domain, or missing capability. It searches the skills ecosystem and helps return a relevant shortlist or installation command instead of requiring users to know the exact skill ID first.",
    [
      { title: "New users", description: "They need help finding useful skills without knowing marketplace names." },
      { title: "Agents with gaps", description: "They want to discover a capability that is missing from the current environment." },
      { title: "Skill maintainers", description: "They need a consistent way to compare and recommend available skills." },
    ],
    [
      { title: "Unknown skill names", description: "Searches by the job to be done rather than only by an exact title." },
      { title: "Too many choices", description: "Narrows a broad marketplace result into a more useful shortlist." },
      { title: "Manual discovery", description: "Makes the path from a task request to a candidate install more direct." },
    ],
    [
      { title: "Task-based search", description: "Looks for skills using a task, domain, or capability description." },
      { title: "Marketplace signals", description: "Can use signals such as installs, stars, and source reputation when comparing results." },
      { title: "Install guidance", description: "Returns the skill identity and the command needed to add a selected skill." },
      { title: "Reusable discovery", description: "Provides a repeatable way to locate skills whenever a new task needs one." },
    ],
    "Ask what you need the agent to do and include the domain or constraints. Review the returned candidates before installing the skill that matches the task.",
    "Find a skill that can compare competitor pricing pages, extract the important changes, and produce a weekly summary.",
  ),
  "steipete/clawdis/weather": overview(
    "Weather helps an agent answer current-weather and forecast questions for a place, trip, or planned activity.",
    "Provide a city, region, airport, or coordinates and state the time window you care about. It helps return current conditions, temperature and rain information, and forecast context when available.",
    [
      { title: "Travelers", description: "They need weather context before choosing dates, routes, or activities." },
      { title: "Daily planners", description: "They want a quick local forecast in the same conversation as their plans." },
      { title: "Agents with location tasks", description: "They need a weather lookup as one step in a larger itinerary or reminder workflow." },
    ],
    [
      { title: "Manual weather checks", description: "Answers forecast questions without requiring a separate weather lookup." },
      { title: "Ambiguous locations", description: "Uses a precise place input to reduce confusion between similarly named locations." },
      { title: "Missing planning context", description: "Connects weather conditions with a date, activity, or travel decision." },
    ],
    [
      { title: "Current conditions", description: "Reports the present weather for the requested location." },
      { title: "Rain and temperature", description: "Highlights practical conditions that affect plans and clothing choices." },
      { title: "Forecast context", description: "Provides a future outlook when the requested time window supports it." },
      { title: "Location-aware queries", description: "Accepts common place identifiers such as cities, airports, and coordinates." },
    ],
    "Name the location and date or time window, then ask for the weather details relevant to your plan. For travel, include the activity or route you are deciding about.",
    "What will the weather be in Kyoto from Friday through Sunday, and which afternoon would be best for an outdoor walking tour?",
  ),
  "juliusbrussee/caveman/caveman": overview(
    "Caveman is a concise communication mode that removes filler while preserving the technical substance needed to act on an answer.",
    "Use it with normal agent requests and optionally specify how aggressively to compress the response. It returns shorter explanations, plans, and code-oriented answers while keeping important details and code blocks.",
    [
      { title: "Technical readers", description: "They want direct answers without losing implementation-critical details." },
      { title: "Token-sensitive workflows", description: "They need useful responses that consume less context and attention." },
      { title: "Teams that scan quickly", description: "They prefer compact updates, decisions, and next steps." },
    ],
    [
      { title: "Verbose responses", description: "Reduces introductions, repetition, and other low-value wording." },
      { title: "Buried decisions", description: "Brings the useful answer and next action closer to the top." },
      { title: "Lost technical detail", description: "Compresses prose while preserving code and important implementation context." },
    ],
    [
      { title: "Compression levels", description: "Supports multiple intensity levels for different response-length needs." },
      { title: "Technical preservation", description: "Keeps code blocks and core technical substance while trimming filler." },
      { title: "Session persistence", description: "Can maintain the selected concise communication style across a session." },
      { title: "Safety exceptions", description: "Can avoid aggressive compression when ambiguity or safety requires more context." },
    ],
    "Install it and state the desired response style or compression level when needed. Continue using ordinary prompts; the skill guides the agent toward concise answers while retaining necessary detail.",
    "Caveman level 4. Explain the deployment failure, the likely cause, and the next three commands to run.",
  ),
  "mattpocock/skills/to-issues": overview(
    "To Issues turns a plan, specification, or PRD into a set of independently actionable issues organized around vertical slices of work.",
    "Provide the source plan and any repository or issue-tracker context. It helps break the work into scoped issues with acceptance criteria, dependencies, and enough context for someone else to pick them up.",
    [
      { title: "Product managers", description: "They need an implementation plan that can move directly into issue tracking." },
      { title: "Engineering leads", description: "They want work split into coherent slices rather than a long list of vague tasks." },
      { title: "Delivery teams", description: "They need issues with clear ownership boundaries, dependencies, and completion criteria." },
    ],
    [
      { title: "Coarse plans", description: "Breaks broad work into smaller slices that can be reviewed and delivered." },
      { title: "Hidden dependencies", description: "Makes ordering and blocking relationships explicit." },
      { title: "Unclear issue scope", description: "Adds context and acceptance criteria so each issue has a usable finish line." },
    ],
    [
      { title: "Context gathering", description: "Uses the plan and available project context to understand the work before splitting it." },
      { title: "Vertical slicing", description: "Groups tasks into coherent slices that deliver a meaningful part of the outcome." },
      { title: "Issue definition", description: "Creates issue-ready descriptions, acceptance criteria, and dependencies." },
      { title: "Human approval", description: "Surfaces granularity and dependency choices for review before publishing issues." },
    ],
    "Give it the plan, PRD, or specification and explain the repository or tracker where the issues belong. Review the proposed slices and dependencies before allowing the issues to be published.",
    "Turn this approved PRD into vertical-slice issues. Keep each issue independently reviewable, include acceptance criteria, and show dependencies before publishing.",
  ),
  "roin-orca/skills/simple": overview(
    "Simple is a lightweight brainstorming workflow that clarifies a goal, compares implementation approaches, and captures an approved direction before coding.",
    "Provide the rough idea, user context, constraints, and any existing code or product information. It helps produce focused questions, two practical approaches with trade-offs, and a concise decision record.",
    [
      { title: "Early-stage builders", description: "They have a real idea but need to clarify what should be built first." },
      { title: "Product and engineering teams", description: "They want shared understanding before choosing an implementation direction." },
      { title: "Developers avoiding rework", description: "They prefer a short discovery pass before changing code." },
    ],
    [
      { title: "Premature implementation", description: "Pauses coding until the problem and desired outcome are understood." },
      { title: "Hidden requirements", description: "Uses targeted questions to reveal constraints and edge cases early." },
      { title: "Choice drift", description: "Records the approved direction so implementation can follow the decision." },
    ],
    [
      { title: "Focused discovery", description: "Asks a small batch of high-value questions rather than an open-ended interview." },
      { title: "Approach comparison", description: "Presents two viable approaches with explicit trade-offs." },
      { title: "Approval gate", description: "Requires a clear direction before moving into implementation." },
      { title: "Decision capture", description: "Keeps the chosen scope and rationale available for the build step." },
    ],
    "Describe the idea, who it is for, and what constraints are known. Answer the focused questions, compare the proposed approaches, and approve one direction before asking the agent to implement it.",
    "Use Simple for this feature idea. Ask up to three clarifying questions, propose two implementation approaches with trade-offs, and wait for my approval before coding.",
  ),
  "gracefullight/stock-checker/stock-analysis": overview(
    "Stock Analysis helps an agent review US stocks, crypto assets, and portfolios through a repeatable market-analysis workflow.",
    "Give it ticker symbols, holdings, risk questions, or a time horizon. It helps turn those inputs into a supported buy, hold, or sell view with relevant signals and risks.",
    audience("They need a structured first pass on a stock, crypto asset, or portfolio.", "They want regular market-risk checks without rebuilding the analysis each time.", "They need a concise view of signals, assumptions, and risks before making a decision."),
    [
      { title: "Scattered signals", description: "Brings technical, portfolio, and market context into one review." },
      { title: "Unclear risk", description: "Highlights risks such as earnings, sector moves, and wider market conditions." },
      { title: "Inconsistent reviews", description: "Uses the same dimensions when comparing assets over time." },
    ],
    capabilities("Reviews assets across several market dimensions.", "Uses holdings and market context to frame the analysis.", "Produces a directional view with supporting reasons.", "Supports recurring portfolio and watchlist reviews."),
    "Share the asset or portfolio, the decision you are considering, and any constraints such as risk tolerance or time horizon.",
    "Review NVDA for a medium-term portfolio. Include valuation, recent earnings, sector risks, and a buy, hold, or sell view.",
  ),
  "molezzz/openclaw-stock-skill/akshare-stock": overview(
    "AKShare Stock is an A-share market analysis skill built around natural-language questions and AKShare market data.",
    "Provide an A-share ticker, index, sector, or market question. It can organize real-time or recent data, technical indicators, fundamentals, sector movement, and related-market context into a compact analysis.",
    audience("They follow China A-shares and want a single-stock or market review.", "They need sector, fund-flow, or technical context for a trading or research workflow.", "They need a concise A-share assessment before deciding what to investigate further."),
    [
      { title: "Fragmented market data", description: "Combines quotes, technical signals, fundamentals, and sector data." },
      { title: "China-market context", description: "Uses A-share concepts such as sectors, capital flows, and trading calendars." },
      { title: "Hard-to-read outputs", description: "Formats detailed analysis into a compact, usable summary." },
    ],
    capabilities("Retrieves A-share and related-market information.", "Routes different market questions to suitable data and analysis steps.", "Summarizes technical, fundamental, and sector signals.", "Handles common natural-language stock and market questions."),
    "Name the A-share, index, or sector and state what you want to assess, such as momentum, fundamentals, capital flow, or risk.",
    "Analyze 600519. Summarize recent price action, valuation, fund flows, sector position, and the main risks.",
  ),
  "anthropics/financial-services-plugins/earnings-analysis": overview(
    "Earnings Analysis is designed for turning a company earnings release into a structured equity-research update.",
    "Give it the company, reporting period, results, prior estimates, and investment thesis. It helps organize performance, surprises, guidance, and implications into a consistent research note.",
    audience("They review quarterly results for companies under coverage.", "They need a repeatable way to compare results with estimates and prior expectations.", "They need a clear update before discussing changes to a thesis or model."),
    [
      { title: "Dense earnings releases", description: "Turns long result packages into a focused update." },
      { title: "Missed variances", description: "Separates reported performance from estimates and prior guidance." },
      { title: "Unclear implications", description: "Connects results to the existing investment view and follow-up questions." },
    ],
    capabilities("Organizes quarterly financial and operating results.", "Compares performance with estimates, guidance, and prior periods.", "Calls out notable drivers, risks, and open questions.", "Produces a repeatable earnings-update structure."),
    "Provide the earnings release or key figures, plus estimates and the previous thesis if you have them.",
    "Write an earnings update for Company X using these Q2 results and consensus estimates. Explain the surprise, guidance changes, and what could change the thesis.",
  ),
  "okx/agent-skills/okx-sentiment-tracker": overview(
    "OKX Sentiment Tracker helps an agent monitor crypto news, sentiment, social signals, and macro events for a selected market topic.",
    "Ask about a coin, current news, market mood, or an economic event. It returns a focused briefing rather than a trading-execution workflow, and may require the connected OKX credentials described by the skill.",
    audience("They need a daily crypto news or sentiment briefing.", "They monitor named assets such as BTC, ETH, or SOL alongside wider market mood.", "They need context before research or discussion, not an automated trade."),
    [
      { title: "Too much crypto news", description: "Narrows the news flow to the asset or topic that matters." },
      { title: "Weak sentiment context", description: "Connects bullish and bearish signals with social and news activity." },
      { title: "Missed macro events", description: "Surfaces relevant economic-calendar context for market updates." },
    ],
    capabilities("Collects crypto news and market-intelligence signals.", "Summarizes sentiment trends and social buzz.", "Frames major macro events alongside the market update.", "Produces short daily or asset-specific briefings."),
    "Specify the asset or market topic, the time window, and whether you want news, sentiment, macro events, or all three.",
    "Give me a morning briefing for BTC: latest news, market sentiment, key social signals, and today’s macro events.",
  ),
  "phuryn/pm-skills/sentiment-analysis": overview(
    "Sentiment Analysis turns large sets of user feedback into segmented sentiment, Jobs-to-be-Done, and product insights.",
    "Provide surveys, reviews, support tickets, interview notes, CSV files, or PDFs. The skill looks for segments, recurring themes, satisfaction drivers, pain points, and practical recommendations.",
    audience("They have enough feedback to need patterns rather than manual reading.", "They want evidence for product, research, or roadmap discussions.", "They need to see which user groups are satisfied, blocked, or at risk."),
    [
      { title: "Messy feedback", description: "Organizes many comments into segments and recurring themes." },
      { title: "Unclear satisfaction", description: "Assigns sentiment and identifies drivers and detractors." },
      { title: "Weak prioritization", description: "Links findings to impact and actionable product recommendations." },
    ],
    capabilities("Ingests common feedback formats such as surveys and tickets.", "Identifies user segments and Jobs-to-be-Done.", "Scores sentiment and extracts positive and negative themes.", "Prioritizes recommendations by frequency, severity, and impact."),
    "Upload or paste a meaningful feedback set, name the product or feature, and state the decision the analysis should support.",
    "Analyze these 500 support tickets for our onboarding flow. Segment users, score sentiment, list top pain points, and recommend the three highest-impact fixes.",
  ),
  "personamanagmentlayer/pcl/finance-expert": overview(
    "Finance Expert gives an agent domain guidance for financial systems, FinTech applications, banking platforms, and payment workflows.",
    "Describe the product, system design, regulatory context, or decision. It helps frame implementation, calculations, security, reliability, and compliance considerations; it is not a substitute for professional legal or financial advice.",
    audience("They build or plan banking, payments, or FinTech systems.", "They need a domain-aware review of financial-product requirements.", "They need practical questions and safeguards before approving a technical direction."),
    [
      { title: "Domain complexity", description: "Brings banking, payments, risk, and reporting concepts into planning." },
      { title: "Unsafe money handling", description: "Highlights concerns such as precision, idempotency, and audit trails." },
      { title: "Compliance gaps", description: "Surfaces security and regulatory considerations early." },
    ],
    capabilities("Explains common financial-system patterns and concepts.", "Reviews payment, banking, and FinTech implementation choices.", "Calls out security, data-handling, and compliance constraints.", "Suggests practical next steps and questions for specialists."),
    "Share the product flow or technical decision, including countries, payment methods, data sensitivity, and constraints.",
    "Review this wallet-to-bank payout design. Identify payment reliability, money precision, security, audit, and compliance considerations.",
  ),
  "coreyhaines31/marketingskills/content-strategy": overview(
    "Content Strategy helps plan practical content pillars, topics, formats, and priorities around business and audience goals.",
    "Give it product context, audience insight, existing content, competitor gaps, and keyword data when available. It turns those inputs into a roadmap with themes, topic clusters, and suggested next pieces.",
    audience("They need a content plan instead of another unprioritized idea list.", "They want to connect topics to audience needs, search demand, and business goals.", "They need a focused roadmap before assigning writing work."),
    [
      { title: "Random content ideas", description: "Groups ideas into purposeful pillars and clusters." },
      { title: "Weak prioritization", description: "Balances audience impact, search potential, and effort." },
      { title: "No editorial direction", description: "Connects individual pieces to a larger content plan." },
    ],
    capabilities("Defines content pillars and audience-relevant themes.", "Finds topic and competitor gaps from available research.", "Prioritizes formats and pieces for a practical roadmap.", "Maps topics to buyer stages and search or sharing goals."),
    "Describe your product, audience, goals, current content, and any keyword or customer research you already have.",
    "Create a 90-day content strategy for a B2B onboarding product. Our audience is SaaS customer-success leads; use these customer interviews and keyword notes.",
  ),
  "coreyhaines31/marketingskills/social-content": overview(
    "Social Content helps create, schedule, repurpose, and improve social posts for major platforms.",
    "Provide the platform, audience, brand voice, campaign goal, and source material. It can adapt a core message into platform-ready posts, content-calendar ideas, and optimization suggestions.",
    audience("They publish regularly on LinkedIn, X, Instagram, TikTok, or Facebook.", "They need one campaign or article adapted for several social channels.", "They want a clearer content cadence and performance-improvement process."),
    [
      { title: "One-size-fits-all posts", description: "Adapts format, hooks, and cadence to each platform." },
      { title: "Slow repurposing", description: "Turns one source asset into several useful posts." },
      { title: "No publishing rhythm", description: "Supports batching and calendar-based planning." },
    ],
    capabilities("Writes platform-aware social content and hooks.", "Builds reusable content pillars and calendar ideas.", "Repurposes long-form assets into multiple posts.", "Uses engagement metrics to guide optimization."),
    "Give the target platform, goal, audience, voice, and source material or message that the post should build from.",
    "Turn this product launch article into three LinkedIn posts and five X posts. Keep the voice practical and aim for demo sign-ups.",
  ),
  "composiohq/awesome-claude-skills/content-research-writer": overview(
    "Content Research Writer is a writing partner for researching, outlining, drafting, citing, and refining long-form content while preserving a defined voice.",
    "Provide a topic, audience, angle, constraints, and source expectations. It helps turn the brief into an evidence-led outline or draft with stronger hooks and section-by-section feedback.",
    audience("They write articles, newsletters, tutorials, or thought-leadership pieces.", "They need research and citations to support a draft.", "They want an iterative editor that keeps the intended voice and angle."),
    [
      { title: "Thin drafts", description: "Adds research, evidence, and a clearer argument structure." },
      { title: "Weak openings", description: "Improves hooks and introductions before the full draft is written." },
      { title: "Generic AI writing", description: "Uses stated voice, audience, and feedback to guide revisions." },
    ],
    capabilities("Plans research and content structure together.", "Builds outlines and drafts for several long-form formats.", "Tracks citations and references where needed.", "Offers iterative feedback on clarity, flow, and hooks."),
    "Share the topic, reader, desired outcome, voice, required sources, and whether you need an outline, draft, or revision.",
    "Research and outline a 1,200-word article for product leaders on reducing onboarding drop-off. Use credible sources and a clear, practical tone.",
  ),
  "googleworkspace/cli/persona-content-creator": overview(
    "Content Creator is a Google Workspace persona for creating, organizing, and distributing content across connected Workspace tools.",
    "Provide a brief, source material, target format, and collaborators. It is suited to workflows that use Docs, Drive, Sheets, Gmail, and related Workspace capabilities to keep assets and sharing connected.",
    audience("They create and manage content inside Google Workspace.", "They need a workflow that keeps drafts, assets, and collaborators organized.", "They need to prepare and distribute content with existing Workspace tools."),
    [
      { title: "Scattered assets", description: "Keeps source files, drafts, and output organized in Workspace." },
      { title: "Manual handoffs", description: "Connects content production with sharing and collaboration." },
      { title: "Unclear ownership", description: "Uses shared folders and documents to make work visible to the team." },
    ],
    capabilities("Creates and organizes content assets in Workspace.", "Uses Drive and Docs for source and draft management.", "Supports collaboration and sharing workflows.", "Connects creation with distribution tasks."),
    "State what you need to create, where the source materials are, the target format, and who should review or receive it.",
    "Create a campaign brief from this Google Doc, save the draft in our Drive folder, and share it with the marketing reviewers.",
  ),
  "resciencelab/opc-skills/seo-geo": overview(
    "SEO & GEO helps optimize websites for traditional search engines and AI answer engines such as ChatGPT, Perplexity, Gemini, Copilot, and Claude.",
    "Provide a target URL, pages, keywords, competitors, or content goals. It can audit technical and on-page issues, recommend answer-first content changes, and guide metadata and JSON-LD schema work.",
    audience("They own a website that needs better search and AI-answer visibility.", "They need a structured audit before changing content or technical SEO.", "They want to improve citations and discoverability in generative search."),
    [
      { title: "Search-only optimization", description: "Addresses both traditional SEO and generative-engine visibility." },
      { title: "Missing technical basics", description: "Reviews metadata, bot access, structure, and schema opportunities." },
      { title: "Hard-to-cite content", description: "Guides answer-first writing, evidence, and authoritative citations." },
    ],
    capabilities("Audits site and page-level SEO/GEO issues.", "Researches keywords and AI-search opportunities.", "Recommends content structure, metadata, and schema markup.", "Checks practical factors such as crawler access and source quality."),
    "Provide the URL, market, target audience, important queries, and any pages or technical constraints that should be reviewed.",
    "Audit https://example.com/pricing for SEO and GEO. Prioritize fixes for AI citations, page structure, metadata, and JSON-LD.",
  ),
  "mattpocock/skills/edit-article": overview(
    "Edit Article improves an existing article by checking its structure, clarity, flow, and prose before rewriting.",
    "Provide the full draft, intended audience, tone, and editing goals. It is best for revising a real draft rather than creating a new article from a topic alone.",
    audience("They have a draft that needs a stronger structure before publishing.", "They edit technical, educational, or thought-leadership articles.", "They want an editorial pass that preserves the original meaning and voice."),
    [
      { title: "Confusing order", description: "Reorders ideas so foundational points arrive before dependent ones." },
      { title: "Dense writing", description: "Tightens sentences and breaks long content into clearer sections." },
      { title: "Surface-only edits", description: "Addresses both article structure and prose quality." },
    ],
    capabilities("Finds sections and checks the order of ideas.", "Proposes a clearer article structure before rewriting.", "Rewrites for clarity, flow, and concise paragraphs.", "Preserves the stated audience, tone, and technical meaning."),
    "Paste the draft and say who it is for, what must stay unchanged, and whether you want light editing or a deeper restructure.",
    "Edit this article for intermediate developers. First propose a better section order, then rewrite for clarity without changing the technical claims.",
  ),
  "karpathy/nanochat/read-arxiv-paper": overview(
    "Read arXiv Paper helps an agent fetch an arXiv paper’s source and turn it into a focused technical reading workflow.",
    "Provide an arXiv URL and the questions you care about. The skill works from the paper source rather than only the PDF and helps extract a readable summary and relevant technical details.",
    audience("They need a quick but grounded orientation to an arXiv paper.", "They need to examine methods, experiments, or implementation-relevant details.", "They want key takeaways tied to a concrete research or engineering question."),
    [
      { title: "Long papers", description: "Turns source material into an easier technical reading path." },
      { title: "PDF friction", description: "Uses the arXiv source form to access structured paper content." },
      { title: "Unfocused summaries", description: "Lets the reader ask for methods, results, limitations, or relevance." },
    ],
    capabilities("Normalizes arXiv URLs and retrieves paper source.", "Extracts key sections and technical details from the source.", "Summarizes the contribution, methods, and results.", "Answers focused questions about the paper’s relevance."),
    "Share an arXiv link and say whether you need a general summary, method review, experiment analysis, or implementation implications.",
    "Read https://arxiv.org/abs/2601.07372. Explain the core method, evaluation setup, main limitations, and implications for a production LLM system.",
  ),
  "googleworkspace/cli/persona-researcher": overview(
    "Researcher is a Google Workspace persona for keeping research references, notes, data logs, and collaboration in one connected workflow.",
    "Provide the research question, source files, working notes, and collaborators. It uses connected Workspace tools to organize material in Drive, write summaries in Docs, log data in Sheets, and share findings with a team.",
    audience("They run multi-source research projects in Google Workspace.", "They need a clear home for papers, notes, experiments, and findings.", "They collaborate with others who need access to current research artifacts."),
    [
      { title: "Scattered research", description: "Organizes papers, notes, and data in a shared Workspace structure." },
      { title: "Lost context", description: "Keeps ongoing findings and experiment logs easy to review." },
      { title: "Slow collaboration", description: "Supports sharing, announcements, and review requests." },
    ],
    capabilities("Organizes references and notes in Drive.", "Writes research summaries in Docs.", "Logs findings and data in Sheets.", "Shares research outputs and requests peer review through Workspace."),
    "State the research question, point to the source material, and describe the folder, document, or collaborators that should be used.",
    "Create a Workspace research hub for our competitor study. Organize these sources in Drive, summarize each in a Doc, and track findings in a shared Sheet.",
  ),
  "nexscope-ai/amazon-skills/amazon-product-research": overview(
    "Amazon Product Research helps Amazon sellers evaluate a product idea before committing to sourcing, inventory, or a listing strategy.",
    "Give it a product idea, niche, category, market, or competitor set. It helps frame demand, competition, profit potential, barriers, and areas that need further validation.",
    audience("They are choosing which products or niches to investigate on Amazon.", "They need a structured way to compare product opportunities.", "They want to identify risks before committing inventory or advertising spend."),
    [
      { title: "Guesswork in product selection", description: "Uses a consistent set of demand and competition questions." },
      { title: "Missed barriers", description: "Calls out practical risks such as competition, margins, and category constraints." },
      { title: "Unclear next steps", description: "Separates promising hypotheses from items that need validation." },
    ],
    capabilities("Frames product demand and market opportunity.", "Reviews competitors and differentiation questions.", "Assesses profit potential and likely barriers.", "Produces a clear research brief for the next decision."),
    "Name the product or niche, country marketplace, target price range, and any competitors or constraints you already know.",
    "Research the Amazon US opportunity for a portable blender under $40. Compare demand, competition, margins, review pain points, and entry barriers.",
  ),
  "coreyhaines31/marketingskills/customer-research": overview(
    "Customer Research helps an agent plan, conduct, analyze, and synthesize research from interviews, surveys, reviews, support data, and public sources.",
    "Give it product context and either existing evidence or a question to investigate. It can extract voice-of-customer language, Jobs-to-be-Done, pains, triggers, personas, and evidence-led recommendations.",
    audience("They need evidence about their customers before making product or messaging decisions.", "They have interview transcripts, surveys, reviews, or support tickets to analyze.", "They need to research an ICP, churn reasons, or buying triggers from public and internal sources."),
    [
      { title: "Assumed personas", description: "Builds insights from actual customer language and evidence." },
      { title: "Unstructured evidence", description: "Synthesizes feedback into themes, pains, triggers, and Jobs-to-be-Done." },
      { title: "Research without action", description: "Links findings to product, messaging, and prioritization decisions." },
    ],
    capabilities("Plans interview, survey, and review-mining work.", "Analyzes existing customer evidence and public-source signals.", "Extracts voice-of-customer themes, personas, and JTBD.", "Produces evidence-led findings and next steps."),
    "Describe the product and research question, then provide existing feedback or ask it to design the research plan and source approach.",
    "Analyze these customer interviews for our analytics product. Identify ICP segments, buying triggers, pain points, JTBD, and the exact language we should use on our homepage.",
  ),
  "firecrawl/firecrawl-workflows/firecrawl-market-research": overview(
    "Firecrawl Market Research is a web-research workflow for gathering market, company, financial, earnings, and industry information from public sources.",
    "Give it an industry, company, question, and the metrics or comparisons you need. It helps collect and structure web evidence into a market-oriented brief.",
    audience("They need a quick evidence base for an industry, company, or market question.", "They need public information organized around specific metrics or comparisons.", "They need a market brief before a strategy, product, or investment discussion."),
    [
      { title: "Manual browsing", description: "Provides a repeatable way to gather relevant web evidence." },
      { title: "Metric gaps", description: "Focuses research around the company, market, or financial facts that matter." },
      { title: "Unstructured findings", description: "Turns collection into a coherent market research brief." },
    ],
    capabilities("Collects public web information for market questions.", "Focuses on company, industry, financial, and earnings metrics.", "Compares sources and structures research evidence.", "Produces a concise research brief for follow-up work."),
    "Specify the market question, companies or geography, desired date range, and the metrics or source types that matter.",
    "Research the APAC cloud-security market. Compare the leading vendors, recent earnings signals, pricing trends, and key growth drivers using public sources.",
  ),
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": overview(
    "Firecrawl Deep Research is for report-scale web research that needs a rigorous, multi-source, cited written synthesis.",
    "Give it a well-scoped question, audience, desired depth, and source preferences. It is intended for a formal research report rather than a quick lookup or top-N list.",
    audience("They need a substantial research report rather than a quick web answer.", "They need to compare viewpoints or investigate a complex market or technical question.", "They need a cited brief to support a high-stakes discussion or decision."),
    [
      { title: "Shallow web answers", description: "Uses a deeper, multi-source research workflow." },
      { title: "Unclear scope", description: "Starts by clarifying report depth and the research boundary." },
      { title: "Weak traceability", description: "Produces a sourced synthesis with findings and open questions." },
    ],
    capabilities("Scopes a report-scale research task before execution.", "Collects and compares evidence across multiple web sources.", "Synthesizes findings into a formal written report.", "Includes citations, uncertainties, and open questions."),
    "State the question, audience, required depth, time horizon, and what kinds of sources or exclusions should guide the report.",
    "Prepare a cited deep-research report on how AI agents are changing customer support software. Cover market size signals, leading approaches, buyer concerns, and open risks.",
  ),
  "anthropics/skills/pdf": overview(
    "PDF is a document-processing skill for reading, extracting, creating, editing, splitting, merging, securing, and filling PDF files.",
    "Provide one or more PDF files and state the operation. It supports text and table extraction, page changes, OCR for scanned files, images, watermarks, encryption, and form-filling workflows.",
    audience("They need to extract information or answer questions from PDFs.", "They need to transform, combine, split, or edit PDF documents.", "They work with scanned documents or PDF forms."),
    [
      { title: "PDF tool sprawl", description: "Groups common PDF operations under one workflow." },
      { title: "Scanned documents", description: "Uses OCR guidance to make image-based PDFs searchable." },
      { title: "Manual document edits", description: "Supports repeatable page, content, and form transformations." },
    ],
    capabilities("Extracts text, tables, and images from PDF files.", "Merges, splits, rotates, and edits pages.", "Handles OCR for scanned documents and form filling.", "Guides secure PDF operations such as encryption and watermarks."),
    "Attach the PDF files, specify the operation, and describe the desired output file or extracted information.",
    "Extract the tables from this scanned quarterly report, convert them to CSV, and summarize the revenue changes by region.",
  ),
  "coreyhaines31/marketingskills/image": overview(
    "Marketing Image helps plan, generate, edit, and optimize visuals for marketing use cases such as blog heroes, social graphics, product mockups, and banners.",
    "Provide a creative brief, brand direction, audience, channel, and source assets if you have them. It helps turn these inputs into a usable visual direction or production-ready image asset.",
    audience("They need marketing visuals tied to a specific campaign or content goal.", "They need a clearer brief before generating or commissioning an image.", "They want consistent brand direction across social, web, and launch assets."),
    [
      { title: "Generic visuals", description: "Starts with audience, message, channel, and brand context." },
      { title: "Weak briefs", description: "Turns a loose request into a specific visual direction." },
      { title: "Channel mismatch", description: "Adapts imagery for the target format and marketing use." },
    ],
    capabilities("Creates structured creative briefs for marketing images.", "Guides generation, editing, and optimization work.", "Aligns visuals with audience, campaign, and brand direction.", "Prepares assets for common web and social formats."),
    "State the campaign goal, audience, channel, brand direction, desired format, and any images or visual references to use.",
    "Create a visual brief for a LinkedIn launch graphic for our AI meeting assistant. Use a clean enterprise style, dark text, and a 1:1 format.",
  ),
  "github/awesome-copilot/prd": overview(
    "PRD helps turn a product or feature idea into a structured product requirements document for software or AI-powered work.",
    "Provide the problem, users, goals, constraints, and success criteria. It helps organize the idea into an executive summary, user stories, requirements, technical considerations, and risks.",
    audience("They need to turn early product context into an implementation-ready document.", "They align product, design, engineering, and other stakeholders around a feature.", "They need a consistent starting point for scope, requirements, and risk discussions."),
    [
      { title: "Vague feature requests", description: "Makes users, goals, and expected outcomes explicit." },
      { title: "Missing handoff detail", description: "Organizes user stories, requirements, and technical context." },
      { title: "Late risk discovery", description: "Prompts consideration of dependencies, constraints, and risks." },
    ],
    capabilities("Builds structured PRDs from product context.", "Captures executive summaries, user stories, and requirements.", "Frames technical specifications and acceptance criteria.", "Surfaces risks and unanswered questions for review."),
    "Share the problem, target users, business goal, non-goals, constraints, and how success should be measured.",
    "Write a PRD for an in-product model connectivity test. Include the user problem, flows, API requirements, error states, risks, and acceptance criteria.",
  ),
  "google-labs-code/stitch-skills/enhance-prompt": overview(
    "Enhance Prompt turns a rough UI idea into a clearer, Stitch-optimized design prompt with page structure and design-system context.",
    "Give it a simple interface idea, user goal, brand direction, and constraints. It identifies missing details such as platform, layout, components, colors, and interaction patterns, then produces a structured prompt ready for Stitch.",
    audience("They start with a vague UI concept and need a stronger generation prompt.", "They want a design prompt that is consistent with an existing DESIGN.md file.", "They need to improve a prompt that previously produced weak screens."),
    [
      { title: "Vague UI requests", description: "Fills in missing platform, page, layout, and component detail." },
      { title: "Inconsistent screens", description: "Uses design-system context when it is available." },
      { title: "Poor generation results", description: "Applies clearer design and interaction language before generation." },
    ],
    capabilities("Identifies gaps in a rough UI prompt.", "Adds structured layout, component, color, and visual-style guidance.", "Reads DESIGN.md context for consistency across pages.", "Outputs a focused prompt ready for Stitch generation."),
    "Describe the screen, target users, job to be done, platform, brand direction, and any existing design-system or project context.",
    "Improve this Stitch prompt: I need a dashboard for tracking fitness. It should work on desktop and mobile and feel motivating but not childish.",
  ),
  "github/awesome-copilot/documentation-writer": overview(
    "Documentation Writer helps create software documentation using the Diataxis framework: tutorials, how-to guides, reference material, and explanations.",
    "Give it the feature context, audience, examples, and document goal. It helps choose the right documentation type, propose an outline, and create focused Markdown with consistent terminology.",
    audience("They write or maintain software documentation for users or developers.", "They need to choose between a tutorial, how-to, reference, or explanation.", "They need a structured documentation workflow before drafting."),
    [
      { title: "Mixed document types", description: "Uses Diataxis to match the content to the reader’s task." },
      { title: "Unclear structure", description: "Clarifies audience and purpose before proposing an outline." },
      { title: "Inconsistent documentation", description: "Guides style, terminology, examples, and review steps." },
    ],
    capabilities("Classifies documentation by the Diataxis framework.", "Gathers audience, task, and product context.", "Proposes an outline before writing full content.", "Produces reader-focused Markdown documentation."),
    "Describe the feature, target reader, desired documentation type, available examples, and what the reader should accomplish.",
    "Write a how-to guide for developers to configure model connectivity testing. Include prerequisites, steps, expected results, and troubleshooting.",
  ),
  "wshobson/agents/data-storytelling": overview(
    "Data Storytelling helps turn raw numbers and analysis into a clear narrative that supports stakeholder understanding and action.",
    "Provide the data, audience, decision context, and main question. It helps choose a story structure, key message, annotations, and visualization approach for reports, reviews, dashboards, or presentations.",
    audience("They present analytics to executives or non-technical stakeholders.", "They need a quarterly review, investor update, or decision-oriented report.", "They have data but need a clearer message and visual direction."),
    [
      { title: "Data without a message", description: "Connects evidence to a clear narrative and decision." },
      { title: "Overloaded charts", description: "Uses progressive reveal and annotations to focus attention." },
      { title: "Unclear uncertainty", description: "Guides responsible use of ranges, caveats, and assumptions." },
    ],
    capabilities("Builds story structures such as problem-solution and trend narratives.", "Selects a main message and supporting evidence.", "Suggests visual and annotation approaches for clarity.", "Adapts the narrative to executive, report, or dashboard formats."),
    "Share the data or findings, audience, decision to support, and any required chart, report, or presentation format.",
    "Turn this quarterly retention dataset into an executive narrative. Highlight the main trend, the likely causes, uncertainty, and the two actions we should take next.",
  ),
};

export function getCuratedSkillOverview(
  rawId: string,
  locale: CuratedSkillOverviewLocale = "en-US",
): CuratedSkillOverview {
  // 印尼语增量落地：已翻译的走印尼语，未翻译的回退英文，
  // 英文也缺失时抛出，由调用方降级为通用描述（与英文站现有行为一致）。
  const result = locale === "zh-CN"
    ? CURATED_SKILL_OVERVIEWS_ZH[rawId] ?? CURATED_SKILL_OVERVIEWS[rawId]
    : locale === "id-ID"
      ? CURATED_SKILL_OVERVIEWS_ID[rawId] ?? CURATED_SKILL_OVERVIEWS[rawId]
      : locale === "es"
        ? CURATED_SKILL_OVERVIEWS_ES[rawId] ?? CURATED_SKILL_OVERVIEWS[rawId]
      : locale === "ja-JP"
        ? CURATED_SKILL_OVERVIEWS_JA[rawId] ?? CURATED_SKILL_OVERVIEWS[rawId]
      : locale === "ko-KR"
        ? CURATED_SKILL_OVERVIEWS_KO[rawId] ?? CURATED_SKILL_OVERVIEWS[rawId]
      : CURATED_SKILL_OVERVIEWS[rawId];
  if (!result) {
    throw new Error(`Missing curated skill overview: ${rawId}`);
  }
  return result;
}
