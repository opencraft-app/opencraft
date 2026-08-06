import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const sourceRoot = join(process.cwd(), "src");

/**
 * A module sits in a layer, and may only reach layers beneath it. Anything
 * loose at the root of src/ui — tokens, the theme, date and identity helpers —
 * is shared ground that every layer stands on.
 */
const layerRank: Record<string, number> = {
  primitives: 0,
  components: 1,
  layouts: 2,
  screens: 3,
};

function uiLayer(path: string): string | null {
  const relativePath = relative(join(sourceRoot, "ui"), path)
    .split(sep)
    .join("/");
  if (relativePath.startsWith("..")) return null;
  const head = relativePath.split("/")[0] ?? "";
  return head in layerRank ? head : null;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = normalize(join(dirname(fromFile), specifier));
  for (const suffix of [".tsx", ".ts", "/index.tsx", "/index.ts", ""]) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function relativeImports(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(/from\s+"(\.[^"]+)"/gu)]
    .map((match) => resolveImport(path, match[1] as string))
    .filter((resolved): resolved is string => resolved !== null);
}

/** Every module a screen pulls in behind it, however deep. */
function moduleClosure(entry: string): Set<string> {
  const reached = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (reached.has(current)) continue;
    reached.add(current);
    pending.push(...relativeImports(current));
  }
  return reached;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path));
}

function sourcePath(path: string): string {
  return relative(sourceRoot, path).split(sep).join("/");
}

describe("UI framework boundary", () => {
  it("keeps HeroUI, Tailwind and Uniwind out of the runtime dependency tree", () => {
    const manifest = readFileSync(join(process.cwd(), "package.json"), "utf8");

    expect(manifest).not.toMatch(
      /@heroui\/|heroui-native|tailwindcss|uniwind/,
    );
  });

  it("keeps react-native-unistyles inside src/ui", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((path) => !sourcePath(path).startsWith("ui/"))
      .filter((path) =>
        /(?:from\s+|require\()["']react-native-unistyles["']/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map(sourcePath);

    expect(offenders).toEqual([]);
  });

  it("keeps React Native rendering primitives inside src/ui", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((path) => !sourcePath(path).startsWith("ui/"))
      .filter((path) => !sourcePath(path).endsWith(".test.tsx"))
      .filter((path) =>
        /from\s+["']react-native(?:["']|\/)/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map(sourcePath);

    expect(offenders).toEqual([]);
  });

  it("exposes UI to application code only through the @/ui outlet", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((path) => !sourcePath(path).startsWith("ui/"))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return [
          /from\s+["']@\/ui\//,
          /from\s+["'](?:\.\.\/)+ui\//,
        ].some((pattern) => pattern.test(source));
      })
      .map(sourcePath);

    expect(offenders).toEqual([]);
  });

  it("lets a layer reach only the layers beneath it", () => {
    // The four assertions above guard the wall around src/ui and say nothing
    // about the rooms inside it. So the message viewport reached up into
    // features for its scroll reducer, closing a features -> @/ui -> features
    // ring, and nothing failed. A house wants load-bearing walls, not only a
    // perimeter.
    const climbs = sourceFiles(join(sourceRoot, "ui"))
      .filter((path) => !/\.test\.tsx?$/u.test(path))
      .flatMap((path) => {
        const from = uiLayer(path);
        if (from === null) return [];
        return relativeImports(path)
          .filter((target) => {
            const to = uiLayer(target);
            return (
              to !== null &&
              to !== from &&
              (layerRank[to] as number) > (layerRank[from] as number)
            );
          })
          .map((target) => `${sourcePath(path)} -> ${sourcePath(target)}`);
      });

    expect(climbs).toEqual([]);
  });

  it("stands a screen in the app frame without the neighbouring screen", () => {
    // Layer order alone would have blessed the arrangement this rule replaced:
    // screens sit above layouts, so every management screen was free to import
    // PlatformFrame out of layouts/workspace-shell.tsx — and did, for fifty
    // lines of chrome. Behind those fifty lines came the whole conversation
    // surface: the Lexical composer, the message list, the viewport, the thread
    // panel. Direction was right; weight was wrong. A screen may stand in the
    // shared frame. It may not carry another screen in with it.
    const screensRoot = join(sourceRoot, "ui", "screens");
    const chatSurface = join(sourceRoot, "ui", "layouts", "workspace-shell.tsx");
    const screens = sourceFiles(screensRoot).filter(
      (path) => !/\.test\.tsx?$/u.test(path),
    );
    // The style lab is the reference wall: it hangs every surface side by side
    // on purpose, so it is the one screen allowed to reach them all.
    const visualReferenceLab = join(screensRoot, "style-lab-screen.tsx");

    const carried = screens
      .filter((path) => path !== visualReferenceLab)
      .flatMap((path) => {
        const reached = moduleClosure(path);
        return [...screens, chatSurface]
          .filter((foreign) => foreign !== path && reached.has(foreign))
          .map((foreign) => `${sourcePath(path)} -> ${sourcePath(foreign)}`);
      });

    expect(carried).toEqual([]);
  });
});
