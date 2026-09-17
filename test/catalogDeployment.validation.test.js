import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash, isValidCnpj, slugify, validateCreatePayload, validateUnitUpdatePayload } from '../src/modules/catalog-deployment/validation.js';

const payload = () => ({ group: { cnpj: '11.222.333/0001-81', nome: 'Rede Saúde', username: 'rede-saude' }, units: [{ codigo: 'CENTRO', nome: 'Farmácia Centro', cnpj: '11.222.333/0001-81', sourceUnitId: 1, credentialRef: 'postgresql://user:pass@db.example:5432/client', orderWebhookUrl: 'https://cliente.example/webhook/order-token' }] });

test('valida CNPJ com dígitos verificadores', () => { assert.equal(isValidCnpj('11.222.333/0001-81'), true); assert.equal(isValidCnpj('11.222.333/0001-82'), false); assert.equal(isValidCnpj('00.000.000/0000-00'), false); });
test('normaliza slug de grupo e unidade', () => assert.equal(slugify(' Rede Saúde -- CENTRO '), 'rede-saude-centro'));
test('aplica defaults e escolhe a primeira unidade', () => { const value = validateCreatePayload(payload()); assert.equal(value.units[0].initial, true); assert.equal(value.units[0].publicationMode, 'automatic'); assert.equal(value.units[0].pageSize, 500); assert.equal(value.units[0].validEanDropThresholdBps, 1000); });
test('aceita a arroba do setup e persiste somente o username', () => { const value = payload(); value.group.username = '@rede-saude'; assert.equal(validateCreatePayload(value).group.username, 'rede-saude'); });
test('rejeita provider ainda não suportado', () => { const value = payload(); value.units[0].provider = 'trier'; assert.throws(() => validateCreatePayload(value), (error) => error.code === 'UNSUPPORTED_PROVIDER'); });
test('rejeita sourceUnitId duplicado', () => { const value = payload(); value.units.push({ ...value.units[0], codigo: 'NORTE', cnpj: '45.723.174/0001-10' }); assert.throws(() => validateCreatePayload(value), (error) => error.code === 'DUPLICATE_SOURCE_UNIT_ID'); });
test('exige webhook de pedidos HTTPS por unidade', () => {
  const missing = payload(); delete missing.units[0].orderWebhookUrl;
  assert.throws(() => validateCreatePayload(missing), (error) => error.code === 'INVALID_INPUT');
  const insecure = payload(); insecure.units[0].orderWebhookUrl = 'http://cliente.example/webhook/token';
  assert.throws(() => validateCreatePayload(insecure), (error) => error.code === 'INVALID_ORDER_WEBHOOK_URL');
});
test('hash canônico ignora ordem das chaves', () => assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 })));
test('valida correção parcial da unidade sem exigir novamente os segredos preservados', () => {
  assert.deepEqual(validateUnitUpdatePayload({ pageSize: 250, validEanDropThresholdBps: 750 }), { pageSize: 250, validEanDropThresholdBps: 750 });
});
test('normaliza novos segredos no fluxo de correção', () => {
  const value = validateUnitUpdatePayload({ credentialRef: 'postgresql://user:pass@db.example:5432/client', orderWebhookUrl: 'https://cliente.example/pedidos' });
  assert.equal(value.credentialRef, 'postgresql://user:pass@db.example:5432/client');
  assert.equal(value.orderWebhookUrl, 'https://cliente.example/pedidos');
});
test('rejeita correção vazia, campos desconhecidos e URLs inseguras', () => {
  assert.throws(() => validateUnitUpdatePayload({}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateUnitUpdatePayload({ status: 'active' }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateUnitUpdatePayload({ orderWebhookUrl: 'http://cliente.example/pedidos' }), (error) => error.code === 'INVALID_ORDER_WEBHOOK_URL');
});
