import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash, isValidCnpj, slugify, validateCreatePayload } from '../src/modules/catalog-deployment/validation.js';

const payload = () => ({ group: { cnpj: '11.222.333/0001-81', nome: 'Rede Saúde', username: 'rede-saude' }, units: [{ codigo: 'CENTRO', nome: 'Farmácia Centro', cnpj: '11.222.333/0001-81', sourceUnitId: 1, credentialRef: 'postgresql://user:pass@db.example:5432/client' }] });

test('valida CNPJ com dígitos verificadores', () => { assert.equal(isValidCnpj('11.222.333/0001-81'), true); assert.equal(isValidCnpj('11.222.333/0001-82'), false); assert.equal(isValidCnpj('00.000.000/0000-00'), false); });
test('normaliza slug de grupo e unidade', () => assert.equal(slugify(' Rede Saúde -- CENTRO '), 'rede-saude-centro'));
test('aplica defaults e escolhe a primeira unidade', () => { const value = validateCreatePayload(payload()); assert.equal(value.units[0].initial, true); assert.equal(value.units[0].publicationMode, 'shadow'); assert.equal(value.units[0].pageSize, 500); assert.equal(value.units[0].validEanDropThresholdBps, 1000); });
test('rejeita provider ainda não suportado', () => { const value = payload(); value.units[0].provider = 'trier'; assert.throws(() => validateCreatePayload(value), (error) => error.code === 'UNSUPPORTED_PROVIDER'); });
test('rejeita sourceUnitId duplicado', () => { const value = payload(); value.units.push({ ...value.units[0], codigo: 'NORTE', cnpj: '45.723.174/0001-10' }); assert.throws(() => validateCreatePayload(value), (error) => error.code === 'DUPLICATE_SOURCE_UNIT_ID'); });
test('hash canônico ignora ordem das chaves', () => assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 })));
