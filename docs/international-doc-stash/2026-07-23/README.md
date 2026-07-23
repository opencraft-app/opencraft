# International docs stash — 2026-07-23

This directory stores LightVela international-site documentation that was not ready for publication on 2026-07-23.

## Scope

- `global/`: 29 unfinished Chinese international-site documents.
- `en/`: 29 unfinished English international-site documents.
- A page was stashed when it was a full placeholder (`内容待补充。` / `Content coming soon.`), or when the whole page explicitly said it was under construction (`configuration/channel-slack.md`).
- Completed pages that only contain a product-availability note or an image recommendation were kept active.
- The five secondary use-case pages are stashed in both languages; only the first use case, Personal AI Assistant, remains active.
- The Troubleshooting section is stashed in both languages until those pages are ready.
- The international FAQ page is also stashed in both languages until it is ready.
- Domestic-site content was not changed.

## Restore convention

Each file keeps its original path relative to `frontend/src/content/docs/`:

```text
stash/global/<path>.md -> frontend/src/content/docs/global/<path>.md
stash/en/<path>.md     -> frontend/src/content/docs/en/<path>.md
```

Before restoring a file, update `frontend/src/config/docs-sidebar.ts` if the page should be publicly listed again. Run the frontend documentation checks after restoring it.

To inspect the complete inventory:

```bash
find docs/international-doc-stash/2026-07-23 -type f -name '*.md' | sort
```
