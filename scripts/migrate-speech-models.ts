import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../apps/local-agent-host/src/model-config/repository";
import { migrateSpeechEnvironment } from "../apps/local-agent-host/src/model-config/migrate-speech";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--models" || !isAbsolute(args[1]!) || !isAbsolute(args[3]!)) {
    throw new Error("用法：migrate-speech-models --source 私有环境文件绝对路径 --models 模型目录绝对路径");
  }
  const handle = await open(args[1]!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let contents: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("导入源必须是当前用户拥有的私有文件");
    const buffer = Buffer.alloc(16_385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error("导入源超过大小限制");
    contents = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const source: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^(OPENCRAFT_SPEECH_API_KEY|OPENCRAFT_SPEECH_MODEL)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    if (Object.hasOwn(source, match[1]!)) throw new Error("导入源包含重复配置");
    let value = match[2]!.trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error("导入源格式无效"); } }
    else if (value.startsWith("'")) { if (!value.endsWith("'") || value.slice(1, -1).includes("'")) throw new Error("导入源格式无效"); value = value.slice(1, -1); }
    if (typeof value !== "string") throw new Error("导入源格式无效");
    source[match[1]!] = value;
  }
  const result = await migrateSpeechEnvironment(new ModelConfigurationRepository(args[3]!), new ModelCredentialRepository(args[3]!), source);
  console.log(result.migrated ? "语音配置已导入模型服务；旧文件保留，请核对后移除旧密钥部署配置。" : "已有语音选择，未重复导入或覆盖。");
}
void main().catch(() => { console.error("语音导入失败，未确认的配置请在模型服务中核对。密钥不会输出。"); process.exitCode = 1; });
