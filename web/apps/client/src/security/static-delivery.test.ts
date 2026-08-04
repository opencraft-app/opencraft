import {readFileSync} from "node:fs";
import {resolve} from "node:path";

describe("static web delivery", () => {
  it.each(["static", "devcloud"])(
    "compresses JavaScript and other text assets in the %s image",
    target => {
      const config = readFileSync(
        resolve(__dirname, `../../../../deploy/${target}/nginx.conf`),
        "utf8",
      );

      expect(config).toContain("gzip on;");
      expect(config).toContain("gzip_vary on;");
      expect(config).toMatch(/gzip_types[\s\S]*application\/javascript/);
    },
  );

  it("loads the Web terminal runtime only when a terminal is opened", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../ui/components/terminal-panel.web.tsx",
      ),
      "utf8",
    );

    expect(source).not.toMatch(/^import .*@xterm/m);
    expect(source).toContain('import("@xterm/xterm")');
    expect(source).toContain('import("@xterm/addon-fit")');
    expect(source).toContain('import("@xterm/xterm/css/xterm.css")');
  });
});
