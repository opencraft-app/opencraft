export function consoleFrameURL(setID: string, pathOrPort = "/dashboard", maybePort?: string) {
  const { path, port } = resolveConsoleTarget(pathOrPort, maybePort)
  const consolePath = withConsoleSetPath(path, setID)
  if (port === "18081") {
    return `http://localhost:18080${consolePath}`
  }
  return consolePath
}

function resolveConsoleTarget(pathOrPort: string, maybePort?: string) {
  if (maybePort !== undefined) {
    return { path: normalizePath(pathOrPort), port: maybePort }
  }
  if (/^\d+$/.test(pathOrPort)) {
    return { path: "/dashboard", port: pathOrPort }
  }
  return { path: normalizePath(pathOrPort), port: currentPort() }
}

function normalizePath(path: string) {
  if (!path) {
    return "/dashboard"
  }
  return path.startsWith("/") ? path : `/${path}`
}

function withConsoleSetPath(path: string, setID: string) {
  const url = new URL(path, "http://llmgateway.local")
  return `/_llmgateway_console/${encodeURIComponent(setID)}${url.pathname}${url.search}${url.hash}`
}

function currentPort() {
  if (typeof window === "undefined") {
    return ""
  }
  return window.location.port
}
