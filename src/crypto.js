import crypto from 'node:crypto';

// Szyfrowanie sekretów (tokeny) w bazie: AES-256-GCM.
// Klucz wynika z APP_SECRET (zmienna środowiskowa kontenera, nie baza).
export function makeVault(appSecret) {
  if (!appSecret || appSecret.length < 16) {
    throw new Error('APP_SECRET musi miec co najmniej 16 znakow');
  }
  const key = crypto.scryptSync(appSecret, 'wdrazacz-vault-v1', 32);

  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString('base64');
    },
    decrypt(blob) {
      const raw = Buffer.from(blob, 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
