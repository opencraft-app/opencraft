# nextgen-dashboard

`nextgen-dashboard` is a terminal-first admin surface for Lightclaw.

Design notes live in [DESIGN.md](DESIGN.md).

It is a single Go project with:

- `cmd/admind`: serves `/admin`, protects it with HTTP Basic Auth, exposes the JSON command registry, and brokers websocket shell sessions
- `cmd/ops-runner`: hosts a real PTY shell for terminal access with standard admin tooling baked in

## Shell shortcuts

- `help`
- `users list [--json]`
- `users get <id> [--json]`
- `subscriptions list [--json]`
- `sandboxes list [--json]`

The browser terminal now opens directly into bash. Inside that shell, the same structured reads are available through:

- `lcctl <command...>`
- `users ...`
- `subscriptions ...`
- `sandboxes ...`

`users`, `subscriptions`, and `sandboxes` are exposed as BusyBox-style symlinks to the same `lcctl` binary, not wrapper shell scripts.

## Local development

Run in two terminals:

```bash
cd ..
NEXTGEN_RUNNER_TOKEN=local-runner-token go run ./cmd/ops-runner
```

```bash
cd ..
NEXTGEN_DASHBOARD_BASIC_AUTH_USER=admin \
NEXTGEN_DASHBOARD_BASIC_AUTH_PASSWORD=admin \
NEXTGEN_DASHBOARD_RUNNER_TOKEN=local-runner-token \
go run ./cmd/admind
```

Open `http://127.0.0.1:18081/admin`.

## Runtime env

`admind`:

- `NEXTGEN_DASHBOARD_ADDR`
- `NEXTGEN_DASHBOARD_BASIC_AUTH_USER`
- `NEXTGEN_DASHBOARD_BASIC_AUTH_PASSWORD`
- `NEXTGEN_DASHBOARD_RUNNER_WS`
- `NEXTGEN_DASHBOARD_RUNNER_TOKEN`
- `NEXTGEN_DASHBOARD_PROXY_URL`
- `NEXTGEN_DASHBOARD_PROXY_TOKEN_SECRET`
- `NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN`
- `NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN`

`ops-runner`:

- `NEXTGEN_RUNNER_ADDR`
- `NEXTGEN_RUNNER_TOKEN`
- `NEXTGEN_RUNNER_SHELL`

`ops-runner` also accepts `NEXTGEN_DASHBOARD_RUNNER_TOKEN` as a compatibility fallback when both containers share the same secret payload.

The production runner image is based on Alpine and currently includes:

- `bash`
- `tmux`
- `screen`
- `vim`
- `lsof`
- `strace`
- `curl`
- `wget`
- `mysql`
- `redis-cli`

The default interactive shell is `/bin/bash`. Structured operations still go through the same Go command registry, but they are now consumed from inside shell via the proxy-backed `lcctl`, `users`, `subscriptions`, and `sandboxes` binaries instead of a separate command mode.
The shell process itself only receives a small safe environment (`PATH`, `HOME`, `TERM`, proxy variables, and similar basics). It does not inherit the admin pod's MySQL DSNs or other unrelated secrets.

The bundled `web/` frontend has been retired. `/admin` stays owned by `admind`, but the shipped runtime is now backend-only.

## Deployment notes

正式发布链路已经收敛到：

- [k8s/base](k8s/base)
- [k8s/overlays/beijing-sandbox](k8s/overlays/beijing-sandbox)
- [k8s/overlays/shprod](k8s/overlays/shprod)
- deploy-facing app / service paths in `argocd/`

标准命令：

```bash
python3 scripts/build-release-image.py --service nextgen-dashboard --env shprod --tag <tag>
```

`NEXTGEN_DASHBOARD_AUTH_DB_PASSWORD` 和 `NEXTGEN_DASHBOARD_SANDBOX_MYSQL_PASSWORD` 现在都可选；未显式提供时，发布脚本默认回落到 `platform.env` 中的 `MYSQL_PASSWORD/DB_PASSWORD`。

本地敏感输入来自：

- `.secret/nextgen-dashboard/test.env`

发布脚本会在 `nextgen-dashboard/k8s/overlays/<env>/generated/` 下生成本地 Kustomize 输入，不提交 Git。

The upstream application still runs in the `user-auth` namespace, but the public admin edge is now split out:

- `lightclaw.tech` is owned by `service-gateway` in namespace `lightclaw-gateway`
- `admin.lightclaw.tech` is owned by `admin-gateway` in namespace `lightclaw-gateway`
- `nextgen-dashboard` itself remains in `user-auth`

Current upstream chain:

- `admin.lightclaw.tech/admin` -> `admin-gateway.lightclaw-gateway.svc.cluster.local`
- `admin-gateway` -> `nextgen-dashboard.user-auth.svc.cluster.local`
