import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { MacosSpeechManager, parseMacosSpeechEvent } from "./macos-speech-manager";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

class MemoryLogger {
  lines: string[] = [];

  write(source: string, message: string) {
    this.lines.push(`${source} ${message}`);
  }
}

test("parses macOS speech helper events", () => {
  assert.deepEqual(parseMacosSpeechEvent({ type: "state", state: "listening" }), {
    type: "state",
    state: "listening",
  });
  assert.deepEqual(parseMacosSpeechEvent({ type: "final_transcript", text: "hello" }), {
    type: "final_transcript",
    text: "hello",
  });
  assert.deepEqual(parseMacosSpeechEvent({ type: "error", message: "no mic" }), {
    type: "error",
    code: "macos_speech_error",
    message: "no mic",
  });
  assert.equal(parseMacosSpeechEvent({ type: "state", state: "bogus" }), null);
});

test("manager relays helper stdout events and writes stop command", () => {
  const logger = new MemoryLogger();
  const child = new FakeChild();
  const events: unknown[] = [];
  const stdinChunks: string[] = [];
  child.stdin.on("data", (chunk) => stdinChunks.push(String(chunk)));
  const manager = new MacosSpeechManager({
      appPath: "/tmp/app",
      resourcesPath: "/tmp/resources",
      platform: "darwin",
      isPackaged: true,
      helperPath: "/bin/sh",
      logger,
      spawnImpl: (() => child) as never,
  });
  manager.onEvent((event) => events.push(event));

  assert.deepEqual(manager.start({ language: "zh-CN" }), { accepted: true });
  child.stdout.write('{"type":"state","state":"listening"}\n');
  child.stdout.write('{"type":"final_transcript","text":"你好"}\n');
  assert.deepEqual(manager.stop(), { accepted: true });
  child.emit("exit", 0, null);

  assert.deepEqual(events, [
    { type: "state", state: "listening" },
    { type: "final_transcript", text: "你好" },
    { type: "state", state: "idle" },
  ]);
  assert.deepEqual(stdinChunks, ["stop\n"]);
  assert.match(logger.lines.join("\n"), /state=listening/);
  assert.match(logger.lines.join("\n"), /final_transcript length=2/);
  assert.match(logger.lines.join("\n"), /helper exited code=0/);
});

test("manager disables native macOS speech in dev unless explicitly enabled", () => {
  const logger = new MemoryLogger();
  const manager = new MacosSpeechManager({
    appPath: "/tmp/app",
    resourcesPath: "/tmp/resources",
    platform: "darwin",
    isPackaged: false,
    helperPath: "/bin/sh",
    logger,
    env: {},
    spawnImpl: (() => new FakeChild()) as never,
  });

  assert.equal(manager.isAvailable(), false);
  assert.deepEqual(manager.start(), { accepted: false });
  assert.match(logger.lines.join("\n"), /disabled in dev/);
});

test("manager allows native macOS speech in dev with explicit override", () => {
  const logger = new MemoryLogger();
  const manager = new MacosSpeechManager({
    appPath: "/tmp/app",
    resourcesPath: "/tmp/resources",
    platform: "darwin",
    isPackaged: false,
    helperPath: "/bin/sh",
    logger,
    env: { VELA_DESKTOP_ENABLE_DEV_MACOS_SPEECH: "1" },
    spawnImpl: (() => new FakeChild()) as never,
  });

  assert.equal(manager.isAvailable(), true);
});
