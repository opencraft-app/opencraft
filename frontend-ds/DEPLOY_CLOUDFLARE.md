# Cloudflare Pages Deployment

This frontend can be deployed as a static site on Cloudflare Pages.

## Preconditions

- Authenticate Wrangler:

  ```bash
  npx wrangler login
  npx wrangler whoami
  ```

- Choose one auth mode before building:
  - Real backend: deploy the Go auth service separately and prepare its public base URL.
  - Static prototype: set `VITE_AUTH_API_BASE_URL=mock` to use built-in demo auth.
- This Pages project uses `main` as the production branch. `pnpm deploy:cf` now defaults to `main`.
- Create `.env.production.local` or export the variable before building:

  ```bash
  export VITE_AUTH_API_BASE_URL="https://lightclaw.tech"
  ```

  Or:

  ```bash
  export VITE_AUTH_API_BASE_URL="mock"
  ```

## First Deployment

```bash
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

## Preview / Branch Deployment

```bash
pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw \
CLOUDFLARE_PAGES_BRANCH=preview \
pnpm deploy:cf
```

## Notes

- SPA fallback is handled by `public/_redirects`, so BrowserRouter deep links like `/dashboard` work on Pages.
- The build output directory is `dist`.
- If `VITE_AUTH_API_BASE_URL` is omitted on `localhost`, the frontend uses `http://localhost:8081`.
- If `VITE_AUTH_API_BASE_URL` is omitted on a non-localhost domain, the frontend falls back to built-in mock auth.
