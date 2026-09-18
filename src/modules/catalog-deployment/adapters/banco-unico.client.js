import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function client(target) {
  if (!target?.baseUrl || !target?.authorization) {
    throw new DeploymentError('BANCO_UNICO_NOT_CONFIGURED', 'Banco Único não está configurado para o ambiente.', {
      statusCode: 503, stage: 'configuration',
    });
  }
  return createHttpClient(target.baseUrl, { Authorization: target.authorization });
}

function mappedProduct(product) {
  return {
    ean: String(product.ean || ''),
    descricaoProduto: product.nome || product.descricao,
    descricao: product.descricao || product.nome,
    fabricante: product.marca || undefined,
  };
}

export async function registerCoverage(target, clientKey, clientName, eans, metadata, unitId) {
  try {
    return (await withRetry(() => client(target).post(
      `/api/catalog-coverage/clients/${encodeURIComponent(clientKey)}/snapshots`,
      { clientName, eans, source: 'hub_catalog', metadata },
    ))).data;
  } catch (error) { throw mapUpstreamError(error, 'BANCO_UNICO', 'measuring_catalog_coverage', unitId); }
}

export async function getCoverage(target, clientKey, unitId) {
  try { return (await withRetry(() => client(target).get(`/api/catalog-coverage/clients/${encodeURIComponent(clientKey)}`))).data; }
  catch (error) { throw mapUpstreamError(error, 'BANCO_UNICO', 'measuring_catalog_coverage', unitId); }
}

export async function getMissingEans(target, clientKey, unitId, limit = 100) {
  try {
    return (await withRetry(() => client(target).get(
      `/api/catalog-coverage/clients/${encodeURIComponent(clientKey)}/missing`, { params: { offset: 0, limit } },
    ))).data;
  } catch (error) { throw mapUpstreamError(error, 'BANCO_UNICO', 'enriching_catalog', unitId); }
}

export async function publishMissingProducts(target, products, unitId) {
  if (!products.length) return { processed: 0 };
  try {
    return (await withRetry(() => client(target).post('/api/products', {
      products: products.map(mappedProduct), options: { returnItems: false },
    }))).data;
  } catch (error) { throw mapUpstreamError(error, 'BANCO_UNICO', 'enriching_catalog', unitId); }
}

export async function refreshCoverage(target, clientKey, unitId) {
  try { return (await withRetry(() => client(target).post(`/api/catalog-coverage/clients/${encodeURIComponent(clientKey)}/refresh`))).data; }
  catch (error) { throw mapUpstreamError(error, 'BANCO_UNICO', 'measuring_catalog_coverage', unitId); }
}
