import assert from 'node:assert/strict';
import test from 'node:test';
import { mapUpstreamError, publicError } from '../src/modules/catalog-deployment/errors.js';

test('mapeia indisponibilidade transitória sem expor resposta', () => { const source = new Error('senha=super-secret'); source.response = { status: 503, data: { token: 'secret' } }; const mapped = mapUpstreamError(source, 'HUB', 'creating_seller'); const exposed = publicError(mapped, { deploymentId: 'd1' }); assert.equal(exposed.code, 'HUB_UNAVAILABLE'); assert.equal(exposed.retryable, true); assert.equal(JSON.stringify(exposed).includes('secret'), false); });
test('mapeia conflito para reconciliação manual', () => { const source = new Error('conflict'); source.response = { status: 409 }; assert.equal(mapUpstreamError(source, 'HUB', 'creating_seller').code, 'RECONCILIATION_REQUIRED'); });
