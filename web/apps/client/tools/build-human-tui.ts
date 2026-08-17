import {createHash} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export interface BuildHumanTuiOptions {
  outputDirectory: string;
  repositoryRoot: string;
}

interface SourceInput {
  path: string;
  sha256: string;
}

const bundleName = "human-client.bundle.js";
const hashName = "human-client.bundle.sha256";
const manifestName = "human-client.bundle.manifest.json";

export async function buildHumanTui(
  options: BuildHumanTuiOptions,
): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const outputDirectory = resolve(options.outputDirectory);
  if (!isAbsolute(options.repositoryRoot) || !isAbsolute(options.outputDirectory)) {
    throw new Error("Human TUI build paths must be absolute");
  }
  const entry = resolve(
    repositoryRoot,
    "web/apps/client/src/tui/entry.tsx",
  );
  const result = await Bun.build({
    define: {"process.env.NODE_ENV": JSON.stringify("production")},
    entrypoints: [entry],
    format: "iife",
    metafile: true,
    minify: true,
    plugins: [
      {
        name: "vela-client-core-source",
        setup(build) {
          build.onResolve({filter: /^@vela\/client-core$/u}, () => ({
            path: resolve(
              repositoryRoot,
              "web/packages/client-core/src/index.ts",
            ),
          }));
        },
      },
    ],
    sourcemap: "none",
    target: "browser",
  });
  if (!result.success || result.outputs.length !== 1 || !result.metafile) {
    throw new Error(
      `Human TUI bundle failed: ${result.logs.map((log) => log.message).join("; ")}`,
    );
  }
  const bundle = new Uint8Array(await result.outputs[0]!.arrayBuffer());
  const bundleDigest = sha256(bundle);
  const sourcePaths = await manifestSourcePaths(
    repositoryRoot,
    Object.keys(result.metafile.inputs),
  );
  const sourceInputs: SourceInput[] = [];
  for (const path of sourcePaths) {
    sourceInputs.push({
      path,
      sha256: sha256(await readFile(resolve(repositoryRoot, path))),
    });
  }
  const manifest = {
    schema: "vela-human-tui-build/v1",
    protocol: "reactvaxis/v2",
    bundle: {
      bytes: bundle.byteLength,
      path: bundleName,
      sha256: bundleDigest,
    },
    sourceDigest: aggregateSourceDigest(sourceInputs),
    sourceInputs,
  };
  await mkdir(outputDirectory, {recursive: true});
  await writeAtomic(resolve(outputDirectory, bundleName), bundle);
  await writeAtomic(
    resolve(outputDirectory, hashName),
    new TextEncoder().encode(`${bundleDigest}\n`),
  );
  await writeAtomic(
    resolve(outputDirectory, manifestName),
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
}

export async function checkHumanTui(options: {
  artifactDirectory: string;
  repositoryRoot: string;
}): Promise<void> {
  const temporary = await mkdtemp(`${tmpdir()}/vela-human-tui-check-`);
  try {
    await buildHumanTui({
      outputDirectory: temporary,
      repositoryRoot: options.repositoryRoot,
    });
    for (const name of [bundleName, hashName, manifestName]) {
      const expected = await readFile(resolve(options.artifactDirectory, name));
      const actual = await readFile(resolve(temporary, name));
      if (!expected.equals(actual)) {
        throw new Error(`Human TUI artifact is stale: ${name}`);
      }
    }
  } finally {
    await rm(temporary, {force: true, recursive: true});
  }
}

async function manifestSourcePaths(
  repositoryRoot: string,
  metafileInputs: string[],
): Promise<string[]> {
  const allowedRoots = [
    "web/apps/client/src/",
    "web/packages/client-core/src/",
  ];
  const fixed = [
    "web/apps/client/package.json",
    "web/apps/client/tools/build-human-tui.ts",
    "web/apps/client/tsconfig.json",
    "web/package.json",
    "web/bun.lock",
    "web/packages/client-core/package.json",
    "web/packages/client-core/tsconfig.json",
  ];
  const resolved = new Set<string>(fixed);
  for (const raw of metafileInputs) {
    const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    const path = normalizedRelative(repositoryRoot, absolute);
    if (path.includes("/node_modules/") || path.startsWith("node_modules/")) {
      assertAllowedPackage(path);
      continue;
    }
    if (!allowedRoots.some((root) => path.startsWith(root))) {
      throw new Error(`Human TUI source escaped allowed roots: ${path}`);
    }
    resolved.add(path);
  }
  const paths = [...resolved].sort();
  await Promise.all(paths.map((path) => readFile(resolve(repositoryRoot, path))));
  return paths;
}

function assertAllowedPackage(path: string): void {
  for (const forbidden of [
    "@tencentcloud/chat",
    "expo-router",
    "react-native/",
    "react-native-web",
    "tim-upload-plugin",
  ]) {
    if (path.includes(`/node_modules/${forbidden}`)) {
      throw new Error(`Human TUI includes forbidden package: ${forbidden}`);
    }
  }
}

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) {
    throw new Error(`Human TUI input is outside repository: ${path}`);
  }
  return value;
}

function aggregateSourceDigest(inputs: SourceInput[]): string {
  const hash = createHash("sha256");
  hash.update("vela-human-tui-source/v1\0");
  for (const input of inputs) {
    hash.update(`${Buffer.byteLength(input.path)}:${input.path}`);
    hash.update(`${input.sha256.length}:${input.sha256}`);
  }
  return hash.digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAtomic(path: string, value: Uint8Array): Promise<void> {
  const temporary = resolve(
    dirname(path),
    `.${path.split(sep).at(-1)}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, value, {mode: 0o600});
  await rename(temporary, path);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let repositoryRoot = "";
  let outputDirectory = "";
  let checkDirectory = "";
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${name ?? "argument"}`);
    if (name === "--repository-root") repositoryRoot = value;
    else if (name === "--output-dir") outputDirectory = value;
    else if (name === "--check-dir") checkDirectory = value;
    else throw new Error(`Unknown Human TUI build argument: ${name}`);
  }
  if (!repositoryRoot || Boolean(outputDirectory) === Boolean(checkDirectory)) {
    throw new Error(
      "Usage: build-human-tui --repository-root ABS (--output-dir ABS | --check-dir ABS)",
    );
  }
  repositoryRoot = resolve(repositoryRoot);
  outputDirectory = outputDirectory ? resolve(outputDirectory) : "";
  checkDirectory = checkDirectory ? resolve(checkDirectory) : "";
  if (checkDirectory) {
    await checkHumanTui({artifactDirectory: checkDirectory, repositoryRoot});
  } else {
    await buildHumanTui({outputDirectory, repositoryRoot});
  }
}
