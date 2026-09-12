import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const helperKinds = ["", " (GPU)", " (Plugin)", " (Renderer)"];

function signingArguments(appPath, entitlementsPath, deep) {
  return [
    "--force",
    ...(deep ? ["--deep"] : []),
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    entitlementsPath,
    appPath,
  ];
}
/** Ad-hoc signing is preview-only; release signing remains Electron Builder-owned. */
export async function signMacosPreview({ appPath, entitlementsPath, execFileImpl = execFileAsync }) {
  await execFileImpl("codesign", signingArguments(appPath, entitlementsPath, true));
  const productName = appPath.slice(appPath.lastIndexOf("/") + 1, -4);
  for (const kind of helperKinds) {
    const helper = join(appPath, "Contents", "Frameworks", `${productName} Helper${kind}.app`);
    await execFileImpl("codesign", signingArguments(helper, entitlementsPath, true));
  }
  await execFileImpl("codesign", signingArguments(appPath, entitlementsPath, false));
  await execFileImpl("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}
