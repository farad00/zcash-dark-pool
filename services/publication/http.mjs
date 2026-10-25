// Bounded HTTPS only. No ambient credentials, redirects, retries or response diagnostics.
export const unavailable = () => {
  throw new Error("PUBLICATION_UNAVAILABLE");
};
export async function publicRequest(
  fetcher,
  url,
  { method = "GET", body, token, signal } = {},
) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    unavailable();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4500);
  const headers = {
    Accept: "application/vnd.github+json",
    // Node fetch decodes compressed bodies but retains the wire Content-Length.
    // Pin identity encoding so strict byte accounting remains meaningful.
    "Accept-Encoding": "identity",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "darkpool-publication-v1",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== undefined) {
    if (method !== "PUT" || parsed.origin !== "https://api.github.com")
      unavailable();
    headers.Authorization = `Bearer ${token}`;
  }
  let reader;
  try {
    const response = await fetcher(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
    });
    if (response.redirected || (response.url && response.url !== url))
      unavailable();
    if (![200, 201, 404].includes(response.status)) unavailable();
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity")
      unavailable();
    if (response.status === 404) {
      await response.body?.cancel();
      return { status: 404 };
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) || Number(declared) > 262144)
    )
      unavailable();
    if (!response.body) unavailable();
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) unavailable();
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (declared !== null && Number(declared) !== bytes.length) unavailable();
    return { status: response.status, bytes };
  } catch {
    unavailable();
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
    abort.abort();
  }
}
export async function githubJson(fetcher, url, options) {
  const response = await publicRequest(fetcher, url, options);
  if (response.status === 404) return response;
  try {
    return {
      ...response,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
      ),
    };
  } catch {
    unavailable();
  }
}
