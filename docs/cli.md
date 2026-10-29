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
```

Profiles contain only the SSH alias, expected installation identity and optional
default Server. They are stored at `~/.config/opencraft/connections.json`;
`OPENCRAFT_CONFIG` selects another file. Set `--default-server` during connection
registration to choose an explicit default. `--connection` overrides
`OPENCRAFT_CONNECTION`, which overrides the configured default. Multiple Servers
require a selection. Explicit options that conflict with a URI fail. Links are
parsed locally and never cause requests to their origin. Unknown installations
and legacy page links are not guessed.

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
