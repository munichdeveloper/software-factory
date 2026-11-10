export function runtimeUrl(value: string): URL {
  const url = new URL(value);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
    url.username || url.password || url.search || url.hash) throw new Error('INVALID_RUNTIME_ENDPOINT');
  return url;
}
/** Bound the stream before allocating/decoding/parsing the response. */
export async function runtimeJson(response: Response, maxBytes: number): Promise<unknown> {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^[0-9]+$/.test(advertised) || Number(advertised) > maxBytes)) {
    await response.body?.cancel(); throw new Error('RUNTIME_RESPONSE_LIMIT');
  }
  if (!response.body) throw new Error('MISSING_RUNTIME_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > maxBytes) throw new Error('RUNTIME_RESPONSE_LIMIT'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
