// Passkeys (WebAuthn) with no dependencies: a minimal CBOR decoder, COSE -> KeyObject conversion,
// and verification of registration (attestation "none") and authentication assertions.
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { fail, route } from './http.js';
import { PUBLIC_URL, instance, rateLimit, clientIp, createSession, selfUser, str } from './core.js';

// RP ID is the hostname (no port). WebAuthn needs a domain name: "localhost" works for development, IP addresses don't.
export const RP_ID = new URL(PUBLIC_URL).hostname;
const ORIGIN = new URL(PUBLIC_URL).origin;
const CHALLENGE_MS = 5 * 60_000;
const MAX_PASSKEYS = 20;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) fail(400, 'Malformed passkey data.');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---------------------------------------------------------------- CBOR (RFC 8949), just enough for WebAuthn

function cborDecode(buf) {
  let pos = 0;
  const need = (n) => { if (pos + n > buf.length) throw new Error('CBOR: truncated'); };
  const readLen = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('CBOR: indefinite lengths are not supported');
    need(size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    pos += size;
    return v;
  };
  const item = (depth = 0) => {
    if (depth > 16) throw new Error('CBOR: too deep');
    need(1);
    const b = buf[pos++];
    const major = b >> 5;
    const info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
      if (info === 26) { need(4); const v = buf.readFloatBE(pos); pos += 4; return v; }
      if (info === 27) { need(8); const v = buf.readDoubleBE(pos); pos += 8; return v; }
      throw new Error('CBOR: unsupported simple value');
    }
    const len = readLen(info);
    switch (major) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: { need(len); const v = buf.subarray(pos, pos + len); pos += len; return v; }
      case 3: { need(len); const v = buf.toString('utf8', pos, pos + len); pos += len; return v; }
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(item(depth + 1)); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 6: return item(depth + 1); // ignore tags
      default: throw new Error('CBOR: bad major type');
    }
  };
  const value = item();
  return { value, end: pos };
}

// ---------------------------------------------------------------- COSE keys

const ALGS = { [-7]: 'ES256', [-8]: 'EdDSA', [-257]: 'RS256' };

function coseToKey(cose) {
  if (!(cose instanceof Map)) throw new Error('Bad COSE key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  else throw new Error('Unsupported passkey algorithm');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return { alg, pem: key.export({ type: 'spki', format: 'pem' }) };
}

function verifySig(alg, pem, data, sig) {
  const key = crypto.createPublicKey(pem);
  if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
  if (alg === -257) return crypto.verify('sha256', data, key, sig);
  if (alg === -8) return crypto.verify(null, data, key, sig);
  return false;
}

// ---------------------------------------------------------------- authenticator data

function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authenticatorData too short');
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    signCount: buf.readUInt32BE(33),
  };
  out.up = !!(out.flags & 0x01);
  out.uv = !!(out.flags & 0x04);
  out.be = !!(out.flags & 0x08);
  out.bs = !!(out.flags & 0x10);
  out.at = !!(out.flags & 0x40);
  if (out.at) {
    let p = 37;
    out.aaguid = buf.subarray(p, p + 16); p += 16;
    const idLen = buf.readUInt16BE(p); p += 2;
    out.credentialId = buf.subarray(p, p + idLen); p += idLen;
    const { value, end } = cborDecode(buf.subarray(p));
    out.cose = value;
    p += end;
  }
  return out;
}

const uuid = (b) => { const h = Buffer.from(b).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

// A few well-known passkey providers, so the list can say "iCloud Keychain" instead of a UUID.
const PROVIDERS = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5',
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5 NFC',
};

// ---------------------------------------------------------------- challenges

const challenges = new Map(); // challenge (base64url) -> { kind, userId, exp }
function newChallenge(kind, userId = null) {
  const c = b64u(crypto.randomBytes(32));
  challenges.set(c, { kind, userId, exp: Date.now() + CHALLENGE_MS });
  return c;
}
function takeChallenge(c, kind, userId = null) {
  const ch = challenges.get(c);
  challenges.delete(c); // single use
  if (!ch || ch.kind !== kind || ch.exp < Date.now() || (userId !== null && ch.userId !== userId)) fail(400, 'This passkey request expired. Please try again.');
  return ch;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k); }, 60_000).unref();

