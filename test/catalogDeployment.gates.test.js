import assert from 'node:assert/strict';
import test from 'node:test';
import { countSellableProducts } from '../src/modules/catalog-deployment/adapters/unicommerce.client.js';

test('gate comercial exige vinte produtos com preço positivo e estoque', () => {
  const nineteen = Array.from({ length: 19 }, () => ({ price: 1, stock: 1 }));
  assert.equal(countSellableProducts([...nineteen, { price: 0, stock: 1 }, { price: 1, stock: 0 }]), 19);
  assert.equal(countSellableProducts([...nineteen, { price: 1, stock: 1 }]), 20);
});
