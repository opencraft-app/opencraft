/** A base URL is not an operation URL. Preserve arbitrary gateway/deployment prefixes. */
export function modelBaseUrlError(value: string): string | null {
  if (!value.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return "请输入有效的 HTTP(S) 基础地址"; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "基础地址不能包含账号、密码、查询参数或片段";
  const suffix = url.pathname.replace(/\/+$/, '').match(/\/(chat\/completions|responses|models)$/i)?.[1];
  return suffix ? `这里需要基础地址，请移除末尾 /${suffix}；应用会自动拼接接口路径。` : null;
}
