import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDeliveryPharmacyProduct } from '../src/modules/banco-unico-import/runtime/services/delivery-pharmacy-products.client.js';

test('normaliza produto da Delivery Pharmacy para o contrato de importacao', () => {
  const product = mapDeliveryPharmacyProduct({
    id: 321,
    ean: '7896331702378',
    nome: 'Creme de Arnica 30g',
    laboratorio: 'Laboratorio Exemplo',
  }, 0);

  assert.deepEqual(product, {
    id_produto: '321',
    nome: 'Creme de Arnica 30g',
    nomeOriginal: 'Creme de Arnica 30g',
    codigoBarras: '7896331702378',
    nomeLaboratorio: 'Laboratorio Exemplo',
    nomePrincipioAtivo: null,
    produtoOrigem: {
      id: 321,
      ean: '7896331702378',
      nome: 'Creme de Arnica 30g',
      laboratorio: 'Laboratorio Exemplo',
    },
  });
});
