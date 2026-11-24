// 本目录自带的 HTTP。不引用仓库其他目录。
export async function request(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const verb = method.toUpperCase();
  let res;
  try {
    res = await fetchImpl(url, {
      method: verb,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e?.name === 'AbortError' ? '请求超时' : '网络错误');
    err.cause = e;
    err.maybeSent = verb !== 'GET' && verb !== 'HEAD';
    throw err;
  }
  const text = await res.text();
  clearTimeout(timer);
  let data = null;
  let json = true;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; json = false; }
  }
  return {
    status: res.status,
    ok: res.ok,
    data,
    json,
    text,
    maybeSent: verb !== 'GET' && verb !== 'HEAD',
  };
}
