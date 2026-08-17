## Summary

**A Hermes Agent's files are not one messy folder. They belong in three places with distinct responsibilities. The working directory holds the current task's inputs, outputs, and tool execution, and it has a real boundary — tools cannot roam past the workspace into arbitrary system paths. Context files (`SOUL.md`, `USER.md`, `MEMORY.md`) are not ordinary attachments; they are long-term agreements that shape how the Agent understands the relationship and the work. Cloud storage is the Agent's file workspace for task material and output: single-file upload and download supports up to 1 GB, deleting removes only the hosted copy in that Agent's cloud storage and never touches the original on your computer, and one Agent's files are not automatically available to another Agent. The practical value of separating the three is that you always know where a document lives, who can read it, and how long it persists — which keeps secrets out of long-term context and keeps important material from existing only inside one chat log.**

---

## Where files live decides whether the Agent can pick up where it left off

Picture a common failure. You paste a project brief into the chat, ask the Agent to extract the key points, and it does a good job. Three days later you return: "based on that brief, draft a schedule." The schedule it produces clearly does not match — because the brief only ever existed inside a conversation from three days ago, not in any location that can be reliably retrieved.

Now picture a second failure. To help the Agent "remember" your server setup, you wrote a configuration block containing a secret key into a long-term context file. From then on, that block is read as background in every session. This is not the intended use of memory; it is an unnecessary long-term exposure of sensitive data.

Both point to the same issue: **where a file lives is not a tidiness preference. It determines whether material can be retrieved reliably, who reads it, and how long it persists.** This article lays out the three locations and the boundaries of each.

---

## 1. Three locations, three responsibilities

Start with the overall picture.

| Location | What it holds | Who reads it | Lifecycle |
|---|---|---|---|
| **Working directory** | Current task inputs, outputs, tool execution artefacts | Tools and execution during this task | Task-scoped, shorter-lived |
| **Context files** | `SOUL.md`, `USER.md`, `MEMORY.md` | Long-term agreements read every session | Long-term, actively maintained |
| **Cloud storage** | Task material, reference documents, output worth keeping | You or the Agent, on demand | Long-term; downloadable, renamable, deletable |

The pair most often confused is **context files and cloud storage**. Both persist, but they are read in completely different ways: context files are resident background for every session, while cloud storage files are material fetched when needed and never automatically injected into every conversation.

That distinction directly determines how sensitive information should be handled — covered below.

---

## 2. The working directory: where work happens, and where the boundary sits

The working directory serves the current task's inputs, outputs, and tool execution. It has two defining properties.

**First, it is the work site.** Reading files, writing files, running commands, and producing artefacts all happen here. An Agent that can genuinely continue work needs intermediate state to persist here rather than starting from scratch each time.

**Second, it has a clear boundary.** Tools cannot reach past the workspace into arbitrary system paths. That restriction is not a missing capability; it is the precondition that makes file read/write both usable and controllable. An Agent with unrestricted read/write across an entire filesystem turns any single misjudgement into a potentially irreversible outcome.

Understanding this boundary has a practical consequence: when you want the Agent to process a document, put the document somewhere it can access rather than expecting it to hunt through arbitrary directories on your machine.

---

## 3. Context files: not attachments, but long-term agreements

These three files are often mistaken for "material I uploaded to the Agent." Their role is entirely different — they determine how the Agent understands this relationship and this work.

| File | Primary role | Typical content |
|---|---|---|
| `SOUL.md` | Role, tone, behavioural limits | Conclusion before reasoning; no investment advice |
| `USER.md` | Stable user preferences and profile | Prefers English; keep terminology as-is |
| `MEMORY.md` | Cross-session facts, project state, decisions | Project name; last week's decision |

Three ways they differ from uploaded material:

**Difference one: read timing.** Context files are resident background used every session; cloud storage files are fetched only when needed.

**Difference two: content shape.** Context files suit stable rules, preferences, and fact entries — not large blocks of raw material. Pushing a ten-page brief into `MEMORY.md` only burdens every subsequent session.

**Difference three: sensitivity requirements.** Because they are resident, **do not write passwords, keys, or unnecessary sensitive information into long-term context files.** When the Agent must handle sensitive configuration, provide it through a controlled path and clean up afterwards rather than leaving it in the background indefinitely.

That third point is the single most important practical rule in this article.

For how the three context files jointly shape behaviour, see "Where Hermes Agent's Personality Comes From: Persona, Preferences, and Long-Term Memory."

---

## 4. Cloud storage: the Agent's file workspace

Cloud storage is positioned as the Agent's file workspace: keep task material in one place, upload and organise files, or download what you need locally — all from the console.

### 4.1 When to use it

