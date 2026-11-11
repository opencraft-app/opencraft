/** Self-contained launcher; the Host materializes it without a second client library. */
export async function threadCli(argv: string[]): Promise<void> {
  const { readFile, lstat } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const help = `opencraft thread <command> [options]
opencraft automation <list|show|create|update|pause|resume|delete|run|runs> [options]
  automation list --project-id <id> [--cursor <cursor>] [--limit <1..100>]
  automation show <id>
  automation create --grant-id <human-grant-id> --schedule <JSON> --idempotency-key <key>
  automation update <id> --revision <number> --schedule <JSON> --idempotency-key <key>
  automation pause|resume|delete <id> --idempotency-key <key>
  automation run <id> --occurrence-id <id> --run-key <automationId:revision:occurrenceId> --idempotency-key <key>
  automation runs <id> [--cursor <cursor>] [--limit <1..100>]
Every command accepts --help and --json. Schedule JSON uses kind=once with at (Unix ms), or kind=cron with expression and IANA timezone.
Create requires a human project grant from the authenticated automation grant API.
  context (also: opencraft context)
  output <reference> [--cursor <cursor>]
  operation show <operation-id>
  input status <operation-id>
  list --children [--cursor <cursor>] [--limit <1..100>]
  spawn --prompt <text> --idempotency-key <key> [--title <title>] [--driver codex|pi|dsh|acp|claude-code] [--cwd <path>]
  show <opencraft://conversation/v1/...> [--turns <1..5>]
  tell <reference> --message <text> --idempotency-key <key> [--delivery native|queue|interrupt] [--expected-turn <id>] [--reply-expectation required|none]
  wait <reference>... [--timeout <0..5000>] [--wait-for all_settled|any_settled]
Output is JSON. Follow nextCursor even on an empty filtered page. Reuse the same key after an uncertain write; never invent a new key to retry it.
Tool/delivery completion is not task completion. An unsettled wait remains subscribed. Respect direct human input and stops; do not automatically restart stopped work.
Use an existing conversation for follow-ups. Delegate independent work when useful; review child results and report relevant outcomes. Do not relay acknowledgments automatically.
This launcher is bound to the execution that opened it. Rediscover with opencraft context in the current execution; do not copy credentials or inspect connection.json.`;
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') { process.stdout.write((argv.includes('--json')?JSON.stringify({help}):help) + '\n'); return; }
  let command: string | undefined;
  const args: Record<string,unknown> = {};
  let key: string | undefined;
  if(argv[0]==='automation') {
    argv.shift();const action=argv.shift();
    const allowed:Record<string,string[]>={list:['projectId','cursor','limit'],show:[],create:['grantId','schedule'],update:['revision','schedule'],pause:[],resume:[],delete:[],run:['occurrenceId','runKey'],runs:['cursor','limit']};
    if(!action || !allowed[action])throw Error('Unknown automation command; use --help');
    const options:Record<string,string>={'--project-id':'projectId','--cursor':'cursor','--limit':'limit','--grant-id':'grantId','--schedule':'schedule','--revision':'revision','--run-key':'runKey','--occurrence-id':'occurrenceId'};
    const positions:string[]=[],seen=new Set<string>();
    while(argv.length) {
      const option=argv.shift()!;
      if(!option.startsWith('--')){positions.push(option);continue;}
      if(seen.has(option))throw Error('Duplicate option');seen.add(option);
      if(option==='--json')continue;
      const field=options[option];
      if(option!=='--idempotency-key' && (!field || !allowed[action]!.includes(field)))throw Error('Invalid automation option');
      const value=argv.shift();if(value===undefined)throw Error('Missing option value');
      if(option==='--idempotency-key'){key=value;continue;}
      args[field!]=field==='schedule'?JSON.parse(value):['limit','revision'].includes(field!)?Number(value):value;
    }
    if(['list','create'].includes(action)){if(positions.length)throw Error('Unexpected positional argument');}
    else {if(positions.length!==1)throw Error('One automation identifier required');args.id=positions[0];}
    if(!['list','show','runs'].includes(action) && !key)throw Error('An explicit --idempotency-key is required');
    command='automation.'+action;
  } else {
  if (argv[0] === 'context') argv.unshift('thread');
  if (argv.shift() !== 'thread') throw Error('Expected opencraft thread; use --help');
  command = argv.shift(); const positions: string[] = [];
  if (command === 'operation' || command === 'input') {
    const subcommand=argv.shift();
    if (subcommand !== (command === 'operation' ? 'show' : 'status')) throw Error('Unknown subcommand');
  }
  const options: Record<string,string> = {'--prompt':'prompt','--title':'title','--driver':'driver','--cwd':'cwd','--cursor':'cursor','--limit':'limit','--turns':'includeRecentTurns','--message':'message','--delivery':'delivery','--expected-turn':'expectedTurnId','--reply-expectation':'replyExpectation','--timeout':'timeoutMs','--wait-for':'waitFor'};
  const allowed: Record<string,readonly string[]> = {context:[],output:['cursor'],operation:[],input:[],list:['cursor','limit'],spawn:['prompt','title','driver','cwd'],show:['includeRecentTurns'],tell:['message','delivery','expectedTurnId','replyExpectation'],wait:['timeoutMs','waitFor']};
  if (!command || !allowed[command]) throw Error('Unknown command; use --help');
  const seen = new Set<string>(); let children = false;
  while (argv.length) {
    const option = argv.shift()!;
    if (!option.startsWith('--')) { positions.push(option); continue; }
    if (seen.has(option)) throw Error('Duplicate option'); seen.add(option);
    if(option==='--json')continue;
    if (option === '--children' && command === 'list') { children = true; continue; }
    const field = options[option];
    if (option !== '--idempotency-key' && (!field || !allowed[command]!.includes(field))) throw Error('Invalid option; use --help');
    const value = argv.shift(); if (value === undefined) throw Error('Missing option value');
    if (option === '--idempotency-key') { key = value; continue; }
    args[field!] = ['limit','includeRecentTurns','timeoutMs'].includes(field!) ? Number(value) : value;
  }
  if (command === 'list' && !children) throw Error('Use list --children');
  if (command === 'operation' || command === 'input') { if(positions.length!==1) throw Error('One identifier required'); args.id=positions[0]; }
  else if (['show','tell','output'].includes(command)) { if (positions.length !== 1) throw Error('One conversation reference required'); args.reference = positions[0]; }
  else if (command === 'wait') { if (!positions.length) throw Error('Conversation references required'); args.references = positions; }
  else if (positions.length) throw Error('Unexpected positional argument');
  if (['spawn','tell'].includes(command) && !key) throw Error('An explicit --idempotency-key is required');
  }
  const path = process.env.OPENCRAFT_THREAD_CLI_CONNECTION ?? join(dirname(process.argv[1]!), 'connection.json'), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 16_384) throw Error('Invalid private CLI connection');
  const config = JSON.parse(await readFile(path, 'utf8')), url = new URL(config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/thread-cli' || url.username || url.password || url.search || url.hash || typeof config.token !== 'string') throw Error('Invalid local CLI endpoint');
  const response = await fetch(url, {method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},
    body:JSON.stringify({command,arguments:args,...(key ? {idempotencyKey:key} : {})}),redirect:'error',signal:AbortSignal.timeout(30_000)});
  const reply = await response.json() as {result?:unknown;error?:string};
  if (!response.ok || reply.error) { process.stdout.write(JSON.stringify({error:reply.error??'thread_cli_outcome_unknown'})+'\n');process.exitCode=1;return; }
  process.stdout.write(JSON.stringify(reply.result)+'\n');
}
