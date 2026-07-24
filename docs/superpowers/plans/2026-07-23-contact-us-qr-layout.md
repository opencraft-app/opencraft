# Contact Us QR Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the international Chinese and English Contact Us pages to show WhatsApp, Discord, and WeCom QR codes as responsive labeled cards.

**Architecture:** Keep the existing MDX pages and public landing asset convention. Add the two provided QR images and replace the single-card layout with a three-column grid that collapses to one column on narrow screens.

**Tech Stack:** Markdown/MDX, Tailwind utility classes, static PNG assets, Fumadocs synchronization, TypeScript validation.

## Global Constraints

- Modify only the two international Contact Us MDX files and the two new QR image assets.
- Preserve `/assets/landing/about/community-qr.png` as the existing WeCom QR code.
- Use WhatsApp → Discord → WeCom order in both languages.
- Do not modify domestic-site documentation.

---

### Task 1: Add the QR assets

**Files:**
- Create: `frontend/public/assets/landing/about/whatsapp-qr.png`
- Create: `frontend/public/assets/landing/about/discord-qr.png`

- [ ] Copy the user-provided WhatsApp and Discord PNGs into those exact paths.
- [ ] Confirm both files are valid PNG images.

### Task 2: Update both Contact Us pages

**Files:**
- Modify: `frontend/src/content/docs/global/contact-us.md`
- Modify: `frontend/src/content/docs/en/contact-us.md`

- [ ] Replace the current single QR card with a responsive `md:grid-cols-3` layout.
- [ ] Add cards in order: WhatsApp, Discord, WeCom.
- [ ] Use Chinese labels `WhatsApp 交流群`, `Discord 社群`, `WeCom 交流群`.
- [ ] Use English labels `WhatsApp Community`, `Discord Community`, `WeCom Community`.
- [ ] Use the matching QR source in each card and accessible alt text.

### Task 3: Verify

**Files:**
- Verify: both international Contact Us MDX files and the two new assets.

- [ ] Run `pnpm check` from `frontend/`.
- [ ] Run `git diff --check` from the repository root.
- [ ] Confirm `frontend/src/content/docs/contact-us.md` has no diff.
