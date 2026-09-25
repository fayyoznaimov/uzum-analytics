import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

@Injectable()
export class CryptoService {
  private key(): Buffer {
    const raw = process.env.APP_ENCRYPTION_KEY;
    if (!raw) throw new InternalServerErrorException('APP_ENCRYPTION_KEY is not configured');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new InternalServerErrorException('APP_ENCRYPTION_KEY must decode to 32 bytes');
    return key;
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { encryptedValue: encrypted.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
  }

  decrypt(record: { encryptedValue: string | null; iv: string | null; authTag: string | null }) {
    if (!record.encryptedValue || !record.iv || !record.authTag) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.encryptedValue, 'base64')), decipher.final()]).toString('utf8');
  }

  mask(value: string | null) {
    if (!value) return null;
    if (value.length <= 8) return '••••••••';
    return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
  }
}
