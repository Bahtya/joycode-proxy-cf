// AES-256-GCM pt_key encryption — faithful port of pkg/store/store.go:469-493.
// Format: hex(nonce[12] || ciphertext), exactly matching the Go app so that
// ciphertext could in principle be migrated between the two.
//
// The 32-byte key is supplied as a 64-char hex string (Workers Secret PTKEY_ENC_KEY).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) throw new Error(`PTKEY_ENC_KEY must be 32 bytes (64 hex chars), got ${raw.length}`);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt → hex(nonce || ciphertext). */
export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12)); // GCM nonce size = 12
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, textEncoder.encode(plaintext));
  const ct = new Uint8Array(ctBuf);
  const merged = new Uint8Array(nonce.length + ct.length);
  merged.set(nonce, 0);
  merged.set(ct, nonce.length);
  return bytesToHex(merged);
}

/** Decrypt hex(nonce || ciphertext) → plaintext. */
export async function decrypt(ciphertext: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const data = hexToBytes(ciphertext);
  if (data.length < 12) throw new Error('ciphertext too short');
  const nonce = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return textDecoder.decode(pt);
}
