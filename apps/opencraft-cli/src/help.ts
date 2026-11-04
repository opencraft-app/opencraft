export const help = `Usage: opencraft <command> [options]
For Agent parent/child orchestration, call thread_cli in your execution.
Its private launcher uses this CLI's execution mode (OPENCRAFT_THREAD_CLI_CONNECTION).
  connection add <name> --ssh <alias> [--instance <id>] [--default] [--default-server <id|engine|label>]
  status [--server <id|engine|label>]  # all visible Servers when omitted
  server list
  project list [--server <id|engine|label>] [--cursor <cursor>]
  server models [--server <id|engine|label>] [--cursor <cursor>]
  interactions list <ref-or-link> [--cursor <cursor>]
  interactions show <ref-or-link> <interaction-id>
  interactions respond <ref-or-link> <interaction-id> --epoch <epoch> --revision <revision>
    --submission <id> --response-file <JSON-file>
  thread context <ref-or-link>
  thread commands <ref-or-link>
  thread options <ref-or-link>
  thread attachments <ref-or-link> [--message <client-message-id>] [--cursor <cursor>]
  thread create [text] [--server <id|engine|label>] --project <id|unique-name> --cwd <absolute-path> --key <key> [--permission-mode read-only|accept-edits|full]
    [--model <id>] [--reasoning-effort <effort>] [--message-file <file|->] [--wait delivered --timeout 30s]
  thread lookup [--server <id|engine|label>] --key <create-key>
  thread count [--server <id|engine|label>]  # recorded-only; exact or unknown
  Count uses a budget after authentication.
  thread search [--all-servers] [--server <id|engine|label>] --field name|text <query> [--cursor <cursor>]
  thread list [--all-servers] [--server <id|engine|label>] [--project <id>] [--cwd <absolute-path>] [--cursor <cursor>] [--include-title]
  thread show <ref-or-link>
  thread wait <ref-or-link> (--request <id> | --key <key> | --turn <id>) [--until terminal] [--timeout 30s] [--output]
  thread output <ref-or-link> (--request <id> | --key <key> | --turn <id>) [--cursor <cursor>]
  thread defaults <ref-or-link> --scope subsequent-native-turns-including-already-accepted --permission-mode <read-only|accept-edits|full> --collaboration-mode <plan|default> --model <id> --reasoning-effort <id>
  thread defaults <ref-or-link> --observe-only
  Defaults can affect other participants already accepted but unsent inputs. ACK is not saved or Turn usage. Unknown writes are never replayed.
  thread stop <ref-or-link> --expected-turn <id> [--observe-only]
  queue list <ref-or-link> [--cursor <cursor>] [--limit 1..100]
  queue cancel <ref-or-link> --request <request-id>
  thread log <ref-or-link> [--cursor <cursor> | --tail <1..5>]
  thread send <ref-or-link> [text] [--mode queue] --key <key>
    [--model <id>] [--reasoning-effort <effort>] [--message-file <file|->] [--wait delivered --timeout 30s]
    [--mode steer --expected-turn <exact-turn-id>]
  thread show <ref-or-link> --delivery <request-id>
  thread show <ref-or-link> (--delivery <id> | --delivery-key <key> | --turn <id>) --include-turn-configuration
  thread lookup <ref-or-link> --key <key>
Options: --connection <name> [--server <id|engine|label>] --json --help
--server accepts a full ID or an exact, case-sensitive engine/label unique within the connection.
Single-Server commands use the connection's --default-server, then the sole visible Server.
Otherwise choose --server; errors list full candidate IDs. References select their own Server.
status without --server lists all visible Servers, even with a connection default.
Set --default-server during connection add (full ID or unique engine/label; saved as a full ID).
Existing profiles: edit defaultServer in the connections file, or add a new profile name.
SSH uses your SSH config, agent/key and known_hosts.
show/list return metadata. log reads one bounded page.
Search name: NFC case-sensitive literal. Search text: imported public user/assistant Items, folded-token AND (NFKD/accent-insensitive/lowercase), not phrase/infix.
Text search count is unknown; empty pages may have --cursor=value continuations.
--tail N reads the latest N Turns (30 items/Turn, 2000 chars/text, 24KB total).
Tail entries are chronological text suffixes; partial/truncated mark omitted content.
Tail has no continuation cursor; repeat --tail N to observe new replies.
Non-interactive sends need --key. Pipe stdin or pass --message-file -.
Accepted is not completed. After disconnection, use lookup; do not resend.
Attention means open the UI. Configure --web-url during connection add for links.
`;

export const guide = `OpenCraft CLI 入门

1. 连接：先把本人 SSH 身份和已核验的主机公钥配置到 SSH config。
   opencraft connection add work --ssh my-employee-alias --default
2. 选择 server/project：从本人可见目录选支持所需能力的 Server。
   opencraft server list
   opencraft project list --server codex
   project list/create/wait/output 当前仅 Codex；以 server list 的 capabilities 为准。
3. 创建：项目 ID 来自上一步，cwd 是远端绝对路径，key 是本次操作的唯一标识。
   opencraft thread create --server codex --project PROJECT_ID --cwd /remote/repo --key task-01 --message-file ./task.md --wait delivered
   保存返回的 ref（或 uiLink）和 firstMessage.requestId；delivered 只表示接纳。
4. 等待并读结果：REF 使用返回的规范 ref/link，REQUEST_ID 使用首条回执。
   opencraft thread wait REF --request REQUEST_ID --timeout 5m --output
   默认 wait 只等精确 Turn 终态；--output 再沿分页读取该 Turn 的 final。
   failed/interrupted 也属于终态，taskOutcome 保持 unknown。
5. 单独读取与跟进：
   opencraft thread output REF --request REQUEST_ID
   若 nextCursor 非空，用同一目标加 --cursor='<nextCursor>' 继续。
   opencraft thread send REF --key followup-01 --message-file ./followup.md --wait delivered
   断线或结果未知：用原 key 查询 thread lookup，不换 key 重发。

只读观察（逐 Server 协商）：
   opencraft thread context REF
   最近原生记录的窗口用量；unknown 的 reason 说明缺失或读取限制，不用累计 tokens 代替。
   opencraft thread commands REF
   仅列引擎公布的斜杠命令；未提供目录的引擎明确 unsupported，不复制 UI/skills 菜单。

opencraft <command> --help 查看该命令用法和示例。
opencraft --version 查看本机 CLI 版本及构建 source；更新后再次核对。
`;

