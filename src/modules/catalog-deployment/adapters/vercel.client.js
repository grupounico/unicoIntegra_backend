import axios from 'axios';
import { DeploymentError, mapUpstreamError } from '../errors.js';
import { withRetry } from './http.js';

function client(target) {
  if (!target?.apiToken || !target?.teamId || !target?.projectId) {
    throw new DeploymentError('VERCEL_NOT_CONFIGURED', 'A automação da Vercel não está configurada.', {
      statusCode: 503,
      stage: 'configuration',
      action: 'Configure VERCEL_API_TOKEN, VERCEL_TEAM_ID e VERCEL_PROJECT_ID no servidor.',
    });
  }
  return axios.create({
    baseURL: 'https://api.vercel.com',
    timeout: 30000,
    maxRedirects: 0,
    headers: { Authorization: `Bearer ${target.apiToken}`, 'Content-Type': 'application/json' },
    params: { teamId: target.teamId },
  });
}

function mapVercelError(error, unitId) {
  if (error instanceof DeploymentError) return error;
  const status = Number(error.response?.status || 0);
  if (status === 401 || status === 403) {
    return new DeploymentError('VERCEL_AUTH_FAILED', 'A autenticação com a Vercel falhou.', {
      statusCode: 502, stage: 'provisioning_storefront', unitId,
      action: 'Revise o token e o acesso ao projeto compartilhado.',
    });
  }
  if (status === 409) {
    return new DeploymentError('VERCEL_DOMAIN_CONFLICT', 'O domínio já está associado a outro projeto.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId,
      action: 'Revise o domínio na Vercel antes de repetir.',
    });
  }
  return mapUpstreamError(error, 'VERCEL', 'provisioning_storefront', unitId);
}

async function getAlias(target, domain) {
  try {
    return (await client(target).get(`/v4/aliases/${encodeURIComponent(domain)}`)).data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

function assertProject(alias, target, unitId) {
  if (alias?.projectId && alias.projectId !== target.projectId) {
    throw new DeploymentError('VERCEL_DOMAIN_CONFLICT', 'O domínio já está associado a outro projeto.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId,
      action: 'Revise o domínio na Vercel antes de repetir.',
    });
  }
  return alias;
}

async function latestProductionDeployment(target, unitId) {
  const response = await withRetry(() => client(target).get('/v7/deployments', {
    params: { projectId: target.projectId, target: 'production', state: 'READY', limit: 1 },
  }));
  const deployment = response.data?.deployments?.[0];
  if (!deployment?.uid || deployment.projectId !== target.projectId
      || !['READY', undefined].includes(deployment.state)
      || !['READY', undefined].includes(deployment.readyState)) {
    throw new DeploymentError('VERCEL_DEPLOYMENT_NOT_READY', 'O projeto compartilhado não possui deployment de produção pronto.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId, retryable: true,
      action: 'Publique o storefront em produção na Vercel e tente novamente.',
    });
  }
  return deployment;
}

export async function ensureProjectAlias(target, domain, unitId) {
  try {
    const deployment = await latestProductionDeployment(target, unitId);
    const existing = await withRetry(() => getAlias(target, domain));
    if (existing) {
      assertProject(existing, target, unitId);
      if (existing.deploymentId === deployment.uid) return { alias: existing, deployment };
    }
    const assigned = (await withRetry(() => client(target).post(
      `/v2/deployments/${encodeURIComponent(deployment.uid)}/aliases`,
      { alias: domain },
    ))).data;
    const reconciled = await withRetry(() => getAlias(target, domain));
    return { alias: assertProject(reconciled || assigned, target, unitId), deployment };
  } catch (error) {
    if (error.response?.status === 409) {
      try {
        const deployment = await latestProductionDeployment(target, unitId);
        const reconciled = await getAlias(target, domain);
        if (reconciled && reconciled.deploymentId === deployment.uid) {
          return { alias: assertProject(reconciled, target, unitId), deployment };
        }
      } catch { /* mapped below */ }
    }
    throw mapVercelError(error, unitId);
  }
}

export async function validateStorefrontIdentity(storefrontTarget, domain, tenantId, unitId) {
  const timeoutMs = Math.max(5000, Number(storefrontTarget.healthTimeoutMs || 60000));
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(`https://${domain}/api/storefront/identity`, {
        timeout: Math.min(10000, Math.max(1000, deadline - Date.now())),
        maxRedirects: 0,
        headers: { Accept: 'application/json' },
      });
      if (response.data?.tenantId !== tenantId || response.data?.domain !== domain || response.data?.status !== 'active') {
        throw new DeploymentError('DOMAIN_TENANT_MISMATCH', 'O domínio respondeu com outro tenant.', {
          statusCode: 409, stage: 'validating_storefront', unitId,
          action: 'Desative o binding e revise a associação do domínio.',
        });
      }
      return response.data;
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      lastError = error;
      const status = Number(error.response?.status || 0);
      if (status && status < 500 && status !== 404 && status !== 429) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new DeploymentError('STOREFRONT_HEALTH_CHECK_FAILED', 'O storefront não respondeu corretamente dentro do prazo.', {
    statusCode: 502, stage: 'validating_storefront', unitId, retryable: true,
    httpStatus: Number(lastError?.response?.status || 0) || null,
    action: 'Aguarde a propagação do alias e tente novamente.',
  });
}
