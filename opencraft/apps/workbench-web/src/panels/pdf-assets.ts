// Every PDF dependency is a build-owned asset, including CJK CMaps and image
// codecs. The same URLs work in Vite, static Web and the Electron Renderer.
const assets = {
  ...import.meta.glob<string>("../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", { eager: true, query: "?url", import: "default" }),
  ...import.meta.glob<string>("../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", { eager: true, query: "?url", import: "default" }),
  ...import.meta.glob<string>("../../../../node_modules/pdfjs-dist/wasm/*.{wasm,js}", { eager: true, query: "?url", import: "default" }),
};
const urls = new Map(Object.entries(assets).map(([path, url]) => [path.split("/").slice(-2).join("/"), url]));
const directories: Readonly<Record<string, string>> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };

export class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = urls.get(`${directories[kind]}/${filename}`);
    if (url === undefined) throw new Error("PDF asset unavailable");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF asset unavailable");
    return new Uint8Array(await response.arrayBuffer());
  }
}
