// Passkey (WebAuthn) helpers: convert between the server's JSON (base64url strings)
// and the ArrayBuffers navigator.credentials expects.
import { api } from './api.js';

const toBuf = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials?.create;

export async function conditionalMediationAvailable() {
  try { return passkeysSupported() && !!(await PublicKeyCredential.isConditionalMediationAvailable?.()); } catch { return false; }
}

function friendlyError(e) {
  if (e?.name === 'NotAllowedError') return Object.assign(new Error('Passkey request was cancelled or timed out.'), { cancelled: true });
  if (e?.name === 'InvalidStateError') return new Error('This device already has a passkey for your account.');
  if (e?.name === 'SecurityError') return new Error('Passkeys need a secure (https) address with a domain name.');
  if (e?.name === 'AbortError') return Object.assign(new Error('Cancelled.'), { cancelled: true });
  return e instanceof Error ? e : new Error('Passkey failed.');
}

// Create a passkey for the signed-in account.
export async function registerPasskey(name) {
  const { publicKey: o } = await api('/passkeys/register/options', { method: 'POST' });
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: toBuf(o.challenge),
        user: { ...o.user, id: toBuf(o.user.id) },
        excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })),
      },
    });
  } catch (e) { throw friendlyError(e); }
  const r = cred.response;
  return api('/passkeys/register', {
    method: 'POST',
    body: {
      name,
      credential: {
        id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
        response: {
          clientDataJSON: toB64u(r.clientDataJSON),
          attestationObject: toB64u(r.attestationObject),
          transports: r.getTransports?.() || [],
        },
      },
    },
  });
}

// Sign in with a passkey. `conditional` shows passkeys in the handle field's autofill instead of a dialog.
export async function signInWithPasskey({ conditional = false, signal, add = false } = {}) {
  const { publicKey: o } = await api('/auth/passkey/options', { method: 'POST' });
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: [] },
      ...(conditional ? { mediation: 'conditional' } : {}),
      signal,
    });
  } catch (e) { throw friendlyError(e); }
  const r = cred.response;
  return api('/auth/passkey', {
    method: 'POST',
    body: {
      add,
      credential: {
        id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
        response: {
          clientDataJSON: toB64u(r.clientDataJSON),
          authenticatorData: toB64u(r.authenticatorData),
          signature: toB64u(r.signature),
          userHandle: r.userHandle ? toB64u(r.userHandle) : null,
        },
      },
    },
  });
}
