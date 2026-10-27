#!/usr/bin/env node

import { runWorkbenchWebCli } from "./serve-workbench-web.mjs";

runWorkbenchWebCli().catch((error) => {
  console.error("[opencraft static] failed to start", error);
  process.exitCode = 1;
});
