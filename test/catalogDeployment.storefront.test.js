import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorefrontDomain } from '../src/modules/catalog-deployment/storefront.js';

test('gera alias vercel.app pela arroba informada no setup', () => {
  const domain = buildStorefrontDomain({
    username: '@ComplexoPharma',
    unit: { id: 'unit-1', code: 'MATRIZ', isInitial: true },
  });
  assert.equal(domain, 'whatsapp-complexopharma.vercel.app');
});

test('inclui o codigo para evitar colisao entre filiais', () => {
  const domain = buildStorefrontDomain({
    username: 'complexopharma',
    unit: { id: 'unit-2', code: 'Loja 02', isInitial: false },
  });
  assert.equal(domain, 'whatsapp-complexopharma-loja-02.vercel.app');
});

test('mantem o label no limite DNS com hash deterministico', () => {
  const input = {
    username: 'uma-rede-com-um-nome-extremamente-longo-para-validar-o-limite',
    unit: { id: 'unit-3', code: 'filial-com-codigo-muito-grande', isInitial: false },
  };
  const first = buildStorefrontDomain(input);
  assert.equal(first, buildStorefrontDomain(input));
  assert.ok(first.split('.')[0].length <= 63);
});

test('rejeita sufixo de dominio invalido', () => {
  assert.throws(
    () => buildStorefrontDomain({ username: 'rede', unit: { id: 'unit-1', code: 'M', isInitial: true }, suffix: 'dominio invalido' }),
    (error) => error.code === 'STOREFRONT_DOMAIN_INVALID',
  );
});
