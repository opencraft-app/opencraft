import { execFileSync } from "node:child_process";
import { chmod, copyFile, rename } from "node:fs/promises";
if (process.env.FIXTURE_SFTP_PASSWORD === "1") {
  const password = execFileSync(process.env.SSH_ASKPASS, [], { encoding: "utf8" });
  if (password !== "synthetic-password\n") process.exit(3);
}
if (process.env.FIXTURE_SFTP_SILENT === "1") setInterval(() => undefined, 1000);
else {
  let input = "";
  for await (const data of process.stdin) input += data;
  try {
    if (process.env.FIXTURE_SFTP_FAIL === "1") throw new Error("private-failure-must-not-escape");
    for (const line of input.trim().split("\n")) {
      const args = [...line.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/gu)].map(match => match[1] === undefined ? match[2] : match[1].replace(/\\(.)/gu, "$1"));
      const [command, first, second] = args;
      if (command === "put" || command === "get") await copyFile(first, second);
      else if (command === "rename") await rename(first, second);
      else if (command === "chmod") await chmod(second, parseInt(first, 8));
      else throw new Error("Invalid fixture operation");
    }
  } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
