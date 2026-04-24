# nextgen-dashboard Design Notes

## What This Project Is

`nextgen-dashboard` is not a spreadsheet-style admin panel with a terminal skin.

It is a real operator surface built around a real shell:

- the browser is just a terminal client
- the shell is the primary interface
- structured admin reads are exposed as CLI commands, not as fake dashboard cards

The goal is to feel closer to a compact Unix workstation than to a CRUD backoffice.

## Core Principles

### 1. Shell-First, Not Terminal-Themed

The terminal should not simulate shell behavior from inside the frontend.

Instead:

- `/admin` opens directly into a real bash session
- common tools are available in the runner image
- structured operations are available from inside that same shell

If a feature only works in a special command mode and not in the shell, that is the wrong abstraction.

### 2. Go Owns Control, Not Pretend Shell UX

Go is responsible for:

- HTTP Basic Auth
- websocket session brokering
- command registry
- structured JSON responses
- proxy auth and auditing boundaries

Go should not reimplement `grep`, `find`, file navigation, or other standard shell behavior. That belongs to the actual shell environment.

### 3. Real Tools Beat Wrapper Theater

The runner image should contain real operator tools:

- `bash`
- `tmux`
- `screen`
- `vim`
- `curl`
- `wget`
- `mysql`
- `redis-cli`

For structured admin commands, `lcctl` is the real binary. Convenience entrypoints like `users`, `subscriptions`, and `sandboxes` should behave like BusyBox-style aliases via symlinks to the same binary, not shell wrapper scripts in `/bin`.

That keeps the image cleaner, more Unix-like, and easier to reason about.

### 4. Static Frontend, Single Go Project

This project deliberately keeps frontend and backend in one repository subtree:

- frontend builds to static assets
- Go serves those assets
- the public mount point is `/admin`

The browser layer is intentionally thin. Most of the product value is in shell access, command routing, and safe operational boundaries.

### 5. Split the Web Surface From the Runner

The deployment model is:

- `admind`: serves `/admin`, authenticates, proxies, and audits
- `ops-runner`: owns the PTY and the actual shell process

This is still one project and one deployable unit, but the split matters:

- the web layer does not need to be the shell
- the shell layer does not need unrelated admin secrets
- operational tools can grow without bloating request handling code

### 6. Structured Output Still Matters

Even in a shell-first system, some operations should stay structured.

Examples:

- `users list --json`
- `subscriptions list --json`
- `sandboxes list --json`

This keeps the operator experience scriptable and lets the browser terminal, local CLI clients, and future automation all share the same command surface.

### 7. Secrets Should Not Leak Into Shell By Default

The shell environment should be intentionally minimal.

It may receive:

- `PATH`
- `HOME`
- `TERM`
- the proxy variables required for `lcctl`

It should not inherit unrelated database DSNs or other control-plane secrets just because the pod has them.

## Practical Consequences

These decisions imply a few rules for future changes:

- prefer making the real shell better over inventing more frontend command abstractions
- prefer adding real binaries or real symlinks over shell wrapper shims
- prefer `lcctl` subcommands for structured admin reads
- keep `/admin` feeling immediate, sparse, and terminal-native
- do not let the UI drift back toward a conventional forms-and-tables backoffice

## Short Version

The design target is:

`a small, sharp Unix operator station exposed over the web`

Not:

`an admin dashboard pretending to be a terminal`
