## stage
Original credential synchronized and read-only Git authentication validated; requested `/data` copy completed and checked.

## verified
- Mac Git uses the `osxkeychain` HTTPS helper for `git.woa.com`; the secret value was never displayed.
- The requested personal credential was transferred via SSH into the OpenCraft service's root-only state HOME, with credential helper lookup scoped to `wisp/mono2.git`.
- From that HOME, non-interactive `git ls-remote` for the private mono2 repository succeeded.
- The service is active as root, its `/data` mount is writable, and it remains reachable without application authentication.
- `/data/.opencraft-git/credentials` is a byte-identical root-only copy; directory mode 0700 and file mode 0600. The active Git helper remains pointed at the original credential.

## unverified
- No full clone was started; clone usability is inferred from the same Git HTTPS authentication path used by the successful `ls-remote`.
- No token scope reduction or account-side read-only restriction was proven. URL-scoped helper lookup does not narrow the token's underlying permissions.

## discard
- The earlier option to provision a separate read-only deploy key; the user expressly selected syncing their existing personal credential.

## restore
- Credential values must never be copied into this file, tool output, logs or Git.
- Exact server-owned configuration is outside the repository under the service's `/var/lib/opencraft-preview-codex-20260923173651` HOME.
- The interrupted iOS commit/push/merge request has not been completed; its isolated worktree was created from `origin/master` but contains no patch yet.

## next_action
- If the user wants Git to use the `/data` copy instead of the original, update the service HOME's path-scoped helper only after that separate request; do not move or delete either credential implicitly.