const examples: Record<string,string> = {
  'connection add': 'opencraft connection add work --ssh my-employee-alias --default --default-server codex',
  status: 'opencraft status --json', 'server list': 'opencraft server list --json',
  'project list': 'opencraft project list --server codex', 'server models': 'opencraft server models --server codex',
  'thread create': 'opencraft thread create --server codex --project PROJECT_ID --cwd /remote/repo --key task-01 --message-file ./task.md --wait delivered',
  'thread send': 'opencraft thread send REF --key followup-01 --message-file ./followup.md --wait delivered',
  'thread wait': 'opencraft thread wait REF --request REQUEST_ID --timeout 5m --output',
  'thread output': 'opencraft thread output REF --request REQUEST_ID',
  'thread lookup': 'opencraft thread lookup REF --key task-01',
  'thread search': 'opencraft thread search --all-servers --field name release',
  'thread list': 'opencraft thread list --all-servers --include-title',
  'thread defaults': 'opencraft thread defaults REF --observe-only',
  'thread stop': 'opencraft thread stop REF --expected-turn TURN_ID --observe-only',
  'thread log': 'opencraft thread log REF --tail 2',
  'thread show': 'opencraft thread show REF',
  'thread context': 'opencraft thread context REF',
  'thread commands': 'opencraft thread commands REF',
  'thread options': 'opencraft thread options REF',
  'thread count': 'opencraft thread count --server codex',
  'thread attachments': 'opencraft thread attachments REF',
  'queue list': 'opencraft queue list REF --limit 100',
  'queue cancel': 'opencraft queue cancel REF --request REQUEST_ID',
  'interactions list': 'opencraft interactions list REF',
  'interactions show': 'opencraft interactions show REF INTERACTION_ID',
  'interactions respond': 'opencraft interactions respond REF INTERACTION_ID --epoch EPOCH --revision REVISION --submission reply-01 --response-file ./answer.json',
};
export function commandHelp(args: string[]): string {
  if (!args.length) return help + '\n  guide  # connection → project → create → wait → output → send\n  --version, -V  # CLI version and build source\n';
  const command = args.slice(0,args[0] === 'status' || args[0] === 'guide' ? 1 : 2).join(' ');
  if (command === 'guide') return 'Usage: opencraft guide [--json]\n\nExample: opencraft guide\n';
  const blocks: string[] = [];
  let current = '';
  for (const line of help.split('\n')) {
    if (/^  (?:connection|status|server|project|interactions|thread|queue)\b/u.test(line)) {
      if (current) blocks.push(current);
      current = line.trimStart();
    } else if (/^    /u.test(line) && current) current += '\n' + line;
    else if (current) { blocks.push(current); current = ''; }
  }
  if (current) blocks.push(current);
  const matches = blocks.filter(block => block === command || block.startsWith(command + ' '));
  if (!matches.length) return `Unknown command: ${command}.\nUse opencraft --help.\n`;
  const leaf = Object.hasOwn(examples,command);
  const usage = matches.map(block => (leaf ? 'Usage: opencraft ' : '  opencraft ') + block).join('\n');
  const capabilities = /^(project|server models|thread|queue|interactions)/u.test(command)
    ? '\nEngine support: project list, thread create/wait/output/log and advanced controls currently require Codex. Other capabilities vary by Server; check server list. Unsupported errors name the selected Server and compatible alternatives.\n' : '';
  const notes = command === 'thread context' ? '\nLatest recorded context-window usage, not cumulative billing tokens. unknown includes a bounded reason. Currently Codex only.\n'
    : command === 'thread commands' ? '\nEngine-advertised slash command names only. Current Codex/DSH/Pi adapters do not advertise a slash catalog: unsupported, never a fabricated empty list.\n'
    : command === 'thread wait' ? '\n--output reads all final pages within the same timeout. Failed/interrupted are terminal; inspect turnState and finalUnavailable. Default wait returns metadata only.\n'
    : ['thread list','thread search'].includes(command) ? '\n--all-servers reads one page per visible Server, ignoring the connection default. Results retain each serverId, nextCursor and errors. Continue with --server FULL_ID --cursor=CURSOR; no global ordering or total. Cannot combine with --server/--cursor/--project/--cwd.\n' : '';
  return `${leaf ? '' : 'Usage: opencraft ' + command + ' <command> [options]\n\n'}${usage}\n\nOptions: --connection <name> --server <id|engine|label> --json --help\nREF is a canonical conversation ref/link, or a thread ID with --server.\n${capabilities}${notes}\nExample: ${examples[command] ?? (command === 'thread' ? examples['thread create'] : 'opencraft ' + matches[0]!.split('\n')[0])}\n`;
}
