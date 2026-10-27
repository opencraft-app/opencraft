/** React Native WebView may name a locally supplied HTML document about:blank
 * or data:text/html. Only the initial local document can use the latter route. */
export function allowEmbeddedDocumentNavigation(url: string, bridgeReady: boolean): boolean {
  return url === "about:blank"
    || (!bridgeReady && /^data:text\/html(?:;|,)/iu.test(url));
}
