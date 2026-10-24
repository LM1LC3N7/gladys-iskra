// -----------------------------------------------------------------------------
// A fake network: `fetch` answers from a handler, records every call, and can
// hold an answer back (a slow inverter) until the test releases it.
// -----------------------------------------------------------------------------

/** The error Node's fetch gives for a host that refuses or does not exist. */
export const refusedError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

/** The error of AbortSignal.timeout. */
export const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError');

export function createFetch(handler) {
  const calls = [];
  const net = {
    calls,
    handler,
    /** When set, the next call waits for `release()`. */
    hold: false,
    held: [],
    release() {
      const held = net.held;
      net.held = [];
      for (const resolve of held) resolve();
    },
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      calls.push({ host: parsed.host, path: parsed.pathname, init });
      if (net.hold) {
        await new Promise((resolve) => net.held.push(resolve));
      }
      return net.handler({ host: parsed.host, path: parsed.pathname, init });
    },
  };
  return net;
}

/** A body that streams `count` chunks of `size` bytes (a hostile answer). */
export function streamOf(count, size) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(0x31));
    },
  });
}
