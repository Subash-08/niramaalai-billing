import 'server-only';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {AppError} from './db';

export type EncryptedStorageEnvelope = {
  algorithm: 'aes-256-gcm';
  version: 1;
  keyId: string;
  iv: string; // 12 bytes base64
  tag: string; // 16 bytes base64
  ciphertext: string; // base64
};

function getMasterKey(keyId = 'v1'): Buffer {
  const envVarName = `STORAGE_CREDENTIALS_KEY_${keyId.toUpperCase()}`;
  const envVal = process.env[envVarName];
  if (!envVal) {
    throw new AppError(500, `Storage encryption key ${envVarName} must be configured in server environment variables.`);
  }

  const buf = Buffer.from(envVal, 'base64');
  if (buf.length !== 32) {
    throw new AppError(500, `Storage encryption key ${envVarName} must be exactly 32 bytes base64-encoded.`);
  }
  return buf;
}

export function buildStorageAad(tenantId: string, connectionId: string, version: number): Buffer {
  if (!tenantId || !connectionId || !Number.isInteger(version)) {
    throw new AppError(500, 'Invalid storage AAD parameters.');
  }
  return Buffer.from(`aad:v1:tenant=${tenantId}:connection=${connectionId}:version=${version}`, 'utf8');
}

export function encryptStorageSecret(
  plaintext: string,
  context: {tenantId: string; connectionId: string; version: number},
  keyId = 'v1'
): EncryptedStorageEnvelope {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new AppError(400, 'Secret must be a non-empty string.');
  }

  const masterKey = getMasterKey(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const aad = buildStorageAad(context.tenantId, context.connectionId, context.version);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    version: 1,
    keyId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptStorageSecret(
  envelope: EncryptedStorageEnvelope,
  context: {tenantId: string; connectionId: string; version: number}
): string {
  if (!envelope || envelope.algorithm !== 'aes-256-gcm' || envelope.version !== 1) {
    throw new AppError(500, 'Invalid storage encryption envelope format.');
  }

  const masterKey = getMasterKey(envelope.keyId || 'v1');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new AppError(500, 'Corrupted storage encryption envelope parameters.');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    const aad = buildStorageAad(context.tenantId, context.connectionId, context.version);
    decipher.setAAD(aad);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new AppError(500, 'Storage credential decryption failed.');
  }
}
