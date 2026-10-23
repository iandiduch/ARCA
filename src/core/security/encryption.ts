import crypto from 'node:crypto';
import { loadConfig } from '../../app/config.js';

export interface EncryptedPayload {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

export class EncryptionService {
  private static getKey(): Buffer {
    const config = loadConfig();
    return Buffer.from(config.ENCRYPTION_KEY, 'hex');
  }

  public static encrypt(plaintext: string): EncryptedPayload {
    const key = this.getKey();
    const iv = crypto.randomBytes(12); // 96 bits recomendado para AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag
    };
  }

  public static decrypt(payload: EncryptedPayload): string {
    const key = this.getKey();
    const iv = Buffer.from(payload.iv, 'hex');
    const authTag = Buffer.from(payload.authTag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(payload.ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }
}
