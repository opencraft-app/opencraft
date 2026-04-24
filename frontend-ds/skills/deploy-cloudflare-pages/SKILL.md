---
name: deploy-cloudflare-pages
description: Deploy or update the Lightclaw frontend on Cloudflare Pages. Use when publishing this repo's static site, refreshing an existing Cloudflare Pages deployment, switching between mock auth and a real auth API, or verifying that BrowserRouter deep links still work after deployment.
---

# Deploy Cloudflare Pages

Deploy from the `mono` directory. This repo already contains the Cloudflare-specific pieces:

- `public/_redirects` for SPA fallback
- `scripts/deploy-cloudflare-pages.mjs` for `wrangler pages deploy`
- `DEPLOY_CLOUDFLARE.md` for a short operator-facing summary

## Decide auth mode first

Pick one mode before building. The build output bakes this choice in.

### 1. Static prototype mode

Use this when no public auth backend exists yet.

```bash
VITE_AUTH_API_BASE_URL=mock pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

Result:

- Cloudflare Pages serves a fully static prototype
- auth uses the built-in fake repository
- login, plan selection, and dashboard flow still work

### 2. Real auth backend mode

Use this when a public Go auth service is already reachable.

```bash
VITE_AUTH_API_BASE_URL=https://auth.example.com pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

Result:

- frontend calls the real auth backend
- login state depends on the remote service instead of local fake auth

Do not deploy a Cloudflare build that points at `http://localhost:8081`. That only works on the developer machine.

## First-time setup

Run once per Cloudflare account:

```bash
npx wrangler login
npx wrangler whoami
```

If the Pages project does not exist yet:

```bash
npx wrangler pages project create lightclaw --production-branch main
```

## Update an existing deployment

For the standard production update:

```bash
VITE_AUTH_API_BASE_URL=mock pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

For a preview or branch deployment:

```bash
VITE_AUTH_API_BASE_URL=mock pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw \
CLOUDFLARE_PAGES_BRANCH=preview \
pnpm deploy:cf
```

## Verify after deploy

Check the Pages project list:

```bash
npx wrangler pages project list
```

Check the deployment URL or production domain:

```bash
curl --http1.1 -k -I https://lightclaw.pages.dev
```

If deep links need a quick sanity check, open one directly:

- `/auth/sign-in`
- `/plans/select`
- `/dashboard`

The SPA fallback comes from `public/_redirects`. If deep-link refresh fails, inspect that file first.

## Repo-specific behavior

Auth selection is controlled in `src/repositories/http-repositories.ts`:

- explicit real URL: use HTTP auth + HTTP plan repository
- explicit `mock`: use fake repositories
- no env var on `localhost`: fall back to `http://localhost:8081`
- no env var on non-localhost: fall back to fake repositories

Fake auth persistence lives in `src/repositories/fake-repositories.ts`, so static prototype deployments keep login and plan state in local storage.

## Failure modes

### Build succeeds, login fails online

Cause:

- deployed build points at a missing or private auth URL

Fix:

- rebuild with `VITE_AUTH_API_BASE_URL=mock`, or
- deploy a public auth backend and rebuild with its URL

### Home page loads, deep-link refresh 404s

Cause:

- `dist/_redirects` missing from deployment

Fix:

- rebuild and confirm `dist/_redirects` exists before deploying

### Wrangler says not authenticated

Fix:

```bash
npx wrangler login
npx wrangler whoami
```
