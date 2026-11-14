/**
 * The developer's own licence keys.
 *
 * Every developer signs with a key pair of their own (Ed25519, generated on first use; the private half is sealed in
 * `dev_secrets` and never leaves the server, the public half is shown in the admin and published at `GET public-key`).
 * A plugin the developer sells embeds ONLY the public key, so it can check a key offline and nobody else can mint one.
 * Nothing here is shared with react-wp.com's licence keys: a different format and a different key.
 *
 *     RWPD1.<plugin>.<YYYYMMDD | NEVER>.<serial>.<signature>
 *
 * The signature covers `RWPD1|<plugin>|<expiry>|<serial>`. `<plugin>` is the plugin id (it may contain hyphens, never a
 * dot), so a key for one plugin does not unlock another. An expiry is the last valid UTC day.
 */
import { base32Encode, generateLicenseKeyPair, newLicenseSerial, signPayload, verifyPayload } from '../../../server/licenseCrypto.mjs';

export const KEY_PREFIX = 'RWPD1';
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const newKeyPair = generateLicenseKeyPair;
export const newSerial = newLicenseSerial;

const pad = (value) => String(value).padStart(2, '0');
/** The expiry stamp for a licence that lasts `days` from `now`, or `NEVER`. */
export const expiryStamp = (days, now = new Date()) => {
  if (!days) return 'NEVER';
  const end = new Date(now.getTime() + Number(days) * 86400000);
  return `${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}`;
};

/** The instant a stamp stops being valid (the end of that UTC day), or null for `NEVER`. */
export const expiryDate = (stamp) => {
  if (stamp === 'NEVER') return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(stamp);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999));
};

const payloadOf = (plugin, stamp, serial) => `${KEY_PREFIX}|${plugin}|${stamp}|${serial}`;

/** A signed key. `privateKey` is the developer's own, as stored; the plugin id and stamp are validated. */
export function signLicenseKey({ plugin, stamp, serial, privateKey }) {
  if (!PLUGIN.test(String(plugin || ''))) throw new Error('A licence key needs a plugin id of lower-case letters, digits and hyphens.');
  if (stamp !== 'NEVER' && !/^\d{8}$/.test(String(stamp))) throw new Error('A licence expiry is YYYYMMDD or NEVER.');
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(String(serial || ''))) throw new Error('A licence serial is 12 base32 characters.');
  const signature = signPayload(payloadOf(plugin, stamp, serial), privateKey);
  return `${KEY_PREFIX}.${plugin}.${stamp}.${serial}.${signature}`;
}

/** `{ plugin, stamp, serial, signature }` from the text of a key, or null when it is not shaped like one. */
export function parseLicenseKey(key) {
  const parts = String(key || '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== KEY_PREFIX) return null;
  const [, plugin, stamp, serial, signature] = parts;
  if (!PLUGIN.test(plugin) || !(stamp === 'NEVER' || /^\d{8}$/.test(stamp)) || !/^[0-9A-HJKMNP-TV-Z]{12}$/.test(serial) || !signature) return null;
  return { plugin, stamp, serial, signature };
}

/**
 * Whether a key is genuine for this developer: `'ok'`, `'expired'`, `'bad'` (not shaped like a key, or the signature is
 * not this developer's), `'wrong-plugin'` or `'no-key'`. Never throws. This is the same check a sold plugin runs
 * offline with the public key.
 */
export function verifyLicenseKey(key, { publicKey, plugin, now = new Date() } = {}) {
  const parts = parseLicenseKey(key);
  if (!parts) return { state: 'bad' };
  if (typeof publicKey !== 'string' || !publicKey.trim()) return { state: 'no-key', parts };
  if (verifyPayload(payloadOf(parts.plugin, parts.stamp, parts.serial), parts.signature, publicKey) !== 'ok') return { state: 'bad' };
  if (plugin && parts.plugin !== plugin) return { state: 'wrong-plugin', parts };
  const end = expiryDate(parts.stamp);
  if (end && end.getTime() < now.getTime()) return { state: 'expired', parts, expiresAt: end };
  return { state: 'ok', parts, expiresAt: end };
}

/**
 * The few lines a developer pastes into their own plugin to check a key without a network call. Shown in the admin.
 */
export const verifySnippet = (publicKey) => `import { verifyPayload } from '../../server/licenseCrypto.mjs';

const PUBLIC_KEY = '${publicKey}';

/** true when \`key\` is a genuine, unexpired RWPD1 key for this plugin. */
export function licenceIsValid(key, pluginId) {
  const [prefix, plugin, stamp, serial, signature] = String(key).trim().split('.');
  if (prefix !== 'RWPD1' || plugin !== pluginId) return false;
  if (verifyPayload(\`RWPD1|\${plugin}|\${stamp}|\${serial}\`, signature, PUBLIC_KEY) !== 'ok') return false;
  if (stamp === 'NEVER') return true;
  const end = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), 23, 59, 59);
  return end >= Date.now();
}`;

export { base32Encode };