function checkClientData(clientDataB64, type, kind, userId) {
  let cd;
  try { cd = JSON.parse(unb64u(clientDataB64).toString('utf8')); } catch { fail(400, 'Malformed passkey data.'); }
  if (cd.type !== type) fail(400, 'Unexpected passkey response.');
  if (cd.origin !== ORIGIN) fail(400, `Passkeys only work on ${ORIGIN}.`);
  if (cd.crossOrigin === true) fail(400, 'Cross-origin passkey requests are not allowed.');
  takeChallenge(cd.challenge, kind, userId);
  return cd;
}

function webauthnUserId(user) {
  if (user.webauthn_id) return user.webauthn_id;
  const id = b64u(crypto.randomBytes(16));
  run('UPDATE users SET webauthn_id = :w WHERE id = :id', { w: id, id: user.id });
  return id;
}

const passkeyOut = (p) => ({
  id: p.id, name: p.name, provider: PROVIDERS[p.aaguid] || null, synced: !!p.backed_up,
  createdAt: p.created_at, lastUsed: p.last_used, transports: JSON.parse(p.transports || '[]'),
});

// ---------------------------------------------------------------- registration (signed in)

route('GET', '/api/passkeys', ({ me }) => ({
  passkeys: all('SELECT * FROM passkeys WHERE user_id = :id ORDER BY created_at DESC', { id: me.id }).map(passkeyOut),
  rpId: RP_ID,
}));

route('POST', '/api/passkeys/register/options', ({ me }) => {
  rateLimit(`pk-reg:${me.id}`, 30, 10 * 60_000);
  const existing = all('SELECT id, transports FROM passkeys WHERE user_id = :id', { id: me.id });
  if (existing.length >= MAX_PASSKEYS) fail(400, `You can have up to ${MAX_PASSKEYS} passkeys.`);
  return {
    publicKey: {
      challenge: newChallenge('register', me.id),
      rp: { id: RP_ID, name: instance().name },
      user: { id: webauthnUserId(me), name: me.handle, displayName: me.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      timeout: CHALLENGE_MS,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.id, transports: JSON.parse(c.transports || '[]') })),
      extensions: { credProps: true },
    },
  };
});

route('POST', '/api/passkeys/register', ({ me, body }) => {
  const cred = body.credential || {};
  if (cred.type !== 'public-key') fail(400, 'Malformed passkey data.');
  checkClientData(cred.response?.clientDataJSON, 'webauthn.create', 'register', me.id);
  let att;
  try { att = cborDecode(unb64u(cred.response?.attestationObject)).value; } catch { fail(400, 'Malformed attestation.'); }
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) fail(400, 'Malformed attestation.');
  let auth;
  try { auth = parseAuthData(att.get('authData')); } catch { fail(400, 'Malformed authenticator data.'); }
  if (!auth.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) fail(400, 'This passkey was made for a different site.');
  if (!auth.up) fail(400, 'User presence is required.');
  if (!auth.at || !auth.credentialId) fail(400, 'No credential in the response.');
  const credId = b64u(auth.credentialId);
  if (credId !== cred.rawId && credId !== cred.id) fail(400, 'Credential ID mismatch.');
  if (get('SELECT 1 AS x FROM passkeys WHERE id = :id', { id: credId })) fail(409, 'That passkey is already registered.');
  let key;
  try { key = coseToKey(auth.cose); } catch (e) { fail(400, e.message); }
  const aaguid = uuid(auth.aaguid);
  const transports = Array.isArray(cred.response?.transports) ? cred.response.transports.filter((t) => typeof t === 'string').slice(0, 6) : [];
  const name = str(body.name, { name: 'Name', max: 60 }) || PROVIDERS[aaguid] || 'Passkey';
  const now = Date.now();
  run(`INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, name, aaguid, backed_up, created_at, last_used)
       VALUES (:id, :u, :pk, :alg, :sc, :tr, :name, :aaguid, :bu, :t, NULL)`,
  { id: credId, u: me.id, pk: key.pem, alg: key.alg, sc: auth.signCount, tr: JSON.stringify(transports), name, aaguid, bu: auth.bs ? 1 : 0, t: now });
  return { passkey: passkeyOut(get('SELECT * FROM passkeys WHERE id = :id', { id: credId })), algorithm: ALGS[key.alg] };
});

