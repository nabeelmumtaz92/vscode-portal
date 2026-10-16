// End-to-end encryption shared by the phone (browser) and the VS Code extension (Node), via WebCrypto.
// The pairing key lives only in the QR code / link fragment and on the two devices; the relay never sees it.
// Each direction has its own AES-256-GCM key (HKDF from the pairing key) and a strict message counter,
// so the relay can't read, change, reorder, replay or reflect messages.
(function (root) {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const s = atob(str);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  const toB64u = (b) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const hex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const sha256hex = async (text) => hex(await subtle.digest('SHA-256', te.encode(text)));

  async function deriveRoom(keyStr) {
    const raw = fromB64u(keyStr);
    if (raw.length !== 32) throw new Error('Bad pairing key');
    const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) });
    const aes = (info) => subtle.deriveKey(params(info), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const bits = async (info) => hex(await subtle.deriveBits(params(info), base, 256));
    const clientProof = await bits('vsp client proof');
    return {
      c2h: await aes('vsp c2h'), h2c: await aes('vsp h2c'), label: await aes('vsp label'),
      hostProof: await bits('vsp host proof'), clientProof, clientProofHash: await sha256hex(clientProof),
    };
  }

  async function encrypt(key, bytes) {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return toB64(out);
  }
  async function decrypt(key, data) {
    const b = fromB64(data);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)));
  }

  class Channel {
    constructor(sendKey, recvKey) {
      this.sk = sendKey; this.rk = recvKey; this.sq = 0; this.rq = 0;
      this.sc = Promise.resolve(); this.rc = Promise.resolve();
    }
    seal(text) { // resolves in call order
      const p = this.sc.then(() => encrypt(this.sk, te.encode(JSON.stringify({ q: ++this.sq, m: text }))));
      this.sc = p.catch(() => {});
      return p;
    }
    open(data) {
      const p = this.rc.then(async () => {
        const { q, m } = JSON.parse(td.decode(await decrypt(this.rk, data)));
        if (q !== this.rq + 1) throw new Error('Message out of order');
        this.rq = q;
        return m;
      });
      this.rc = p.catch(() => {});
      return p;
    }
  }

  const sealLabel = (key, obj) => encrypt(key, te.encode(JSON.stringify(obj)));
  const openLabel = async (key, data) => JSON.parse(td.decode(await decrypt(key, data)));

  const api = {
    toB64u, fromB64u, randomBytes, sha256hex, deriveRoom, Channel, sealLabel, openLabel,
    newKey: () => toB64u(randomBytes(32)), newRoom: () => toB64u(randomBytes(18)),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.E2E = api;
})(this);
