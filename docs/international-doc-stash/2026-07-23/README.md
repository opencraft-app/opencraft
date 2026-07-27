# International docs stash — 2026-07-23

This directory is the fixed recovery archive for LightVela international-site documentation that is intentionally hidden from publication.

## Scope

- `global/` and `en/` retain the original 2026-07-23 archive snapshot.
- `rehidden-2026-07-24/global/` and `rehidden-2026-07-24/en/` contain the current copies that were hidden again on 2026-07-24.
- The 2026-07-24 batch contains all full placeholder pages (`内容待补充。` / `Content coming soon.`), plus the five secondary Use Cases and the general FAQ by request. Only the first Use Case, Personal AI Assistant, remains published.
- Entire placeholder-only groups, Advanced and Troubleshooting, are hidden with their pages. Security retains the completed "Using LightVela Safely" page and Support retains Contact Us.
- Completed pages that merely mention future availability or recommend an image remain active.
- Domestic-site content was not changed.

## Restore convention

The archived copies remain here for recovery and comparison. The active copies now live under `frontend/src/content/docs/`.

Each file keeps its original path relative to `frontend/src/content/docs/` within its archive batch:

```text
rehidden-2026-07-24/global/<path>.md -> frontend/src/content/docs/global/<path>.md
rehidden-2026-07-24/en/<path>.md     -> frontend/src/content/docs/en/<path>.md
```

Before restoring a file, update `frontend/src/config/docs-sidebar.ts` if the page should be publicly listed again. Run the frontend documentation checks after restoring it.

To inspect the complete inventory:

```bash
find docs/international-doc-stash/2026-07-23 -type f -name '*.md' | sort
```
