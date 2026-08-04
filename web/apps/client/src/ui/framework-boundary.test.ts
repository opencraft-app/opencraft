import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sourceRoot = join(process.cwd(), "src");

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
});
