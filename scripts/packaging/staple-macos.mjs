import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

export function isTransientStapleFailure(error) {
  return [65, 68].includes(Number(error?.code))
    || /NSURLErrorDomain|network connection was lost|timed out/iu.test(String(error?.stderr || error?.message));
}

export async function stapleAndValidateMacos(artifact, {
  run = args => execute("xcrun", args, { timeout: 120000 }),
  sleep = delay,
  delays = [5000, 15000, 30000, 60000, 90000, 120000],
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await run(["stapler", "staple", artifact]);
      break;
    } catch (error) {
      if (attempt >= delays.length || !isTransientStapleFailure(error)) throw error;
      process.stdout.write(`[opencraft] ticket delivery unavailable; retrying stapling in ${delays[attempt] / 1000}s\n`);
      await sleep(delays[attempt]);
    }
  }
  await run(["stapler", "validate", artifact]);
}
