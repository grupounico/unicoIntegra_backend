import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { DeploymentError } from './errors.js';

function encryptionKey() {
  const raw = env.DEPLOYMENT_ENCRYPTION_KEY;
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new DeploymentError('ENCRYPTION_NOT_CONFIGURED', 'A chave de criptografia da implantação não está configurada.', {
      statusCode: 503, stage: 'security', action: 'Configure DEPLOYMENT_ENCRYPTION_KEY com 32 bytes.',
    });
  }
  return key;
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const [version, ivRaw, tagRaw, encryptedRaw] = String(value || '').split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new DeploymentError('SECRET_INVALID', 'O segredo armazenado não pôde ser recuperado.', { stage: 'security' });
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new DeploymentError('SECRET_INVALID', 'O segredo armazenado não pôde ser recuperado.', { stage: 'security' });
  }
}
