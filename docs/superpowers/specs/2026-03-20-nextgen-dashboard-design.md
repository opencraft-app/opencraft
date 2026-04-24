# Nextgen Dashboard — Admin Terminal Design Spec

> A Go-first admin terminal dashboard mounted under `/admin`, serving a static React frontend and a websocket-backed operator terminal for production operations.

---

## 1. Overview

### Purpose

Build a new admin surface for Lightclaw that behaves like a browser-based operations terminal instead of a conventional CRUD dashboard.

The operator experience should:

- open at `https://lightclaw.tech/admin`
- authenticate with HTTP Basic Auth
- render a terminal-first UI in the browser
- support interactive shell sessions through websocket
- support stable built-in management commands with optional `--json` output

This is a new project under `nextgen-dashboard/`. It should not reuse the old `gateway-dashboard` structure.

### Product Positioning

This is not a generic admin panel. It is an operator console with:

- terminal-first interaction
- TUI-like mental model
- explicit operational commands
- browser delivery and web auth

### Key Decisions

| Dimension | Choice |
|-----------|--------|
| Project layout | Single new directory: `nextgen-dashboard/` |
| Backend | Go |
| Frontend | React + shadcn/ui + xterm.js |
| Frontend delivery | Static build embedded into Go binary |
| Runtime mount path | `/admin` |
| Auth | HTTP Basic Auth |
| Interactive transport | WebSocket |
| Shell model | Sidecar `ops-runner` container in same Pod |
| Structured command output | Native Go commands with `--json` |
| Deployment model | One workload, two containers: `admind` + `ops-runner` |

---

## 2. Goals and Non-Goals

### Goals

1. Provide a terminal UI in the browser for operators.
2. Support a real interactive shell.
3. Support built-in admin commands with machine-readable output.
4. Keep frontend and backend in one project, but still preserve clear frontend/backend separation internally.
5. Serve frontend assets directly from Go.
6. Mount cleanly under `/admin`.

### Non-Goals

1. No multi-runner scheduling for v1.
2. No persistent terminal resume across pod restarts.
3. No RBAC matrix or multi-role operator model in v1.
4. No public internet exposure without an existing outer protection layer.
5. No separate frontend deployment pipeline.

---

## 3. User Experience

### Entry Flow

1. User opens `/admin`.
2. Browser prompts for HTTP Basic Auth.
3. After auth, Go serves the static app shell.
4. Frontend opens a websocket to the terminal endpoint.
5. User can:
   - run built-in commands
   - switch into shell mode
   - inspect structured results in terminal output

### UI Shape

The page should feel like a serious operator workstation, not a form-heavy dashboard.

Recommended composition:

- Main area: terminal panel powered by xterm.js
- Secondary rail: help, recent commands, environment summary, session state
- Optional top strip: current environment, auth identity, connection state

The interface should be intentionally sparse. Most actions should happen through commands, not button forests.

---

## 4. Functional Scope

### 4.1 Interactive Terminal

The frontend terminal must support:

- keyboard input
- stdout/stderr streaming
- terminal resize
- reconnect-safe session bootstrapping
- explicit shell session start/stop

The backend websocket protocol must support at least:

- input frames
- output frames
- resize frames
- status frames
- error frames

### 4.2 Built-in Admin Commands

The first release should include these built-in commands:

- `help`
- `users list`
- `users get <id>`
- `subscriptions list`
- `sandboxes list`
- `shell`

Each structured command should support:

- human-readable default output
- `--json`

Example:

```bash
users list
users list --json
users get usr_123 --json
```

### 4.3 Real Shell Access

The `shell` command should start a real PTY session in the sidecar container.

Available tools in the sidecar should include:

- `bash`
- `kubectl`
- `mysql`
- `redis-cli`
- other explicitly approved ops tools

The shell is intended for operators, not end users.

---

## 5. Architecture

### 5.1 Deployment Shape

Single Kubernetes workload with two containers:

- `admind`
  - Go web server
  - static asset serving
  - Basic Auth
  - websocket handling
  - built-in command execution
  - audit logging
- `ops-runner`
  - shell runtime
  - PTY host
  - preinstalled operator tooling

This keeps UI/API concerns separated from shell concerns without forcing a distributed terminal scheduler.

### 5.2 Internal Boundary

`admind` is the control plane.

Responsibilities:

- authenticate requests
- serve `/admin`
- validate command execution
- run built-in read/admin commands directly
- broker websocket sessions
- forward shell traffic to the runner
- produce structured logs and audit events

`ops-runner` is the execution plane.

Responsibilities:

- host PTY sessions
- run approved shell tools
- remain isolated from static app concerns