route('PATCH', '/api/passkeys/:id', ({ me, params, body }) => {
  const p = get('SELECT * FROM passkeys WHERE id = :id AND user_id = :u', { id: params.id, u: me.id }) || fail(404, 'Passkey not found.');
  run('UPDATE passkeys SET name = :n WHERE id = :id', { n: str(body.name, { name: 'Name', min: 1, max: 60 }), id: p.id });
  return { passkey: passkeyOut(get('SELECT * FROM passkeys WHERE id = :id', { id: p.id })) };
});

route('DELETE', '/api/passkeys/:id', ({ me, params }) => {
  const r = run('DELETE FROM passkeys WHERE id = :id AND user_id = :u', { id: params.id, u: me.id });
  if (!r.changes) fail(404, 'Passkey not found.');
  return { ok: true };
});

// ---------------------------------------------------------------- sign in (no session)

route('POST', '/api/auth/passkey/options', ({ req }) => {
  rateLimit(`pk-auth:${clientIp(req)}`, 60, 10 * 60_000);
  return { publicKey: { challenge: newChallenge('login'), rpId: RP_ID, timeout: CHALLENGE_MS, userVerification: 'preferred', allowCredentials: [] } };
}, { auth: false });

route('POST', '/api/auth/passkey', ({ req, res, body }) => {
  rateLimit(`auth:${clientIp(req)}`, 30, 10 * 60_000);
  const cred = body.credential || {};
  if (cred.type !== 'public-key' || typeof cred.id !== 'string') fail(400, 'Malformed passkey data.');
  const pk = get('SELECT * FROM passkeys WHERE id = :id', { id: cred.id });
  const clientData = unb64u(cred.response?.clientDataJSON);
  checkClientData(cred.response?.clientDataJSON, 'webauthn.get', 'login', null);
  if (!pk) fail(401, 'This passkey isn’t registered here. It may have been removed.');
  const authData = unb64u(cred.response?.authenticatorData);
  let auth;
  try { auth = parseAuthData(authData); } catch { fail(400, 'Malformed authenticator data.'); }
  if (!auth.rpIdHash.equals(sha256(Buffer.from(RP_ID)))) fail(400, 'This passkey was made for a different site.');
  if (!auth.up) fail(400, 'User presence is required.');
  const signed = Buffer.concat([authData, sha256(clientData)]);
  if (!verifySig(pk.alg, pk.public_key, signed, unb64u(cred.response?.signature))) fail(401, 'Passkey signature check failed.');
  const user = get('SELECT * FROM users WHERE id = :id AND domain IS NULL AND deleted_at IS NULL', { id: pk.user_id });
  if (!user) fail(401, 'This account no longer exists.');
  if (cred.response?.userHandle && user.webauthn_id && cred.response.userHandle !== user.webauthn_id) fail(401, 'Passkey does not belong to this account.');
  if (user.suspended) fail(403, 'This account has been suspended. Contact the instance admin if you think this is a mistake.');
  // Signature counters: if the authenticator uses them, they must increase (detects cloned keys).
  if (auth.signCount > 0 || pk.sign_count > 0) {
    if (auth.signCount <= pk.sign_count) fail(401, 'This passkey looks like a copy. Remove it and add it again.');
  }
  run('UPDATE passkeys SET sign_count = :sc, last_used = :t, backed_up = :bu WHERE id = :id',
    { sc: auth.signCount, t: Date.now(), bu: auth.bs ? 1 : 0, id: pk.id });
  createSession(req, res, user.id, { add: body.add === true });
  return { user: selfUser(user) };
}, { auth: false });

export const passkeyCount = (userId) => get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = :id', { id: userId }).n;
