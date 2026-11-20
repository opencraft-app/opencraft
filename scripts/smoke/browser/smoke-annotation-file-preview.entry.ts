import { annotationFrameScript, withAnnotationFrameAgent } from "../../../apps/workbench-web/src/browser-annotation/frame/frame-source";
import { createFrameAnnotator } from "../../../apps/workbench-web/src/browser-annotation/frame/frame-annotator";
const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const page = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '"><title>Report</title><body style="margin:0;font:16px sans-serif">'
  + '<div style="height:600px;padding:20px"><h1>Report</h1><button id="go" style="margin-top:400px" onclick="window.clicked=(window.clicked||0)+1">Expand all</button>'
  + '<label>Token <input id="pw" name="api_token" value="s3cret"></label></div><script>window.pageReady=true; try{ window.leak = String(parent.document.title) }catch(e){ window.leak = "blocked" }<\/script>';
const token = crypto.randomUUID();
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts");
iframe.style.cssText = "width:500px;height:400px;border:1px solid #ccc";
iframe.srcdoc = withAnnotationFrameAgent(page, annotationFrameScript({ token, parentOrigin: location.origin }));
document.body.append(iframe);
const taps: any[] = [];
const annotator = createFrameAnnotator({ frame: () => iframe, token, document: { url: "/repo/report.html", title: "report.html", source: "/repo/report.html" } });
(window as any).t = { annotator, taps, iframe, start: () => annotator.intercept({ tap: (p) => taps.push(p), hover: () => {} }) };
// A forged message from elsewhere must be ignored.
