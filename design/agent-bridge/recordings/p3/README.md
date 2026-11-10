# P3 real ACP initialize and minimal-task recordings

These are acceptance evidence, not replay fixtures. Each file contains:

- the P1a bridge handshake request/response,
- the actual ACP `initialize` request and response captured from the installed
  agent (the bridge's private wire trace),
- the session plan returned by `session/create` (permission mode, model
  selector, probed capabilities),
- the minimal task result in a throwaway directory (`p3-accept.txt` content,
  final text, tool item count),
- the steer response, `input.delivery`, `input.evidence`, and (where captured)
  the queued/native turn text,
- explicit gaps and notes.

Paths are redacted to `<workspace>`, `<repo>` and `<home>`. Credentials and
tokens are not recorded. Native session/turn ids are opaque correlation ids.
The bridge handshake embedded in these files was captured before the final
tightening of the declaration (`echo` evidence removed; content limit lowered
from 512 KiB to 360 KiB). The raw ACP `initialize` request/response and the
task/steer facts are unchanged and actual.

| File | Agent | initialize | Steer evidence |
| --- | --- | --- | --- |
| `copilot-initialize.json` | GitHub Copilot CLI 1.0.102 | no `_meta.midTurnSteering`; image/loadSession declared | explicit `next-turn`; queued turn answered `STEERED`; admission, not native |
| `amp-initialize.json` | Amp ACP 0.10.0 (installed `8ef5b5ab` snapshot) | `_meta.midTurnSteering=true`; image declared | `native-inject` admitted during the active turn; final answer `WAITED STEERED`; admission only (the bridge does not use text echo as identity) |

The deterministic ACP fixture
(`tests/agent-bridge/fixtures/acp-agent.mjs`) and its captured transcript
(`tests/agent-bridge/fixtures/acp-transcript.json`) cover native translation,
permission approval/decline, images, next-turn, interrupt-replace, withdrawal
and agent-exit→unknown without real model quota.

Reproduce with:

```sh
npx tsx scripts/smoke/agent-bridge/p3-real-acp.ts --agent copilot --out /tmp/copilot.json
npx tsx scripts/smoke/agent-bridge/p3-real-acp.ts --agent amp --out /tmp/amp.json
```

Each run consumes real quota and runs exactly one minimal task plus one steer.
