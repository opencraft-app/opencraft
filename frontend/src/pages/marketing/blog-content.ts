export type BlogInline =
  | string
  | {
      type: "link";
      label: string;
      href: string;
    };

export type BlogBlock =
  | {
      type: "paragraph";
      content: readonly BlogInline[];
      emphasis?: boolean;
    }
  | {
      type: "heading";
      text: string;
    }
  | {
      type: "image";
      src: string;
      alt: string;
      size?: "narrow";
    }
  | {
      type: "ordered-list";
      ariaLabel: string;
      items: readonly (readonly BlogInline[])[];
    }
  | {
      type: "unordered-list";
      items: readonly (readonly BlogInline[])[];
    }
  | {
      type: "code";
      content: string;
    };

export type BlogPost = {
  slug: string;
  category: "use-case";
  title: string;
  excerpt: string;
  publishedAt: string;
  coverImage: string;
  content: readonly BlogBlock[];
};

const link = (label: string, href: string): BlogInline => ({ type: "link", label, href });

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "recreated-claude-tag-with-lightvela",
    category: "use-case",
    title: "I Recreated Claude Tag with LightVela and Set Up a “Digital Employee” in Slack",
    excerpt:
      "Anthropic’s Claude Tag points to a new way of working in Slack, so I recreated the idea with LightVela and built a digital employee for my team...",
    publishedAt: "2026-09-01T20:35:43+08:00",
    coverImage: "/assets/blog/lightvela-slack-digital-employee/cover.png",
    content: [
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/cover.png",
        alt: "Colorful Slack-inspired LightVela illustration",
      },
      {
        type: "paragraph",
        emphasis: true,
        content: [
          "Recently, Anthropic launched Claude Tag. In any Slack thread, you can @Claude and it will continue the discussion from there. It can read channel context, use tools from the organization, remember work-related information, and proactively @ you when a task is complete or a human decision is needed.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Anthropic is building this feature internally as its next breakout product. Borrowing Andrej Karpathy’s framing, Claude Tag suggests that AI products are entering a third stage: Chat, then local coding agents, then AI coworkers. For a deeper look, see this ",
          link("in-depth WeChat article", "https://mp.weixin.qq.com/s/DfQFOgOZxhReNiXbYG8ybA?scene=1"),
          ".",
        ],
      },
      {
        type: "paragraph",
        content: [
          "In the past, we often had to leave the place where work was happening, open a separate AI chat, explain the project context again, and copy the result back into the group. Claude Tag puts an agent inside the communication tool the team already uses every day. Tasks start in the discussion, and the results return to the same thread, where everyone can see them and continue the work.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Claude Tag is still in beta, is available to Claude Team and Enterprise plans, and requires an organization owner to complete the setup. It may not be the right fit for every small team yet, but the idea is worth borrowing.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "I work on growth products at LightVela, so I usually keep a close eye on metrics such as registrations, activations, and active users. Another kind of friction is just as common: project progress, product ideas that appear unexpectedly, and who agreed to follow up on what are scattered across chat history. A few days later, the information has already been buried by newer messages. So I used Slack and LightVela to build a workflow that is closer to how our team works.",
        ],
      },
      {
        type: "paragraph",
        content: ["This tutorial will walk through three things:"],
      },
      {
        type: "unordered-list",
        items: [
          ["Send the latest data to Slack on a daily schedule."],
          ["Regularly summarize key progress and action items from group chats."],
          ["Sync those summaries to Notion as an always-growing team knowledge base."],
        ],
      },
      {
        type: "paragraph",
        content: [
          "Here is the configuration process I went through. The steps are not complicated. Permissions and output format usually take the most thought, so it helps to decide those two things before you begin.",
        ],
      },
      {
        type: "heading",
        text: "Step 1: Activate a LightVela plan",
      },
      {
        type: "paragraph",
        content: [
          "LightVela is a cloud-hosted Agent product that lets you deploy Hermes Agent quickly, with memory management, scheduled tasks, Skills, and persona settings. Alongside its built-in chat entry point, it can connect to Slack, WhatsApp, Telegram, Discord, and other channels.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Open the plan page, choose a version that fits your needs, and start the trial. Trial duration and plan details may change, so use the information shown on the page as the source of truth. The current activation flow supports Google or GitHub sign-in, and the trial does not require a credit card. Visit ",
          link("LightVela", "/"),
          " to get started.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/pricing.png",
        alt: "LightVela pricing page with Launch and Cruise plans",
      },
      {
        type: "heading",
        text: "Step 2: Connect LightVela to Slack",
      },
      {
        type: "paragraph",
        content: [
          "After activation, open the My Agent configuration page, choose Slack under Channel, and follow the Guide to complete the Slack-side setup. There are several permissions to configure, so it is worth completing them in one pass and checking each item. Missing even one permission to read or send messages can block later group-chat workflows.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/slack-channel.png",
        alt: "LightVela Channel page with Slack connected",
      },
      {
        type: "paragraph",
        content: ["My setup is not limited to private conversations. I also add the Agent to work groups and let it read the conversation history. During configuration, confirm that three types of capability are available:"],
      },
      {
        type: "unordered-list",
        items: [
          ["Read message history in the target channels and group chats."],
          ["Send messages in channels and respond to @ mentions."],
          ["Access the data sources or tools needed for later tasks, with permissions limited to the minimum scope."],
        ],
      },
      {
        type: "paragraph",
        content: [
          "Once the connection is complete, return to Slack and start a conversation with the Agent. You can customize its name to match your team’s habits. I named mine lightvela. Send a simple message first to confirm that it can reply normally before continuing with the rest of the setup.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/slack-lightvela-english.png",
        alt: "Slack conversation with LightVela in a direct message",
      },
      {
        type: "heading",
        text: "Step 3: Install a data-monitoring Skill",
      },
      {
        type: "paragraph",
        content: [
          "LightVela provides two ways to install a Skill. Public Skills can be searched directly from the Skills tab, with sources including skills.sh and ClawHub. For common use cases, installing from there is the simplest option.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/skills.png",
        alt: "LightVela Skills page with featured Skills",
      },
      {
        type: "paragraph",
        content: [
          "For this workflow, I needed lightvela to read internal team data, and I wanted to standardize the daily report format. I packaged the data interface and output requirements into a private Skill. Because the API data is only for team members, I did not upload the Skill to a public community. Instead, I sent it to lightvela in the conversation and asked it to install the Skill.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "After installation, do not jump straight to a scheduled task. Run it manually first. Ask the Agent to fetch a daily report for a specific date, then check whether the numbers are correct, the fields are complete, and the format is easy to read in Slack. A successful one-off run confirms that the Skill and permissions are configured correctly.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/daily-report-english.png",
        alt: "Slack message list showing a LightVela daily report",
      },
      {
        type: "heading",
        text: "Step 4: Set up daily delivery",
      },
      {
        type: "paragraph",
        content: [
          "Once the one-off report works, turn it into a scheduled task. You can configure it from LightVela’s Automations page, or tell the Agent the execution time, data range, destination channel, and failure behavior directly in chat. After that, return to Automations to review each execution record.",
        ],
      },
      {
        type: "paragraph",
        content: ["You can say:"],
      },
      {
        type: "code",
        content: `Every day at 10:00 AM, fetch the complete data from yesterday and send it to the specified Slack channel using the “LightVela Usage Daily Report” template. If the fetch fails, notify me in the same channel and explain the reason.`,
      },
      {
        type: "paragraph",
        content: [
          "There is one easy-to-miss detail here. If the task only says “send a daily report,” the Agent still has to guess the data date, format, and destination. State all three explicitly and scheduled delivery will be much more reliable.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/automations-english.png",
        alt: "LightVela Automations page showing recent daily report runs",
      },
      {
        type: "heading",
        text: "Step 5: Connect Notion and turn chat into a knowledge base",
      },
      {
        type: "paragraph",
        content: [
          "Once the Agent is in the work group, it can help organize the conversation history. I want it to capture three types of information: progress on product issues, newly surfaced feature ideas, and action items that someone needs to continue. A summary posted in the group is not enough because the messages will keep moving upward, so I connected Notion as well.",
        ],
      },
      {
        type: "paragraph",
        content: ["Notion provides an MCP that the Agent can call. In the conversation with lightvela, run the following command:"],
      },
      {
        type: "code",
        content: ["hermes mcp add \\", "  --url https://mcp.notion.com/mcp \\", "  --auth oauth \\", "  notion"].join("\\n"),
      },
      {
        type: "paragraph",
        content: [
          "Follow the returned prompts to complete OAuth authorization. I recommend authorizing only the page or database intended for group-chat summaries instead of opening the entire workspace at once. After authorization, restart MCP. Other channels can use /reload-mcp; Slack disables slash commands, so use !reload-mcp there.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/lightvela-slack-digital-employee/notion-mcp-english.png",
        alt: "Slack and Notion MCP overview shared by LightVela",
      },
      {
        type: "paragraph",
        content: [
          "After confirming that lightvela can read the target page, give it a fixed instruction such as: Before the weekly meeting, summarize the specified channel and organize it into “Key progress, Open questions, Owners, and Next steps,” then append it to the corresponding Notion page. This means the team no longer has to scroll through the conversation from the beginning during a meeting. Everyone can start with the unfinished items and continue from there.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Today, lightvela has a specific role in our Slack: it sends the daily data report, regularly organizes group conversations, and writes the parts worth preserving into Notion. It has not replaced the team’s judgment, but it has taken over the work that is easy to forget and tedious to move between tools. For me, this is already the outline of a digital employee. As we use it more deeply, we can keep adding Skills so that it understands the business and the way the team collaborates better over time.",
        ],
      },
    ],
  },
  {
    slug: "using-hermes-agent-as-a-discord-bot",
    category: "use-case",
    title: "Using Hermes Agent as a Discord bot to drive my 600-user server engagement",
    excerpt:
      "I host my mega Discord server with over 600 users, revolving around DWS, Minecraft, and Palworld...",
    publishedAt: "2026-09-01T18:28:41+08:00",
    coverImage: "/assets/blog/discord-hermes/cover.png",
    content: [
      {
        type: "image",
        src: "/assets/blog/discord-hermes/cover.png",
        alt: "A LightVela agent relaxing beside a Discord workspace illustration",
      },
      {
        type: "paragraph",
        emphasis: true,
        content: [
          "Hermes Agent gave my 600-user Discord server a more flexible way to handle engagement, recurring announcements, and everyday questions, while LightVela removed most of the VPS and terminal work needed to keep it online.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "I host my mega Discord server with over 600 users, revolving around DWS, Minecraft, and Palworld. Two issues have always been the most daunting: engagement and moderation. If only an AI agent could live in my Discord server to drive both of these things...",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/server-overview.png",
        alt: "The Krakhourse Discord server overview showing its members and activity",
      },
      {
        type: "heading",
        text: "From fixed-rule bots to an agentic bot",
      },
      {
        type: "paragraph",
        content: [
          "In the past, I downloaded pre-packaged Discord bots from sites like ",
          link("MEE6", "https://mee6.xyz/en"),
          " and ",
          link("Dyno", "https://dyno.gg/"),
          ", or even started a VPS on Tencent Lighthouse to code my own bot instance. Recently, however, I have been yearning for a Discord bot that is not limited by fixed-coded rules, but instead powered by an LLM. My hope was for my bot to become an engaging digital staff member in my server: something that could send messages on its own, help answer questions, and still stay bounded by the context and fixed rules I implemented.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "I have been testing with more than 20 bots now, each with its own strengths and weaknesses. I kept wondering whether there could be a bot that was all-inclusive, online 24/7, and empowered with an actual brain.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/existing-bots.png",
        alt: "A Discord member list showing several existing bots in the server",
        size: "narrow",
      },
      {
        type: "heading",
        text: "An agentic bot?",
      },
      {
        type: "paragraph",
        content: [
          "A bot is just a set of rules, so what about an agent? Obviously, I could not just ship Claude Code or Codex into my server because those are proprietary. The best starting point seemed to be the two tools that have been making waves in 2026: OpenClaw and Hermes Agent.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Although OpenClaw is well known for its mature ecosystem and high customization, I ultimately chose Hermes Agent because I was drawn to its persistent and evolving memory feature, scheduled automations, and Bot Mode designed around agents operating inside group chats. From my point of view, I wanted to create a bot that could emulate a real human, and I was comfortable with it growing and evolving over time.",
        ],
      },
      {
        type: "heading",
        text: "Hosting the agent",
      },
      {
        type: "paragraph",
        content: [
          "Hosting really comes down to two options: localhost or a VPS. Running Hermes locally would give me full control, but my computer would need to stay online. A VPS would mean managing deployment, updates, tokens, and connection issues myself. I personally do not fancy chatting with the terminal, despite all the AI tools around.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/channel-configuration.png",
        alt: "LightVela channel configuration showing Discord and other messaging channels",
      },
      {
        type: "paragraph",
        content: [
          "I then checked out a product everyone was talking about recently in the Discord community: ",
          link("LightVela", "/"),
          ". Having delved into its product documents, I found it was essentially a Hermes VPS that bypassed the complicated cloud-tooling and terminal-chatting steps. The site has a workspace where I can connect the bot to Discord, connect it with an LLM, and set automation rules.",
        ],
      },
      {
        type: "heading",
        text: "Choosing the bot brain",
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/model-configuration.png",
        alt: "LightVela model configuration showing a DeepSeek model selection",
      },
      {
        type: "paragraph",
        content: [
          "The next step was choosing which model should power the agent. LightVela lets me toggle between available models and enter the model I want to use, so I tested a few instead of assuming the most expensive option was necessary. For my Discord use case, DeepSeek V4 Flash was the cheapest model that still handled the server's Q&A, context, and routine messages well enough.",
        ],
      },
      {
        type: "heading",
        text: "Connecting the bot",
      },
      {
        type: "paragraph",
        content: [
          "The site still requires you to visit the ",
          link("Discord Developer Portal", "https://discord.com/developers/home"),
          ". I recommend reading the ",
          link("LightVela Discord channel guide", "/docs/configuration/channel-discord/"),
          " for the specifics. The rough steps are summarized below:",
        ],
      },
      {
        type: "ordered-list",
        ariaLabel: "Discord bot setup steps",
        items: [
          ["Create a Discord application in the ", link("Discord Developer Portal", "https://discord.com/developers/home"), "."],
          ["Add a bot, generate its token, and paste it into LightVela."],
          ["Enable Message Content Intent. Add Server Members Intent only if member or role information is needed."],
          ["Invite the bot with minimum permissions: View Channels, Send Messages, and Read Message History."],
        ],
      },
      {
        type: "paragraph",
        content: [
          "Overall, the connection appears more difficult than with the other channels, and some configuration around bot permissions and specific channel integration must be done directly in the portal. Hopefully LightVela can smooth the process and build it in-house soon, like MEE6 and Dyno have done.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/discord-oauth.png",
        alt: "Discord OAuth screen asking which server should receive the bot",
      },
      {
        type: "heading",
        text: "Giving it tasks",
      },
      {
        type: "paragraph",
        content: [
          "A feature I found useful was the ability to set automation tasks for my agent without delving into code. Since my server revolves around Palworld and we host a server-side tournament every Friday for all users, I used the automation feature to quickly enter the prompt and the time of operation.",
        ],
      },
      {
        type: "code",
        content: `Every Friday at 18:00, send a short reminder for the upcoming Palpagos Clash Cup.

Include:

Event: Palpagos Clash Cup
Start time: Saturday at 20:00 UTC
Registration: React with ⚔️ in #tournament-signups before Saturday 16:00 UTC
Questions: #tournament-help

Keep the message short and energetic. Use only the information above. If any event details are missing or outdated, notify a moderator instead of posting.`,
      },
      {
        type: "paragraph",
        content: [
          "There are options to set the time of a task at fixed intervals or on specific dates. I set this one specifically for Friday on a weekly basis, triggered at 18:00.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/automation-settings.png",
        alt: "LightVela automations screen showing a weekly Palworld event reminder",
      },
      {
        type: "paragraph",
        content: [
          "The automation then appears in my chat without consulting the bot to do so. Apart from that, I can @ the bot to engage with it directly. To manage token usage, I can limit the agent to specific chats. The bot is like an LLM that does the homework I set and lives in my chat as a personal assistant that can talk with me.",
        ],
      },
      {
        type: "paragraph",
        content: [
          "Sometimes I wonder whether I can set up multiple agents and have them converse with one another. That assumes I have an infinite token budget to spend, but given that I am using DeepSeek V4 Flash rather than Opus 5.0, it would still be quite affordable.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/discord-tournament-chat.png",
        alt: "A Discord tournament chat where the agent posts a reminder and answers questions",
      },
      {
        type: "heading",
        text: "Bot personalities!?",
      },
      {
        type: "paragraph",
        content: [
          "Bot personalities sounded fun, especially in the form of a soul. It is essentially a ",
          link("soul.md", "http://soul.md"),
          " file that guides the agent to behave as instructed. The choices offered were fairly rudimentary, akin to a replica of the MBTI system. LightVela does have the option to upload my own persona files, which gives me more room to personalize the bot.",
        ],
      },
      {
        type: "image",
        src: "/assets/blog/discord-hermes/soul-settings.png",
        alt: "LightVela Soul settings with persona cards and an upload persona file action",
      },
      {
        type: "heading",
        text: "My thoughts on LightVela",
      },
      {
        type: "paragraph",
        content: [
          "The product delivers a more sandboxed environment for customizing agents that are supposed to live in an instant messaging app, whether that means conversing with me or acting as a support buddy in a group chat. The group chat feature is, in my opinion, the real selling point. If an agent is purely one-to-one, I would rather use ChatGPT.",
        ],
      },
      {
        type: "heading",
        text: "Areas of improvement",
      },
      {
        type: "unordered-list",
        items: [
          ["A context-uploading space where I can easily customize the knowledge base of my agent."],
          ["Build the bot-development steps in-house, such as inviting Vela directly into Discord and customizing it in the workspace, instead of requiring a separate Discord Developer Portal setup."],
          ["Build more non-LLM-based rules customized for the Discord use case, such as polling, word monitoring, and punishment rules. Engaging with the bot through an LLM is fun, but some moderation steps are better handled without one."],
          ["Add the ability to spin up more mini-bots, each with independent contexts, that can converse with each other in one Discord server."],
        ],
      },
      {
        type: "paragraph",
        content: [
          "In the end, after some playtesting, I feel there will ultimately be limits to LLMs and agents. The master bot I envy would be a mixture of generative AI power to drive natural conversations, with room for fixed rules to drive actionable tasks. Perhaps the combination of LightVela and MEE6 would be the ultimate golden goose.",
        ],
      },
    ],
  },
] as const;

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function formatBlogPublishedAt(publishedAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(publishedAt));
}

export function formatBlogPublishedDate(publishedAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
  }).format(new Date(publishedAt));
}
