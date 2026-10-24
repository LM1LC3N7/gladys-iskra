// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// address of the Smart Gateway, its optional login, and the margin of the
// index guard. The address parser comes from gladys-energieleser /
// gladys-p1-monitor (approved).
// -----------------------------------------------------------------------------

import { INDEX_MAX_KW_DEFAULT, INDEX_MAX_KW_MAX, INDEX_MAX_KW_MIN } from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.30/index.html") is reduced
 * to its host and port.
 * @returns {{ address: string } | { error: 'invalid' }} `address` is '' when empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { address: '' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(`[${bracketed[1].toLowerCase()}]`, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return { address: `[${text.toLowerCase()}]` };
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2]);
}

function withPort(host, port) {
  if (port === undefined) {
    return { address: host };
  }
  const number = Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: number === 80 ? host : `${host}:${number}` };
}

/** A login part: printable, no control byte (it goes into a header), bounded. */
const LOGIN = /^[\x20-\x7e\u00a0-\uffff]{1,128}$/;

/**
 * The login of the gateway: both fields or none (pyiskra sends the cookie
 * only when both are set). The user name never holds ":" (Basic encoding).
 * @returns {{ username: string, password: string } | null | 'invalid'}
 */
function loginOf(raw) {
  const username = typeof raw?.username === 'string' ? raw.username.trim() : '';
  const password = typeof raw?.password === 'string' ? raw.password : '';
  if (username === '' && password === '') {
    return null;
  }
  if (
    username === '' ||
    password === '' ||
    username.includes(':') ||
    !LOGIN.test(username) ||
    !LOGIN.test(password)
  ) {
    return 'invalid';
  }
  return { username, password };
}

/** The margin of the guard in kW: a number within the bounds, else the default. */
function maxKwOf(raw) {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{1,4}(?:\.\d{1,3})?$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  return Number.isFinite(value) && value >= INDEX_MAX_KW_MIN && value <= INDEX_MAX_KW_MAX
    ? value
    : INDEX_MAX_KW_DEFAULT;
}

export function normalizeConfig(raw = {}) {
  // An address longer than any host name is refused before any parsing.
  const value = typeof raw?.address === 'string' && raw.address.length <= 300 ? raw.address : '';
  const parsed = parseAddress(value);
  const login = loginOf(raw);
  return {
    address: parsed.error ? '' : parsed.address,
    invalidAddress:
      Boolean(parsed.error) ||
      (typeof raw?.address === 'string' && value === '' && raw.address !== ''),
    login: login === 'invalid' ? null : login,
    invalidLogin: login === 'invalid',
    maxKw: maxKwOf(raw?.max_power_kw),
  };
}

/** Whether the form is complete enough to read the gateway. */
export const isComplete = (config) => Boolean(config.address) && !config.invalidLogin;
