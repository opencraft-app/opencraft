import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const mimeTypes = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
};

/** A local public directory selected by the build owner, never page input. */
export function productPublicAssets(workspaceRoot, configuredDirectory) {
  const directory = configuredDirectory?.trim();
  if (!directory) return null;
  if (!path.isAbsolute(directory) && /^[a-z][a-z\d+.-]*:/iu.test(directory)) {
    throw new Error("OPENCRAFT_PRODUCT_PUBLIC_DIR requires a local directory");
  }
  const selected = path.resolve(workspaceRoot, directory);
  if (!statSync(selected, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("OPENCRAFT_PRODUCT_PUBLIC_DIR does not name an existing directory");
  }
  const root = realpathSync(selected);
  let configuration;
  function inventory(directory = root, prefix = "") {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Product public assets cannot contain symbolic links: ${name}`);
      if (entry.isDirectory()) files.push(...inventory(file, name + "/"));
      else if (entry.isFile()) {
        if (configuration?.publicDir && existsSync(path.join(configuration.publicDir, name))) {
          throw new Error(`Product public asset conflicts with the core public directory: ${name}`);
        }
        files.push({ name, file });
      }
    }
    return files;
  }
  const attach = (server) => {
    server.middlewares.use((request, response, next) => {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      try {
        const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
        const base = configuration.base;
        if (!pathname.startsWith(base)) return next();
        const name = pathname.slice(base.length);
        // Read the directory at request time, like Vite's own public directory:
        // newly generated assets and changed bytes are available without restart.
        const entry = inventory().find(file => file.name === name);
        if (!entry) return next();
        const body = readFileSync(entry.file);
        response.setHeader("content-type", mimeTypes[path.extname(entry.name)] ?? "application/octet-stream");
        response.setHeader("content-length", body.byteLength);
        response.setHeader("cache-control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : body);
      } catch (error) {
        next(error);
      }
    });
  };
  return {
    name: "opencraft-product-public-assets",
    enforce: "post",
    configResolved(config) {
      configuration = config;
      inventory();
    },
    configureServer: attach,
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        // Packaged native documents deliberately disable public directory copies.
        if (configuration.build.copyPublicDir === false) return;
        for (const entry of inventory()) {
          if (Object.hasOwn(bundle, entry.name)) throw new Error(`Product public asset conflicts with a build output: ${entry.name}`);
          this.emitFile({ type: "asset", fileName: entry.name, source: readFileSync(entry.file) });
        }
      },
    },
  };
}
