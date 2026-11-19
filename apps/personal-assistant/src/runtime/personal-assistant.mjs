import { stable } from "../domain/values.mjs";
import { provisionBotProfile } from "../adapters/local/bot-profile.mjs";
import { LocalRunner } from "./local-runner.mjs";
import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";

/** Explicit trusted Host activation, after platform claim and Bot credential issuance.
 * Desktop/local and server hosts share this entry; a screen never owns the runtime. */
export async function startPersonalAssistant({ serverDirectory, port, profileOptions = {}, overrides = {}, signal }) {
  const access = await withRequestDeadline((s) => port.authorize(undefined, s), signal, 5000);
  if (!access || !Number.isSafeInteger(access.expiresAt) || access.expiresAt <= Date.now())
    throw Error("Bot authority expired");
  signal?.throwIfAborted();
  const profile = provisionBotProfile(serverDirectory, access.binding, profileOptions);
  const managed = profileOptions.harnesses?.codex?.managed === true && typeof overrides.resolveModel === "function";
  if (
    !managed &&
    profileOptions.mode === "model" &&
    (profile.config.mode !== "model" || stable(profile.config.harnesses) !== stable(profileOptions.harnesses))
  )
    throw Error("Stored assistant model configuration differs from Host configuration");
  if (profileOptions.botPresentation) {
    const { name, duties } = profileOptions.botPresentation;
    if (typeof name !== "string" || name.length > 80 || typeof duties !== "string" || duties.length > 2000)
      throw Error("Invalid Bot presentation");
    // Current platform settings are an execution projection, not a second persistent profile authority.
    profile.config = { ...profile.config, botPresentation: { name, duties } };
  }
  return LocalRunner.open(profile, {
    ...overrides,
    ...(managed ? { managedHarnesses: profileOptions.harnesses } : {}),
    platformChannelPort: port,
  });
}
