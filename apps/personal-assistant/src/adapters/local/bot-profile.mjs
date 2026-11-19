import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, parse, relative, sep } from "node:path";
import { botBinding, assertBotBinding } from "../../domain/bot-binding.mjs";
import { stable } from "../../domain/values.mjs";
import { initProfile, loadProfile } from "./profile.mjs";

/** Reject links before traversing. This guards trusted local storage, not hostile same-UID code. */
export function privateDirectory(path) {
  path = resolve(path);
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Bot directory cannot traverse a symlink or file");
  }
  return realpathSync(path);
}

/** Trusted host entry. Does not authenticate a human or invent an assignment. */
export function provisionBotProfile(serverDirectory, rawBinding, options = {}) {
  if (
    [
      "assistantId",
      "owner",
      "botBinding",
      "layout",
      "memoryRoot",
      "memoryDefaultScope",
    ].some((k) => Object.hasOwn(options, k))
  )
    throw Error("Bot identity and private memory layout are host-owned");
  const binding = botBinding(rawBinding);
  if (binding.owner.kind !== "human")
    throw Error("Only personal assistants can be provisioned");
  const root = privateDirectory(serverDirectory);
  const path = privateDirectory(join(root, "bots", binding.botId));
  if (existsSync(join(path, "profile.json"))) {
    const profile = loadProfile(path);
    assertBotBinding(profile.config.botBinding, binding);
    return profile;
  }
  return initProfile(path, stable([binding.owner.kind, binding.owner.id]), {
    ...options,
    assistantId: binding.botId,
    botBinding: binding,
    layout: "bot-v1",
    memoryDefaultScope: "agent",
  });
}