### 5.3 Frontend/Backend Separation

The project remains a single project, but the internal structure should be cleanly split:

- `web/`
  - React app
  - shadcn/ui
  - xterm.js integration
- `cmd/admind/`
  - Go entrypoint
- `internal/`
  - auth
  - websocket
  - commands
  - shell bridge
  - audit logging
  - static asset serving

The frontend build output is copied or embedded into the Go binary. Go is the only runtime web server.

---

## 6. Routing and HTTP Surface

### Frontend

- `GET /admin`
- `GET /admin/*`

All frontend routes should work from this prefix.

### API

- `GET /admin/api/session`
- `GET /admin/ws/terminal`
- `POST /admin/api/commands/execute` (optional for non-terminal command execution)

The browser terminal itself will use websocket for interactive mode.

### Terminal Transport

Terminal traffic should use websocket, not SSE and not polling.

Reasons:

- PTY is full duplex
- resize events need low-latency control messages
- shell interaction maps naturally to websocket streams

---

## 7. Auth and Security

### Auth

Use HTTP Basic Auth in v1.

The Go server validates:

- username
- password

against environment-provided secrets.

### Required Safeguards

1. Audit log every authenticated session.
2. Audit log shell session start and exit.
3. Audit log built-in command execution.
4. Attach a request/session ID to terminal sessions.
5. Idle timeout for inactive shell sessions.
6. One PTY per browser session in v1.

### Risk Model

This dashboard intentionally exposes shell capability. It must be treated as privileged production infrastructure.

Because of that:

- do not expose it broadly by default
- do not support arbitrary anonymous use
- do not mix operator shell logic with public user flows

---

## 8. Data Sources

### Built-in Commands

Built-in commands should read from existing production systems directly:

- MySQL for auth/users/subscriptions
- sandbox service or sandbox database where appropriate
- Kubernetes where appropriate

The first release should prioritize read-oriented commands over mutation-heavy ones.

### Output Modes

Every built-in command should define a typed result structure and support:

- `table` output
- `json` output

This is important for:

- future automation
- reliable operator workflows
- possible side-panel structured rendering later

---

## 9. Command Model

### Command Families

#### `users`

- `users list`
- `users get <id>`

#### `subscriptions`

- `subscriptions list`

#### `sandboxes`

- `sandboxes list`

#### `shell`

- `shell`

#### `help`

- `help`
- `help <command>`

### Command Semantics

Built-in commands are handled by Go, not by shell parsing.

That means:

- better validation
- stable JSON output
- clearer auth/audit hooks
- safer behavior than instructing operators to query raw databases for everything

The shell remains available for power workflows, but it is not the only interaction path.

---

## 10. Frontend Design

### Stack

- React
- Vite
- shadcn/ui
- xterm.js

### Design Direction

Use a terminal-first admin aesthetic:

- dense but readable
- dark surfaces
- monospace emphasis
- restrained color accents
- clear connection/session status

The terminal should be the primary object on screen, not a decorative widget.

### Primary Frontend Responsibilities

- open authenticated session shell
- maintain websocket lifecycle
- render streamed output
- send input and resize events
- provide small help affordances
- display structured command metadata where helpful

---

## 11. Project Structure

```text
nextgen-dashboard/
├── cmd/
│   └── admind/
│       └── main.go
├── internal/
│   ├── auth/
│   ├── audit/
│   ├── command/
│   ├── shell/
│   ├── websocket/
│   ├── httpapi/
│   └── static/
├── web/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.ts
├── deploy/
│   ├── Dockerfile
│   └── manifests.yaml
├── go.mod
└── README.md
```

---

## 12. Delivery Plan

### Phase 1

- scaffold project
- static frontend served by Go
- Basic Auth
- websocket terminal plumbing
- xterm.js frontend
- shell session boot

### Phase 2

- built-in commands
- `--json` support
- structured command registry
- audit logs

### Phase 3

- deployment manifests
- `/admin` mount integration
- production hardening

---

## 13. Open Questions Resolved

### Why not a traditional dashboard?

Because the requested operator model is command-first, not form-first.

### Why not a standalone shell-only app?

Because we still want typed commands, structured JSON, and room for gradual admin affordances.

### Why not per-session runner pods in v1?

Because that adds orchestration complexity without first-release value.

### Why not split frontend and backend into different projects?

Because the requested deployment model is a single Go-served application with a static frontend bundle.

---

## 14. Recommended Next Step

Start implementation with the project skeleton and the smallest end-to-end vertical slice:

1. `/admin` served by Go
2. Basic Auth works
3. xterm.js renders
4. websocket terminal connects
5. `help` and `users list --json` work

