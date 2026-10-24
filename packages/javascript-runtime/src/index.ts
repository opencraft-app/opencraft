import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// No application references or host callbacks enter the guest realm. Worker
// termination also bounds WASM initialization, compilation and serialization.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
 const { newQuickJSWASMModuleFromVariant } = await import(workerData.moduleUrl);
 const variant = await import(workerData.variantUrl);
 const q = await newQuickJSWASMModuleFromVariant(variant.default), rt = q.newRuntime();
 rt.setMemoryLimit(16*1024*1024); rt.setMaxStackSize(256*1024);
 const deadline = Date.now() + 100;
 rt.setInterruptHandler(() => Date.now() > deadline);
 const vm = rt.newContext();
 try {
  const body = workerData.compile
   ? workerData.sources.map(s => '(function(args,context){"use strict";\\n'+s+'\\n});').join('\\n')
   : '(function(value){if(value && typeof value.then === \"function\")throw Error(\"Async handlers are unsupported\");return JSON.stringify(value);})((function(args,context){"use strict";\\n'+workerData.source+'\\n})('+JSON.stringify(workerData.args)+',Object.freeze('+JSON.stringify(workerData.context)+')))';
  const value = vm.evalCode(body);
  if (value.error) { value.error.dispose(); throw new Error('Invalid or interrupted JavaScript'); }
  const output = workerData.compile ? 'null' : vm.dump(value.value);
  value.value.dispose();
  if (typeof output !== 'string' || Buffer.byteLength(output)>131072) throw new Error('Output must be bounded JSON');
  parentPort.postMessage({ok:true,value:JSON.parse(output)});
 } finally { vm.dispose(); rt.dispose(); }
})().catch(() => parentPort.postMessage({ok:false}));`;
let running = 0;
/** Pure bounded JSON functions shared by trusted policy adapters. */
export function jsonFunctionSource(source: unknown, name: string): string {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16_384
    || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(name)) throw new Error('invalid_function');
  return `(function freeze(v) { if(v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } })(args);\n${source}\nif (typeof ${name} !== 'function') throw Error();\nreturn ${name}(args);`;
}
export async function javascript(
  input:
    | { compile: true; sources: string[] }
    | { source: string; args: unknown; context: unknown },
): Promise<unknown> {
  if (running >= 4)
    throw new Error(
      "JavaScript runtime busy; do not retry writes automatically",
    );
  running++;
  let worker: Worker | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const moduleUrl = pathToFileURL(
        createRequire(import.meta.url).resolve("quickjs-emscripten-core"),
      ).href;
      const variantUrl = pathToFileURL(
        createRequire(import.meta.url).resolve(
          "@jitl/quickjs-wasmfile-release-sync",
        ),
      ).href;
      worker = new Worker(workerSource, {
        eval: true,
        workerData: { ...input, moduleUrl, variantUrl },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      let settled = false;
      const finish = (error: boolean, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error
          ? reject(
              new Error(
                "JavaScript failed validation or exceeded runtime limits",
              ),
            )
          : resolve(value);
      };
      const timer = setTimeout(() => finish(true), 3000);
      worker.once("message", (result) =>
        finish(result.ok !== true, result.value),
      );
      worker.once("error", () => finish(true));
      worker.once("exit", () => finish(true));
    });
  } finally {
    await worker?.terminate();
    running--;
  }
}
