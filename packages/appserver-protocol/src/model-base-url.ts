/** A base URL is not an operation URL. Preserve arbitrary gateway/deployment prefixes. */
export function modelBaseUrlError(value: string, api?: string): string | null {
  if (!value.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return "请输入有效的 HTTP(S) 基础地址"; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "基础地址不能包含账号、密码、查询参数或片段";
  const pathname = url.pathname.replace(/\/+$/, '');
  const suffix = pathname.match(/\/(v1\/messages|chat\/completions|responses|messages|models)$/i)?.[1];
  if (suffix) return `这里需要基础地址，请移除末尾 /${suffix}；应用会自动拼接接口路径。`;
  if (api === 'anthropic-messages' && /\/v1$/i.test(pathname)) return "Anthropic 协议会自动拼接 /v1/messages，请移除末尾 /v1。";
  return null;
}
