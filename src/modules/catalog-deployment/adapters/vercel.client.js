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

function releaseNotReady(message, unitId) {
  return new DeploymentError('STOREFRONT_RELEASE_NOT_READY', message, {
    statusCode: 409, stage: 'waiting_storefront_release', unitId, retryable: true,
    action: 'Aguarde a Vercel publicar a revisão atual de grupounico/unicommerce:main.',
  });
}

async function currentMainSha(target, unitId) {
  if (!target.githubOwner || !target.githubRepo || !target.githubBranch) {
    throw releaseNotReady('A origem GitHub do storefront não está configurada.', unitId);
  }
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (target.githubToken) headers.Authorization = `Bearer ${target.githubToken}`;
    const response = await axios.get(
      `https://api.github.com/repos/${encodeURIComponent(target.githubOwner)}/${encodeURIComponent(target.githubRepo)}/commits/${encodeURIComponent(target.githubBranch)}`,
      { timeout: 30000, maxRedirects: 0, headers },
    );
    if (!/^[a-f0-9]{40}$/i.test(String(response.data?.sha || ''))) throw new Error('GitHub response has no commit SHA');
    return response.data.sha.toLowerCase();
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw releaseNotReady('Não foi possível confirmar a revisão atual da branch main no GitHub.', unitId);
  }
}

async function assertProjectBinding(target, unitId) {
  const project = (await withRetry(() => client(target).get(`/v9/projects/${encodeURIComponent(target.projectId)}`))).data;
  const link = project?.link || {};
  const owner = String(link.org || link.repoOwner || '').toLowerCase();
  const repo = String(link.repo || '').toLowerCase();
  const branch = String(link.productionBranch || project?.productionBranch || target.githubBranch || '').toLowerCase();
  if (link.type !== 'github' || owner !== target.githubOwner.toLowerCase()
      || repo !== target.githubRepo.toLowerCase() || branch !== target.githubBranch.toLowerCase()) {
    throw releaseNotReady('O projeto Vercel não está ligado a grupounico/unicommerce:main.', unitId);
  }
  return project;
}

export async function validatedMainDeployment(target, unitId) {
  await assertProjectBinding(target, unitId);
  const githubCommitSha = await currentMainSha(target, unitId);
  const response = await withRetry(() => client(target).get('/v7/deployments', {
    params: { projectId: target.projectId, target: 'production', state: 'READY', limit: 20 },
  }));
  const deployment = (response.data?.deployments || []).find((candidate) => {
    const meta = candidate.meta || {};
    return candidate?.uid && candidate.projectId === target.projectId
      && ['READY', undefined].includes(candidate.state)
      && ['READY', undefined].includes(candidate.readyState)
      && String(meta.githubCommitSha || '').toLowerCase() === githubCommitSha
      && String(meta.githubCommitRef || '').toLowerCase() === target.githubBranch.toLowerCase()
      && String(meta.githubCommitRepo || '').toLowerCase() === target.githubRepo.toLowerCase()
      && String(meta.githubCommitOrg || '').toLowerCase() === target.githubOwner.toLowerCase();
  });
  if (!deployment) {
    throw releaseNotReady('Ainda não existe deployment READY correspondente ao SHA atual da main.', unitId);
  }
  return { deployment, githubCommitSha, githubBranch: target.githubBranch, verifiedAt: new Date() };
}

export async function ensureProjectAlias(target, domain, unitId, expectedSha) {
  try {
    const release = await validatedMainDeployment(target, unitId);
    if (expectedSha && release.githubCommitSha !== expectedSha) {
      throw releaseNotReady('A branch main mudou durante a ativação; a nova release precisa ficar READY.', unitId);
    }
    const { deployment } = release;
    const existing = await withRetry(() => getAlias(target, domain));
    if (existing) {
      assertProject(existing, target, unitId);
      if (existing.deploymentId === deployment.uid) return { alias: existing, ...release };
    }
    const assigned = (await withRetry(() => client(target).post(
      `/v2/deployments/${encodeURIComponent(deployment.uid)}/aliases`,
      { alias: domain },
    ))).data;
    const reconciled = await withRetry(() => getAlias(target, domain));
    return { alias: assertProject(reconciled || assigned, target, unitId), ...release };
  } catch (error) {
    if (error.response?.status === 409) {
      try {
        const release = await validatedMainDeployment(target, unitId);
        if (expectedSha && release.githubCommitSha !== expectedSha) throw releaseNotReady('A branch main mudou durante a ativação.', unitId);
        const { deployment } = release;
        const reconciled = await getAlias(target, domain);
        if (reconciled && reconciled.deploymentId === deployment.uid) {
          return { alias: assertProject(reconciled, target, unitId), ...release };
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
      const banners = response.data?.branding?.banners;
      if (!Array.isArray(banners) || banners.length < 3
          || banners.some((banner) => !banner.image || !banner.mobileImage || banner.image === banner.mobileImage)) {
        throw new DeploymentError('STOREFRONT_BRANDING_V2_INVALID', 'O storefront não expôs os banners responsivos V2 esperados.', {
          statusCode: 409, stage: 'validating_storefront', unitId,
          action: 'Revise o branding desktop/mobile configurado para o tenant.',
        });
      }
      const catalog = await axios.get(`https://${domain}/api/catalog/products`, {
        timeout: Math.min(10000, Math.max(1000, deadline - Date.now())), maxRedirects: 0,
        headers: { Accept: 'application/json' }, params: { page: 1, pageSize: 50, minimumProducts: 20, maximumProducts: 50 },
      });
      const products = Array.isArray(catalog.data?.data) ? catalog.data.data : [];
      const sellable = products.filter((product) => Number(product.price) > 0 && Number(product.stock) > 0).length;
      if (sellable < 20) throw new DeploymentError('SELLABLE_PRODUCTS_BELOW_MINIMUM', 'O catálogo público possui menos de 20 produtos vendáveis.', {
        statusCode: 409, stage: 'validating_storefront', unitId,
        action: 'Revise preço e estoque antes de concluir a ativação.',
      });
      return { ...response.data, sellableProducts: sellable };
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
