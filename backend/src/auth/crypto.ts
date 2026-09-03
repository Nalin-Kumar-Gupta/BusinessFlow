import { ApiError } from '../errors/api-error.js';

function fromBase64(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new ApiError({
      code: 'CONFIG_INVALID_SESSION_ENCRYPTION_KEY',
      status: 500,
      message: 'SESSION_ENCRYPTION_KEY must be valid base64',
    });
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function fromUtf8(input: ArrayBuffer): string {
  return new TextDecoder().decode(input);
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = fromBase64(base64Key);
  if (keyBytes.byteLength !== 32) {
    throw new ApiError({
      code: 'CONFIG_INVALID_SESSION_ENCRYPTION_KEY',
      status: 500,
      message: 'SESSION_ENCRYPTION_KEY must decode to 32 bytes',
    });
  }

  return crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plainText: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plainText) as BufferSource);
  const encryptedBytes = new Uint8Array(encrypted);
  const payload = new Uint8Array(iv.byteLength + encryptedBytes.byteLength);
  payload.set(iv, 0);
  payload.set(encryptedBytes, iv.byteLength);
  return toBase64(payload);
}

export async function decryptSecret(cipherText: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const payload = fromBase64(cipherText);
  if (payload.byteLength <= 12) {
    throw new ApiError({
      code: 'AUTH_INVALID_ENCRYPTED_SECRET',
      status: 401,
      message: 'Encrypted session payload is invalid',
    });
  }

  const iv = payload.slice(0, 12);
  const body = payload.slice(12);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body as BufferSource);
    return fromUtf8(decrypted);
  } catch {
    throw new ApiError({
      code: 'AUTH_INVALID_ENCRYPTED_SECRET',
      status: 401,
      message: 'Encrypted session payload is invalid',
    });
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(input) as BufferSource);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
