import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const run = promisify(execFile), root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "build/native"); await mkdir(output, { recursive: true });
if (process.platform === "darwin") {
  const { stdout } = await run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const inputs = [];
  for (const arch of ["arm64", "x86_64"]) {
    const target = join(output, "speech-" + arch); inputs.push(target);
    await run("xcrun", ["swiftc", "-swift-version", "5", "-O", "-sdk", stdout.trim(), "-target", `${arch}-apple-macos12.0`,
      "-framework", "Speech", "-framework", "AVFoundation", "-framework", "CoreAudio", "-framework", "AudioToolbox",
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", join(root, "native/Info.plist"),
      join(root, "native/speech-helper.swift"), "-o", target]);
  }
  const binary = join(output, "opencraft-speech-helper");
  await run("xcrun", ["lipo", "-create", ...inputs, "-output", binary]);
  await run("codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", join(root, "native/entitlements.mac.plist"), binary]);
  console.log("Native Speech helper built (arm64/x86_64); no recording or authorization requested");
}
