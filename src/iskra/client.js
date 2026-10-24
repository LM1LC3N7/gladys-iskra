// -----------------------------------------------------------------------------
// The only network access: GET requests to the local REST API of an Iskra
// Smart Gateway, plain HTTP on the home network, no cloud (as the pyiskra
// library, adapters/RestAPI.py, see THIRD_PARTY_NOTICES.md). Read-only: only
// GET, the gateway is never commanded.
//
// The login, when set, goes as pyiskra sends it: a cookie
// `Authorization=Basic <base64 of user:password>`, to this address only. It is
// never logged, never in an error, never in a URL.
//
// Bounded: one request at a time, 10 s for the whole answer (the body
// included), 64 KiB at most, read into one buffer allocated once, never a
// redirect followed. Node's own fetch: no User-Agent of ours, no imitation.
//
// Errors carry our own codes, never a text of the gateway nor a URL.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY_BYTES, PATHS } from '../constants.js';
import { parseCounters, parseDevices, parseGateway, parseMeasurements } from './model.js';

export class GatewayError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'redirect'|'not_found'|'server'|'rate_limited'|
   *   'refused'|'too_large'|'not_json'|'unknown_answer'} code
   */
  constructor(code, { status, retryAfter } = {}) {
    super(code);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    /** ms, from a Retry-After header (429, 503), when given. */
    this.retryAfter = retryAfter;
  }
}

/** A network failure (while connecting or while reading the body), in our words. */
function networkError(err) {
  if (err instanceof GatewayError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new GatewayError(timeout ? 'timeout' : 'unreachable');
}

/**
 * The body, up to `limit` bytes, copied into a single buffer allocated once
 * (no list of chunks, no concatenation): a longer one is not a gateway answer.
 */
export async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > limit) {
        throw new GatewayError('too_large');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(0, size));
}

/** The body of an answer we do not read: let go. */
const drop = async (response) => {
  try {
    await response.body?.cancel?.();
  } catch {
    // Nothing to do: the answer is refused anyway.
  }
};

/** Retry-After in seconds (or an HTTP date) -> ms, undefined when absent or odd. */
function retryAfterOf(response, now) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(raw.trim())) {
    return Number(raw.trim()) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

/** The cookie pyiskra sends (RestAPI.get_resource), from `{ username, password }`. */
export function authCookie(login) {
  if (!login) {
    return undefined;
  }
  const token = Buffer.from(`${login.username}:${login.password}`, 'utf8').toString('base64');
  return `Authorization=Basic ${token}`;
}

export class GatewayClient {
  /** The login cookie: a private field, never enumerable, never logged. */
  #cookie;

  constructor({
    address,
    login = null,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeout = HTTP_TIMEOUT,
    now = Date.now,
  }) {
    this.address = address;
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.now = now;
    this.#cookie = authCookie(login);
    /** Requests one after the other, never two at once (a small gateway). */
    this.queue = Promise.resolve();
  }

  /** GET of a page: its JSON, bounded. */
  get(path) {
    const run = async () => {
      let text;
      try {
        const headers = { Accept: 'application/json' };
        if (this.#cookie) {
          headers.Cookie = this.#cookie;
        }
        const response = await this.fetch(`http://${this.address}${path}`, {
          method: 'GET',
          headers,
          // A redirect is never followed: the login stays on this address.
          redirect: 'manual',
          // The whole answer, the body included, within the timeout.
          signal: AbortSignal.timeout(this.timeout),
        });
        const status = response.status;
        if (status === 429 || status >= 500) {
          await drop(response);
          throw new GatewayError(status === 429 ? 'rate_limited' : 'server', {
            status,
            retryAfter: retryAfterOf(response, this.now),
          });
        }
        // pyiskra: 403 is "not authorised"; 401 is taken the same way.
        if (status === 401 || status === 403) {
          await drop(response);
          throw new GatewayError('refused', { status });
        }
        if (status === 404) {
          await drop(response);
          throw new GatewayError('not_found', { status });
        }
        if (status >= 300 && status < 400) {
          await drop(response);
          throw new GatewayError('redirect', { status });
        }
        if (status < 200 || status >= 300) {
          await drop(response);
          throw new GatewayError('http', { status });
        }
        text = await readBounded(response, MAX_BODY_BYTES);
      } catch (err) {
        throw networkError(err);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new GatewayError('not_json');
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  /** Reads a page and parses it; `unknown_answer` when it is not what the page should be. */
  async read(path, parse) {
    const value = parse(await this.get(path));
    if (value === undefined) {
      throw new GatewayError('unknown_answer');
    }
    return value;
  }

  /** The gateway itself: `{ model, serial, firmware }`. */
  gateway() {
    return this.read(PATHS.GATEWAY, parseGateway);
  }

  /** Its ports and meters (src/iskra/model.js parseDevices). */
  devices() {
    return this.read(PATHS.DEVICES, parseDevices);
  }

  measurements(position) {
    return this.read(PATHS.measurement(position), parseMeasurements);
  }

  counters(position) {
    return this.read(PATHS.counter(position), parseCounters);
  }
}
