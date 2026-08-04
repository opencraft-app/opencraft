import {
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { relative, resolve } from "node:path";

import { findCredentialLeaks } from "../src/security/credential-scan";

const projectRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(projectRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    if (!/\.(?:js|jsx|ts|tsx|json)$/.test(path)) {
      return [];
    }
    if (/\.test\.(?:ts|tsx)$/.test(path)) {
      return [];
    }
    return [path];
  });
}

const files = Object.fromEntries(
  [
    ...sourceFiles(sourceRoot),
    resolve(projectRoot, "app.json"),
    resolve(projectRoot, "index.ts"),
    resolve(projectRoot, "package.json"),
  ].map((path) => [
    relative(projectRoot, path),
    readFileSync(path, "utf8"),
  ]),
);
const findings = findCredentialLeaks(files);

if (findings.length > 0) {
  console.error("凭证扫描失败：检测到疑似敏感材料。");
  for (const finding of findings) {
    console.error(`- ${finding.file} (${finding.kind})`);
  }
  process.exitCode = 1;
} else {
  console.log(`凭证扫描通过：已检查 ${Object.keys(files).length} 个文件。`);
}
