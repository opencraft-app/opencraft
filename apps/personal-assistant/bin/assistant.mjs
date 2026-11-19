#!/usr/bin/env node
import { LocalCredentialVault } from "../src/adapters/local/credential-vault.mjs";
import { LocalAttachmentStore } from "../src/adapters/filesystem/attachment-store.mjs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { LocalRunner as Runner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";

import { inspectLocalConfiguration } from "../src/runtime/local-diagnostics.mjs";

const help = `Headless personal assistant lab (local Unix socket; no UI)
  node bin/assistant.mjs serve  (JSON-RPC over stdio; initialize selects local or managed mode)
  node bin/assistant.mjs init --profile DIR --owner LABEL [--concurrency 1..8]
  node bin/assistant.mjs thread --profile-dir DIR profiles|list --owned|output REF
  node bin/assistant.mjs thread --profile-dir DIR start --profile ID --prompt TEXT --idempotency-key KEY
  node bin/assistant.mjs thread --profile-dir DIR tell REF --message TEXT --idempotency-key KEY
  node bin/assistant.mjs thread --profile-dir DIR tell REF --delivery steer --expected-turn TURN --message TEXT --idempotency-key KEY
  node bin/assistant.mjs run --profile DIR
  node bin/assistant.mjs submit --profile DIR --text TEXT [--id INPUT_ID]
  node bin/assistant.mjs doctor --profile DIR
  node bin/assistant.mjs usage --profile DIR [--work WORK_ID] [--after-id CURSOR] [--limit N]
  node bin/assistant.mjs status --profile DIR
  node bin/assistant.mjs goal-create --profile DIR --definition JSON
  node bin/assistant.mjs goal-list|goal-get --profile DIR [--goal ID]
  node bin/assistant.mjs goal-extend|goal-rebase|goal-update|goal-confirm --profile DIR --bundle FILE.json
  node bin/assistant.mjs goal-pause|goal-resume|goal-reopen|goal-cancel --profile DIR --goal ID --revision N
  node bin/assistant.mjs instruct|continue --profile DIR --work ID --revision N --text TEXT
  node bin/assistant.mjs overview --profile DIR
  node bin/assistant.mjs work --profile DIR --work WORK_ID
  node bin/assistant.mjs amend --profile DIR --work WORK_ID --text TEXT [--revision N] [--id INPUT_ID]
  node bin/assistant.mjs cancel --profile DIR --work WORK_ID [--id INPUT_ID]
  node bin/assistant.mjs memory-set --profile DIR --key KEY --value VALUE [--id INPUT_ID]
  node bin/assistant.mjs memory-list --profile DIR
  node bin/assistant.mjs memory-locations --profile DIR
  node bin/assistant.mjs memory-file --profile DIR --scope agent|user|project --path profile.md [--project SLUG] [--agent-id ID] [--offset N]
  node bin/assistant.mjs project-create --profile DIR --project SLUG --name NAME
  node bin/assistant.mjs project-join|project-leave --profile DIR --project SLUG
  node bin/assistant.mjs project-list --profile DIR
  node bin/assistant.mjs memory-forget --profile DIR --key KEY [--id INPUT_ID]
  node bin/assistant.mjs routine-add --profile DIR --text TEXT --interval-ms N --start-at EPOCH_MS [--expires-at EPOCH_MS] [--max-runs N] [--id INPUT_ID]
  node bin/assistant.mjs routine-resume --profile DIR --routine ROUTINE_ID
  node bin/assistant.mjs attention-status --profile DIR
  node bin/assistant.mjs attention-snooze --profile DIR --duration-ms N
  node bin/assistant.mjs routine-pause --profile DIR --routine ROUTINE_ID [--id INPUT_ID]
  node bin/assistant.mjs trigger-add --profile DIR --event-type TYPE --text GOAL [--path RELATIVE] [--notify never|always|changed]
  node bin/assistant.mjs trigger-list --profile DIR
  node bin/assistant.mjs trigger-enable --profile DIR --trigger ID --revision N --enabled true|false
  node bin/assistant.mjs event-emit --profile DIR --event-type TYPE --data JSON [--id EVENT_ID]
  node bin/assistant.mjs events --profile DIR [--after SEQ]
  node bin/assistant.mjs say --profile DIR --text TEXT [--work WORK_ID] [--revision N] [--conversation ID] [--id INPUT_ID]
  node bin/assistant.mjs attachment-import --profile DIR --file FILE
  node bin/assistant.mjs attachments --profile DIR
  node bin/assistant.mjs message-send --profile DIR --message JSON [--id ID]
  node bin/assistant.mjs messages --profile DIR [--after SEQ] [--limit N]
  node bin/assistant.mjs message-get --profile DIR --message-id ID
  node bin/assistant.mjs message-retry --profile DIR --message-id ID
  node bin/assistant.mjs message-respond --profile DIR --message-id ID --revision N --value VALUE [--reject]
  node bin/assistant.mjs context|context-retry --profile DIR
  node bin/assistant.mjs conversation-new --profile DIR [--id INPUT_ID]
  node bin/assistant.mjs conversations --profile DIR [--after-id CURSOR] [--limit N]
  node bin/assistant.mjs conversation --profile DIR [--conversation ID]
  Conversation-scoped reads/writes (context, messages, history-search, overview, goal-create) also accept --conversation ID.
  node bin/assistant.mjs turn --profile DIR --input INPUT_ID
  node bin/assistant.mjs skill-install --profile DIR --bundle FILE.json
  node bin/assistant.mjs skill-list --profile DIR
  node bin/assistant.mjs skill-enable --profile DIR --skill PLUGIN/NAME --enabled true|false
  node bin/assistant.mjs interaction-list --profile DIR
  node bin/assistant.mjs answer --profile DIR --interaction ID --revision N --text TEXT [--id INPUT_ID]
  node bin/assistant.mjs provide-secret --profile DIR --interaction ID --revision N --secret-file FILE
  node bin/assistant.mjs authorize --profile DIR --interaction ID --revision N --secret-file FILE
  node bin/assistant.mjs handoff --profile DIR --interaction ID --revision N --text REPORT
  node bin/assistant.mjs reject --profile DIR --interaction ID --revision N [--id INPUT_ID]
submit/amend may include --completion JSON with requirements and checks.
memory-set accepts --scope agent|user|project [--project SLUG] and --memory-kind profile|log.
memory-search/history-search accept --query TEXT and --limit N.
routine-add accepts --schedule JSON instead of interval/start; routine-update takes --routine ID --revision N --definition JSON.
New profiles default to 8 concurrent background works; --concurrency sets 1..8. Existing explicit values are retained.
init may include --memory-root ABSOLUTE_DIR (explicit same-owner sharing), --memory-default-scope agent|user, --time-zone IANA_ZONE, --workspace DIR, --max-steps N, --work-timeout-ms N and --model-timeout-ms N.
Default model is a deterministic fixture. Configure a real Pi provider explicitly in profile.json.
init --assistant-harness pi|codex --execution-harness pi|codex [--codex-config FILE.json] selects independent harness defaults. Existing executions keep their recorded harness.
Codex config requires explicit binary/baseUrl/modelId and a private credentialFile for a non-loopback endpoint.
`;