Use cloud storage whenever the Agent needs reference material, working documents, or a clear place to keep output — rather than relying on a one-time paste into chat. Two typical patterns:

- **Upload first, then process** — upload a project brief, then ask the Agent to extract key points. The material stays available for later reference.
- **Create folders for recurring work** — give ongoing work a folder and maintain it, so output has a stable home.

### 4.2 Concrete limits worth knowing

These are facts to establish before you rely on it:

- **Single-file upload and download supports up to 1 GB.** Anything larger needs splitting or compressing first.
- **Deleting removes only the hosted copy in that Agent's cloud storage**, never the original file on your computer. Even so, download anything you may still need before deleting — the hosted copy is gone once removed.
- **One Agent's files are not automatically available to another Agent.** Moving material between Agents requires explicit action; do not assume a shared file area.
- **Keep the page open while uploading**, wait for completion, and confirm the file appears in the current folder before doing anything else.

### 4.3 Folder structure does not need to be elaborate

A practical recommendation: complex hierarchies are usually unnecessary. Three folders — material, in progress, done — handle most situations. Add depth only when it genuinely improves how quickly you find things.

One test for whether a structure is healthy: **do folder names make clear which task the material belongs to?** If you have to open a folder to remember what is inside, the name has failed — and the Agent relies on those same names to judge what material is for.

---

## 5. Where should this document go? A decision path

Faced with a specific document, work through these questions in order.

**Question one: is it a rule, a preference, or a fact entry?**
Yes → context files. Rules to `SOUL.md`, preferences to `USER.md`, facts to `MEMORY.md`. Store the distilled conclusion, not the raw source text.

**Question two: is it material or output worth keeping and likely to be referenced repeatedly?**
Yes → cloud storage. Upload it into a suitable folder with a name that explains its purpose.

**Question three: does it serve only this one task?**
Yes → handle it in the working directory; no long-term retention needed.

**Question four: does it contain passwords, keys, or sensitive personal information?**
Yes → **keep it out of long-term context files.** Provide it through a controlled path and clean up when the task ends.

The value of this path is turning "drop it anywhere" into a reasoned choice. Most day-to-day friction comes from conflating questions one and two — pushing bulk material into context files, or leaving material that deserves retention inside a chat log.

---

## 6. Common symptoms and where to look

| Symptom | More likely cause | Suggested action |
|---|---|---|
| Agent cannot find material you shared before | It exists only in chat history, never persisted | Upload to cloud storage, then reference it |
| Upload or download fails | File exceeds 1 GB, or you left the page mid-upload | Check size; re-upload and keep the page open |
| Files "disappeared" after moving to another Agent | Files belong to the original Agent's storage and are not shared | Download from the original, then upload to the new one |
| Worried deleting cloud files also deletes local ones | Misunderstanding delete scope | Deleting affects only the hosted copy, not your local original |
| Every session feels heavy and slow | Bulk raw material was pushed into long-term context files | Move it out of context files into cloud storage |
| Concerned about long-term exposure of secrets | Keys or passwords were written into context files | Remove them immediately; provide via a controlled path instead |

The last two rows are two faces of the same mistake: **treating context files as a document warehouse.** The test is simple — if a piece of content does not need to be read in every session, it does not belong in a context file.

---

## 7. LightVela's approach: making locations visible and controllable

Hermes distinguishes the working directory from context files at the mechanism level, but hosting and retrieving material is still arranged by the operator. LightVela's direction is to make the file workspace a visible, controllable product capability:

- **A consolidated file workspace** — upload, create, organise, download, rename, and delete from the console without leaving the product.
- **Explicit boundaries** — the working directory is bounded, and tools do not reach past the workspace into arbitrary system paths.
- **Clear delete semantics** — deleting removes only the hosted copy in that Agent's storage, leaves local originals untouched, and prompts you to download first.
- **Isolation between Agents** — separate file areas per Agent, so material does not leak where it should not be shared.
- **Decoupled from other capabilities** — switching models does not rewrite files in cloud storage.

---

## Key points

- Three locations, three roles: **working directory** (bounded work site), **context files** (resident long-term agreements), **cloud storage** (material and output fetched on demand).
- Context files and cloud storage differ in read timing: the former is resident every session, the latter is on demand.
- Cloud storage facts: **1 GB** per-file upload/download limit; deleting removes only the hosted copy; **one Agent's files are not automatically available to another**.
- Folder structures stay simple — material / in progress / done is usually enough, with names that explain purpose.
- One rule to hold to: **never write passwords, keys, or unnecessary sensitive information into long-term context files.**
- When sessions feel heavy or slow, first check whether bulk material was pushed into context files.

