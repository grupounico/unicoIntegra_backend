import axios from 'axios';

import { env } from '../config/env.js';

function createError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function tenantDatabaseName(name) {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 45);

  if (!slug) {
    throw createError('Nome do cliente invalido para provisionar o banco Trier.', 400);
  }

  return `cliente_${slug}_cache`;
}

function requireMultiProviderConfiguration() {
  if (!env.MULTIPROVIDER_BASE_URL || !env.MULTIPROVIDER_ADMIN_API_KEY) {
    throw createError('A integracao multi-provider nao esta configurada no servidor.', 503);
  }
}

export function buildMultiProviderClientRequest(client) {
  requireMultiProviderConfiguration();

  if (client.provider === 'alpha7') {
    return {
      path: '/api/admin/clientes/alpha7',
      body: {
        name: client.name,
        host: client.instance,
        port: client.alpha7Port || 5432,
        database: client.alpha7Database,
        user: client.alpha7User,
        password: client.credential,
        ssl: false,
      },
    };
  }

  if (client.provider === 'api') {
    if (!client.credential) {
      throw createError('Informe o token Trier para criar a integracao.', 400);
    }

    return {
      path: '/api/admin/clientes/trier',
      body: {
        name: client.name,
        trierToken: client.credential,
        // host/port/user/password for the shared cache DB come from the
        // multi-provider's own TENANT_DB_ADMIN_* config now - every trier
        // tenant uses the same Postgres, so it no longer needs to be
        // duplicated (and kept in sync) across both services' envs.
        database: tenantDatabaseName(client.name),
        autoSync: true,
        autoSyncMode: 'bootstrap',
      },
    };
  }

  if (client.provider === 'vetor') {
    if (!client.credential) throw createError('Informe o token Vetor para criar a integracao.', 400);
    return {
      path: '/api/admin/clientes/vetor',
      body: {
        name: client.name,
        vetorToken: client.credential,
        unidade: client.instance,
        autoSync: false,
      },
    };
  }

  if (client.provider === 'automatiza') {
    return {
      path: '/api/admin/clientes/automatiza',
      body: {
        name: client.name,
        host: client.instance,
        port: client.alpha7Port || 3306,
        database: client.alpha7Database,
        user: client.alpha7User,
        password: client.credential,
        shopId: client.automatizaShopId,
        ssl: false,
      },
    };
  }

  if (client.provider === 'deliverypharmacy') {
    if (!client.credential || !client.deliveryCompanyId || !client.deliveryErpId) {
      throw createError('Informe token, Empresa ID e ERP ID da Delivery Pharmacy.', 400);
    }
    return {
      path: '/api/admin/clientes/deliverypharmacy',
      body: {
        name: client.name,
        deliveryToken: client.credential,
        empresaId: client.deliveryCompanyId,
        erpId: client.deliveryErpId,
      },
    };
  }

  return null;
}

export async function createMultiProviderClient(client) {
  if (client.provider === 'file') return null;

  const request = buildMultiProviderClientRequest(client);

  try {
    const response = await axios.post(
      `${env.MULTIPROVIDER_BASE_URL.replace(/\/+$/, '')}${request.path}`,
      request.body,
      {
        headers: { 'x-api-key': env.MULTIPROVIDER_ADMIN_API_KEY },
        timeout: 30000,
      },
    );
    const tenantId = Number(response.data?.instancia?.id);
    const apiKey = String(response.data?.apiKey || '').trim();

    if (!Number.isInteger(tenantId) || !apiKey) {
      throw createError('A API multi-provider nao retornou a credencial do cliente.', 502);
    }

    return { tenantId, apiKey };
  } catch (error) {
    if (error.statusCode) throw error;

    const statusCode = error.response?.status;
    const message = error.response?.data?.message || error.message;
    throw createError(`Falha ao criar o cliente no multi-provider: ${message}`, statusCode || 502);
  }
}

export async function regenerateMultiProviderApiKey(tenantId) {
  if (!tenantId) {
    throw createError('Este cliente nao possui integracao multi-provider configurada.', 400);
  }

  requireMultiProviderConfiguration();

  try {
    const response = await axios.post(
      `${env.MULTIPROVIDER_BASE_URL.replace(/\/+$/, '')}/api/admin/clientes/${tenantId}/regenerar-api-key`,
      {},
      {
        headers: { 'x-api-key': env.MULTIPROVIDER_ADMIN_API_KEY },
        timeout: 30000,
      },
    );
    const apiKey = String(response.data?.apiKey || '').trim();

    if (!apiKey) {
      throw createError('A API multi-provider nao retornou a nova credencial.', 502);
    }

    return apiKey;
  } catch (error) {
    if (error.statusCode) throw error;

    const statusCode = error.response?.status;
    const message = error.response?.data?.message || error.message;
    throw createError(`Falha ao gerar nova API key no multi-provider: ${message}`, statusCode || 502);
  }
}

export async function deleteMultiProviderClient(tenantId) {
  if (!tenantId) return;

  requireMultiProviderConfiguration();

  try {
    await axios.delete(
      `${env.MULTIPROVIDER_BASE_URL.replace(/\/+$/, '')}/api/admin/clientes/${tenantId}`,
      {
        headers: { 'x-api-key': env.MULTIPROVIDER_ADMIN_API_KEY },
        timeout: 30000,
      },
    );
  } catch (error) {
    const statusCode = error.response?.status;
    const message = error.response?.data?.message || error.message;
    throw createError(`Falha ao excluir o cliente no multi-provider: ${message}`, statusCode || 502);
  }
}
