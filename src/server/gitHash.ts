import crypto from 'node:crypto';

export function computeSha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Computes the standard Git blob SHA-1: sha1("blob " + byteLength + "\0" + bytes).
 * Used to match extracted ZIP files directly against GitHub Git tree blob SHAs
 * and for accurate 3-way workspace change detection.
 */
export function computeGitBlobSha1(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}

export function encryptSecret(plaintext: string, keyMaterial: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(ciphertext: string, keyMaterial: Buffer): string | null {
  try {
    const parts = ciphertext.split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const payload = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function deriveAesKey(secretInput: string): Buffer {
  return crypto.createHash('sha256').update(secretInput, 'utf8').digest();
}
