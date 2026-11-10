import { expect, it, vi } from 'vitest';
import { runtimeJson, runtimeUrl } from '../src/runtime/transport.js';
it('accepts only HTTPS or HTTP loopback endpoints without embedded credentials/parameters', () => {
  for (const url of ['ftp://localhost', 'file:///tmp/runtime', 'http://example.com', 'https://a:b@example.com', 'https://example.com/?secret=x', 'https://example.com/#secret']) expect(() => runtimeUrl(url)).toThrow();
  for (const url of ['https://example.com', 'http://127.0.0.1:8095', 'http://[::1]:8095']) expect(runtimeUrl(url).protocol).toMatch(/^https?:$/);
});
it('bounds chunked responses and cancels the stream before parsing oversized input', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(20)); }, cancel });
  await expect(runtimeJson(new Response(stream), 32)).rejects.toThrow('RUNTIME_RESPONSE_LIMIT'); expect(cancel).toHaveBeenCalledOnce();
  await expect(runtimeJson(Response.json({ ok: true }), 100)).resolves.toEqual({ ok: true });
  await expect(runtimeJson(new Response('small', { headers: { 'content-length': '1000000' } }), 100)).rejects.toThrow('RUNTIME_RESPONSE_LIMIT');
});
