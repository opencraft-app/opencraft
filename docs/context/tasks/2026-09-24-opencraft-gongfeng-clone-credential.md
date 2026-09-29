## goal
Allow the deployed OpenCraft Web Codex Host to clone `https://git.woa.com/wisp/mono2.git` using the user's existing Mac Git HTTPS credential, without revealing it in logs or repository files.

## non_goals
- Commit, push, or merge the unfinished iOS Web change.
- Copy the entire Mac Keychain, SSH private keys, or unrelated credentials.
- Change OpenCraft Web access control or server privilege policy.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-24: sync the Mac Git clone credential to the deployed Web server. After an explicit risk warning, the user selected syncing the personal credential rather than a separate read-only deploy key.

## interface_refs / data_structure_refs
- Mac Git HTTPS helper: `osxkeychain` for `git.woa.com`; no credential value is printed.
- Headless service environment: `HOME=/var/lib/opencraft-preview-codex-20260923173651`, `User=root`, `ProtectHome=yes`.
- Git credential-store file and service HOME `.gitconfig` are outside all repositories, root-only, and path-scoped to `wisp/mono2.git` for helper lookup.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` headless Host credential and capability boundary.
- `relevant_evolution`: the WebUI listens without application authentication while the service runs as root; this was explicitly chosen for this test server.
- `superseded_refs`: none.

## acceptance
- The server-side Git process can perform a non-interactive read-only `ls-remote` for `wisp/mono2.git` from the same HOME as the Web Codex process.
- No token or password appears in command arguments, stdout/stderr, logs, repository files, Task Packs, or tool responses.
- The stored credential and helper config are owned by root with mode 0600; no unrelated Keychain item is copied.

## affected_paths
- External test host only: root-owned state under `/var/lib/opencraft-preview-codex-20260923173651`.
- This Task Pack contains metadata only, never credential values.

## required_context
- Context router found no Pack; OpenCraft local Agent entry and maintenance skill apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft credential ownership and verification | Preserve Host-side secret boundary |
| `.agents/skills/gongfeng/SKILL.md@working-tree` | Gongfeng access workflow | Avoid unsupported API calls and secret exposure |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack format | Record evidence without secrets |

## evidence
- Mac Git uses `osxkeychain` and the mono2 remote is HTTPS `git.woa.com/wisp/mono2.git`.
- Before transfer, the test service was active as root with its explicit state HOME and no Git credential helper configured there.
- The user's Mac Git helper returned the expected credential fields; only field names were displayed, never values. The fields were streamed through SSH directly into a root-only Git credential-store file with the requested repository path.
- Server config and credential file are both mode 0600, the containing directory is mode 0700, and all are root-owned. Git URL matching finds the helper for `wisp/mono2.git` and not for another repository path.
- Non-interactive `git ls-remote https://git.woa.com/wisp/mono2.git HEAD` succeeded with the service HOME and no interactive prompt. The active service mount namespace shows `/data` as `rw`, and the service user is root.

## risks
- Anyone able to operate the unauthenticated root-capable WebUI may read the synchronized personal credential. The user accepted this specific risk after being warned.
- Git credential helper lookup can be path-scoped, but this does not narrow the token's actual server-side account permissions.
- Rollback is removal of the exact new Git config/credential files, not alteration of the user's Mac Keychain.

## validation
- Read-only non-interactive Git remote check from the service HOME; file owner/mode check; no secret output.

## decisions
- Use the Mac's Git HTTPS credential only for the requested Gongfeng host and repository path; never copy SSH private keys or whole credential stores.

## scan_scope
- Current Git config, current systemd service unit and state-home metadata only.

## scan_output
- Read-only command summaries in evidence; no decrypted payloads.

## handoff
- Credential transfer and read-only authentication verification complete. No clone was started, no service restart or source change was needed, and the earlier iOS commit/push/merge request remains unfinished. This is a persistent personal credential on an unauthenticated root-capable Web service, as explicitly accepted by the user; rotation or revocation must be performed at the original Gongfeng account and then resynchronized.
- Follow-up request: copy the root-only credential to `/data/.opencraft-git/credentials` without changing the active Git helper. The first attempt was blocked by network timeouts before any remote file operation. On the resumed turn, SSH recovered; read-only checks confirmed a root-owned 0600 source and absent target. The copy completed, `cmp` confirmed exact byte equality without printing contents, the new hidden directory under `/data` is root-owned 0700 and its credential file root-owned 0600, and the active Git helper still points to the original state-directory credential. The service remained active; no restart was performed for this copy.