if (process.argv[2] === "serve") {
  await import("../src/runtime/assistant-server.mjs");
} else if (process.argv[2] === "thread") {
  try {
    const argv = process.argv.slice(3),
      i = argv.indexOf("--profile-dir");
    if (i < 0 || !argv[i + 1]) throw Error("Use assistant thread --profile-dir DIR <command> ...");
    const directory = argv[i + 1];
    argv.splice(i, 2);
    const profile = loadProfile(directory);
    const result = await request(profile, { op: "thread.command", params: { argv: ["thread", ...argv] } }, 35000);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(String(error.message) + "\n");
    process.exitCode = 1;
  }
} else
  try {
    const { values: v, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        file: { type: "string" },
        message: { type: "string" },
        "message-id": { type: "string" },
        reject: { type: "boolean" },
        concurrency: { type: "string" },
        "max-steps": { type: "string" },
        "work-timeout-ms": { type: "string" },
        "model-timeout-ms": { type: "string" },
        "assistant-harness": { type: "string" },
        "execution-harness": { type: "string" },
        "codex-config": { type: "string" },
        "after-id": { type: "string" },
        limit: { type: "string" },
        profile: { type: "string" },
        conversation: { type: "string" },
        schedule: { type: "string" },
        definition: { type: "string" },
        query: { type: "string" },
        scope: { type: "string" },
        project: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        "memory-root": { type: "string" },
        "memory-default-scope": { type: "string" },
        "agent-id": { type: "string" },
        offset: { type: "string" },
        "memory-kind": { type: "string" },
        "time-zone": { type: "string" },
        owner: { type: "string" },
        text: { type: "string" },
        id: { type: "string" },
        work: { type: "string" },
        goal: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        revision: { type: "string" },
        routine: { type: "string" },
        "interval-ms": { type: "string" },
        "start-at": { type: "string" },
        "expires-at": { type: "string" },
        "max-runs": { type: "string" },
        after: { type: "string" },
        help: { type: "boolean" },
        workspace: { type: "string" },
        input: { type: "string" },
        interaction: { type: "string" },
        completion: { type: "string" },
        "secret-file": { type: "string" },
        "duration-ms": { type: "string" },
        "event-type": { type: "string" },
        data: { type: "string" },
        path: { type: "string" },
        notify: { type: "string" },
        trigger: { type: "string" },
        bundle: { type: "string" },
        skill: { type: "string" },
        enabled: { type: "string" },
      },
    });
    const command = positionals[0];
    if (v.help || !command) {
      console.log(help);
      process.exit(0);
    }
    if (!v.profile) throw new Error("--profile is required");
    if (v.concurrency !== undefined && command !== "init")
      throw new Error("--concurrency is only available with init; stop the runner before updating profile.json");
    if (command === "init") {
      const p = initProfile(v.profile, v.owner, {
        ...(v.concurrency !== undefined ? { concurrency: Number(v.concurrency) } : {}),
        ...(v["assistant-harness"] || v["execution-harness"] || v["codex-config"]
          ? {
              harnesses: {
                assistant: v["assistant-harness"] ?? "codex",
                execution: v["execution-harness"] ?? "pi",
                ...(v["codex-config"] ? { codex: JSON.parse(readFileSync(v["codex-config"], "utf8")) } : {}),
              },
            }
          : {}),
        ...(v.workspace ? { workspace: v.workspace } : {}),
        ...(v["memory-root"] ? { memoryRoot: v["memory-root"] } : {}),
        ...(v["memory-default-scope"] ? { memoryDefaultScope: v["memory-default-scope"] } : {}),
        ...(v["time-zone"] ? { timeZone: v["time-zone"] } : {}),
        runPolicy: Object.fromEntries(
          [
            ["max-steps", "maxSteps"],
            ["work-timeout-ms", "workTimeoutMs"],
            ["model-timeout-ms", "modelTimeoutMs"],
          ]
            .filter(([flag]) => v[flag] !== undefined)
            .map(([flag, key]) => [key, Number(v[flag])]),
        ),
      });
      console.log(JSON.stringify({ profile: p.path, ...p.config }));
    } else {
      const profile = loadProfile(v.profile);
      if (command === "doctor") {
        console.log(JSON.stringify(await inspectLocalConfiguration(profile)));
      } else if (command === "run") {
        process.umask(0o077);
        const runner = await Runner.open(profile);
        console.log(
          JSON.stringify({
            event: "ready",
            profile: profile.path,
            mode: profile.config.mode,
            pid: process.pid,
          }),
        );
        let closing = false;
        const close = () => {
          if (closing) return;
          closing = true;
          runner.close().then(
            () => process.exit(0),
            (error) => {
              console.error(String(error));
              process.exit(1);
            },
          );
        };
        process.on("SIGINT", close);
        process.on("SIGTERM", close);
      } else {
        if (command === "attachment-import") {
          if (!v.file) throw new Error("--file is required");
          console.log(
            JSON.stringify({
              result: new LocalAttachmentStore(join(profile.path, "attachments")).importFile(v.file),
            }),
          );
          process.exit(0);
        }
        const op =
          {
            "conversation-new": "conversation.create",
            conversations: "conversation.list",
            overview: "work.overview",
            instruct: "work.instruct",
            continue: "work.continue",
            ...Object.fromEntries(
              [
                "create",
                "extend",
                "rebase",
                "reopen",
                "get",
                "list",
                "pause",
                "resume",
                "cancel",
                "update",
                "confirm",
              ].map((x) => ["goal-" + x, "goal." + x]),
            ),
            "message-send": "message.send",
            messages: "messages.list",
            "message-get": "message.get",
            "message-retry": "message.retry",
            "message-respond": "message.respond",
            attachments: "attachments.list",
            context: "conversation.context",
            "context-retry": "conversation.context.retry",
            "trigger-add": "trigger.add",
            "trigger-list": "trigger.list",
            "trigger-enable": "trigger.enable",
            "event-emit": "event.emit",
            "skill-install": "skill.install",
            "skill-list": "skill.list",
            "skill-enable": "skill.enable",
            "memory-locations": "memory.locations",
            "memory-file": "memory.file.read",
            "project-create": "memory.project.create",
            "project-join": "memory.project.join",
            "project-leave": "memory.project.leave",
            "project-list": "memory.project.list",
            "memory-search": "memory.search",
            "history-search": "history.search",
            "routine-update": "routine.update",
            "memory-set": "memory.set",
            "memory-list": "memory.list",
            "memory-forget": "memory.forget",
            "routine-add": "routine.add",
            "routine-resume": "routine.resume",
            "attention-status": "attention.status",
            "attention-snooze": "attention.snooze",
            "routine-pause": "routine.pause",
            "interaction-list": "interaction.list",
            "provide-secret": "interaction.resolve",
            authorize: "interaction.resolve",
            handoff: "interaction.resolve",
            answer: "interaction.answer",
            reject: "interaction.reject",
          }[command] ?? command;
        const p = v.bundle ? JSON.parse(readFileSync(v.bundle, "utf8")) : {};
        if (v.conversation) p.conversationId = v.conversation;
        if (v.goal) p.goalId = v.goal;
        if (v.message) p.message = JSON.parse(v.message);
        if (v["message-id"]) p.messageId = v["message-id"];
        if (v.reject !== undefined) p.reject = v.reject;
        if (v.schedule) p.schedule = JSON.parse(v.schedule);
        if (v.definition) p.definition = JSON.parse(v.definition);
        if (v.query !== undefined) p.query = v.query;
        if (v.scope !== undefined) p.scope = v.scope;
        if (v.project !== undefined) p.project = v.project;
        if (command.startsWith("project-") && v.project !== undefined) {
          delete p.project;
          p.slug = v.project;
        }
        if (v.name !== undefined) p.name = v.name;
        if (v.description !== undefined) p.description = v.description;
        if (v["agent-id"] !== undefined) p.agentId = v["agent-id"];
        if (v.offset !== undefined) p.offset = Number(v.offset);
        if (v["memory-kind"] !== undefined) p.kind = v["memory-kind"];
        if (v["after-id"]) p.after = v["after-id"];
        if (v.limit !== undefined) p.limit = Number(v.limit);
        if (v.skill) p.skillId = v.skill;
        if (v.enabled !== undefined) {
          if (!["true", "false"].includes(v.enabled)) throw new Error("--enabled must be true or false");
          p.enabled = v.enabled === "true";
        }
        for (const [flag, key] of [
          ["text", "text"],
          ["work", "workId"],
          ["key", "key"],
          ["value", "value"],
          ["routine", "routineId"],
          ["input", "inputId"],
          ["interaction", "interactionId"],
        ])
          if (v[flag] !== undefined) p[key] = v[flag];
        for (const [flag, key] of [
          ["revision", "expectedRevision"],
          ["interval-ms", "intervalMs"],
          ["start-at", "startAt"],
          ["expires-at", "expiresAt"],
          ["max-runs", "maxRuns"],
          ["after", "after"],
          ["duration-ms", "durationMs"],
        ])
          if (v[flag] !== undefined) p[key] = Number(v[flag]);
        if (v["event-type"]) p.eventType = v["event-type"];
        if (v.path !== undefined) p.path = v.path;
        if (v.notify !== undefined) p.notify = v.notify;
        if (v.trigger !== undefined) p.triggerId = v.trigger;
        if (v.data !== undefined) p.data = JSON.parse(v.data);
        if (op === "trigger.add") {
          p.goal = p.text;
          delete p.text;
        }
        const id = v.id ?? randomUUID();
        if (["provide-secret", "authorize"].includes(command)) {
          if (!v["secret-file"] || v.text !== undefined)
            throw new Error("Use --secret-file, never --text for sensitive input");
          const pending = (await request(profile, { op: "interaction.list", params: {} })).find(
            (i) => i.id === p.interactionId,
          );
          const kind = command === "authorize" ? "authorization" : "secret";
          if (!pending || pending.state !== "pending" || pending.kind !== kind)
            throw new Error("No matching pending intervention");
          if (pending.revision !== p.expectedRevision) throw new Error("Stale interaction revision");
          const credential = new LocalCredentialVault(profile).put(
            id,
            kind,
            JSON.parse(pending.metadata_json).provider,
            readFileSync(v["secret-file"], "utf8"),
          );
          p.credentialRef = credential.reference;
        }
        if (v.completion !== undefined) p.completion = JSON.parse(v.completion);
        const result = await request(profile, { op, id, params: p });
        console.log(JSON.stringify({ inputId: id, result }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message ?? String(error) }));
    process.exitCode = 1;
  }
