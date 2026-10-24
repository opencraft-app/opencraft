import { basename } from "node:path";
const mode = basename(process.env.DSH_HOME ?? "");
if (mode === "early-exit") process.exit(7);
if (mode === "timeout") process.on("SIGTERM", () => {});
else {
  console.log("dsh web: http://127.0.0.1:1");
  if (mode === "late-exit") setTimeout(() => process.exit(8), 75);
}
setInterval(() => {}, 1000);
