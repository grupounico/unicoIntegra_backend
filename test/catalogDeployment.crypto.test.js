import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DEPLOYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { decryptSecret, encryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');

test('cifra com nonce e recupera segredo', () => { const first = encryptSecret('postgresql://secret'); const second = encryptSecret('postgresql://secret'); assert.notEqual(first, second); assert.equal(decryptSecret(first), 'postgresql://secret'); assert.equal(first.includes('postgresql'), false); });
test('rejeita ciphertext alterado', () => { const encrypted = encryptSecret('secret'); const parts = encrypted.split('.'); const last = parts[3].at(-1); parts[3] = `${parts[3].slice(0, -1)}${last === 'A' ? 'B' : 'A'}`; assert.throws(() => decryptSecret(parts.join('.')), (error) => error.code === 'SECRET_INVALID'); });
