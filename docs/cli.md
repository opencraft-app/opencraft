# OpenCraft CLI

The bundled `opencraft` command connects to a Headless server through its
authenticated OpenCraft SSH ingress. Configure your own SSH identity, agent and
known_hosts first. System maintenance SSH access alone does not grant an Actor.
The existing managed website launcher remains `opencraft-web`; service units
continue to use their installed runtime entry.

```sh
opencraft connection add work --ssh my-opencraft --default --json
opencraft server list --json
opencraft status --server '<server-id>' --json
opencraft thread list --server '<server-id>' --json
opencraft thread show '<conversation-uri-or-https-link>' --json
opencraft thread log '<conversation-uri>' --json
opencraft thread log '<conversation-uri>' --cursor '<nextCursor>' --json
opencraft thread send '<conversation-uri>' 'Review this change' --mode queue --key review-01 --json
opencraft thread send '<conversation-uri>' --message-file ./message.txt --key review-02 --wait delivered --timeout 30s --json
opencraft thread lookup '<conversation-uri>' --key review-01 --json
opencraft thread show '<conversation-uri>' --delivery '<request-id>' --json
opencraft thread send '<conversation-uri>' 'Adjust the current turn' --mode steer --expected-turn '<exact-turn-id>' --key steer-01 --wait delivered --json
opencraft thread list --server '<server-id>' --project '<project-id>' --cwd /remote/repo --json
```

Profiles contain only the SSH alias, expected installation identity and optional
default Server. They are stored at `~/.config/opencraft/connections.json`;
`OPENCRAFT_CONFIG` selects another file. Set `--default-server` during connection
registration to choose an explicit default. `--connection` overrides
`OPENCRAFT_CONNECTION`, which overrides the configured default. Multiple Servers
require a selection. Explicit options that conflict with a URI fail. Links are
parsed locally and never cause requests to their origin. Unknown installations
and legacy page links are not guessed.

Project filters use exact IDs, never project names. `--cwd` is an absolute path
in the selected Server's filesystem and is normalized there; the caller's cwd
is not substituted. Each request remains a bounded native catalog page. Filters
are negotiated independently; this release supports Codex filters, and other
engines explicitly return unsupported rather than ignore a filter.

Steer requires `--mode steer --expected-turn <exact-turn-id>`. It targets only
that running Turn; stale/finished Turns are rejected without queue fallback.
The Turn ID from a known delivery receipt can be used as the explicit target.
Metadata may leave currentTurnId null when it cannot establish the native value.
Queue remains the default mode.

`attention` contains only the waiting kind and available interaction identity,
never questions or approval payloads. Approval/question native flags are exposed;
unavailable login/setup details are not guessed. Configure the connection with
`--web-url https://your-server.example/` to attach a canonical UI link. Without a
configured public URL the link is null. Open that UI to act; the CLI does not
answer interactions. Queue acceptance can carry the last observed attention and
timestamp while remaining unconsumed. Recovery metadata comes from the existing
Host recovery read; recovering/unknown/idle do not establish task completion.
Recovery reads are optional and bounded to one second; unavailable recovery stays
null while native metadata remains available. Steer performs no attention read.
Queue is durably accepted before its optional attention read, which has a
two-second budget. Failure reports an unknown attention kind and preserves
the accepted receipt; it cannot delay admission behind a slow Host read.

`list` and `show` return metadata without titles, previews, messages or tools.
`list --include-title` includes only explicit native titles, without a preview
fallback. Metadata reads use native metadata operations, with rollout repair
disabled on discovery. Unavailable facts remain null or unknown. `log` explicitly
reads user/assistant text, one bounded native item per page and at most 2,000
Unicode characters per chunk; follow `nextCursor` to preserve long-message tails.
Tool items can produce an empty page with a continuation. A changed watermark
requires a new read without a cursor. The CLI never resumes a conversation.
This first CLI release supports bounded logs on Codex. Other engines report
`read:false` and `boundedRead:false` in the directory and reject CLI logs with
`UNSUPPORTED_CAPABILITY`. Their existing conversation readers remain available
through their original consumers; the CLI never selects those readers.

Send accepts positional text, a UTF-8 `--message-file`, or stdin (including
`--message-file -`); choose one. Non-interactive calls require an explicit `--key`.
Interactive calls can generate a key saved before sending, with only the Actor,
installation, target and timestamp, in `operations/` beside the profiles file.
Identical Actor/key/payload repeats return the original request; changed content
or target conflicts. A disconnected send returns exit 7 and the original key.
Use `thread lookup --key` or `thread show --delivery-key` for read-only accounting;
a missing record remains unknown and is not permission to resend or change keys.

`--wait delivered` polls until submitted/injected, which means the engine accepted
the input. It does not mean the task completed: `taskOutcome` remains unknown.
Timeout/disconnection exits 7 and preserves the key and known receipt. Explicit
rejection/cancellation while waiting exits 8. Querying those facts succeeds with
exit 0. The CLI creates no second queue and never resumes or stops the target.

Every `--json` invocation writes exactly one envelope to stdout:
`{schemaVersion:1,ok:true,data:...}` or
`{schemaVersion:1,ok:false,error:{code,message,retryable,details?}}`.
Additive fields are compatible; breaking changes require a new schema major.
Capabilities are negotiated individually. Older Hosts return
`UNSUPPORTED_CAPABILITY`; content reads are never a metadata fallback.

| Exit | Meaning |
| --- | --- |
| 0 | Command succeeded; this does not establish task completion |
| 2 | Invalid arguments, input or configuration |
| 3 | Unregistered or unavailable connection, instance or resource |
| 4 | Authentication or permission required |
| 5 | Ambiguity or state conflict, including changed history |
| 6 | Unsupported link, protocol or capability |
| 7 | Timeout, disconnection or uncertain result |
| 8 | Explicit server rejection or internal failure |

Run `opencraft --help` for the installed command set. HTTPS credential exchange,
desktop CLI admission and Session bearer admission are separate future work.

## Current execution and child conversations

Human SSH profiles retain the commands above. Inside an authorized Agent
execution, `thread_cli` returns a private launcher and connection-file path.
The launcher and the existing CLI share the same execution command implementation;
the installed CLI selects it with `OPENCRAFT_THREAD_CLI_CONNECTION=<private-path>`.
It adds context, paginated child discovery, spawn, tell and wait over the existing
Broker. See [Conversation CLI](thread-cli.md). The environment variable contains a
file path, never a bearer; do not copy connection files or switch to a human SSH
profile when execution authorization fails.
