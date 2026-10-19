import axios from 'axios';
import { DeploymentError, mapUpstreamError } from '../errors.js';
import { withRetry } from './http.js';
import { localStorefrontProbe } from './local-storefront.js';

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
  if (status === 403) return new DeploymentError('VERCEL_PERMISSION_DENIED', 'O token não permite configurar o projeto Vercel.', {
    statusCode: 502, stage: 'provisioning_storefront', unitId, httpStatus: status,
    action: 'Revise as permissões do token na equipe e no projeto configurados.',
  });
  if (status === 401) {
    return new DeploymentError('VERCEL_AUTH_FAILED', 'A autenticação com a Vercel falhou.', {
      statusCode: 502, stage: 'provisioning_storefront', unitId, httpStatus: status,
      action: 'Revise o token e o acesso ao projeto compartilhado.',
    });
  }
  if (status === 409 || ['domain_already_in_use', 'domain_taken', 'domain_already_in_use_by_project'].includes(error.response?.data?.error?.code)) {
    return new DeploymentError('VERCEL_DOMAIN_CONFLICT', 'O domínio já está associado a outro projeto.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId, httpStatus: status,
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

const STANDARD_PROTECTION = 'prod_deployment_urls_and_all_previews';

export async function ensureProductionAccess(target, environment, unitId) {
  if (environment !== 'production') return { managed: false };
  try {
    let project = await assertProjectBinding(target, unitId);
    const previous = project.ssoProtection?.deploymentType || null;
    if (previous !== STANDARD_PROTECTION) {
      await withRetry(() => client(target).patch(`/v9/projects/${encodeURIComponent(target.projectId)}`, {
        ssoProtection: { deploymentType: STANDARD_PROTECTION },
      }));
      project = await assertProjectBinding(target, unitId);
    }
    if (project.ssoProtection?.deploymentType !== STANDARD_PROTECTION) {
      throw new DeploymentError('VERCEL_PROTECTION_NOT_CONFIGURED', 'A Vercel não confirmou a política de produção pública.', {
        stage: 'provisioning_storefront', unitId, retryable: true,
      });
    }
    return { managed: true, previous, deploymentType: STANDARD_PROTECTION };
  } catch (error) { throw mapVercelError(error, unitId); }
}

async function getProjectDomain(target, domain) {
  try { return (await client(target).get(`/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(domain)}`)).data; }
  catch (error) { if (error.response?.status === 404) return null; throw error; }
}

export async function ensureProjectDomain(target, domain, unitId) {
  try {
    await assertProjectBinding(target, unitId);
    const alias = await withRetry(() => getAlias(target, domain));
    if (alias) assertProject(alias, target, unitId);
    let registered = await withRetry(() => getProjectDomain(target, domain));
    if (!registered) {
      await withRetry(async () => {
        try { await client(target).post(`/v10/projects/${encodeURIComponent(target.projectId)}/domains`, { name: domain }); }
        catch (error) {
          // Timeout/concurrent create can have committed. Re-read before retrying.
          if ([401, 403].includes(error.response?.status)) throw error;
          if (!await getProjectDomain(target, domain)) throw error;
        }
      });
      registered = await withRetry(() => getProjectDomain(target, domain));
    }
    assertProject(registered, target, unitId);
    if (!registered || registered.name !== domain || registered.projectId !== target.projectId) {
      throw new DeploymentError('VERCEL_DOMAIN_NOT_READY', 'O cadastro do domínio no projeto ainda não foi confirmado.', {
        stage: 'provisioning_storefront', unitId, retryable: true,
      });
    }
    const path = `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(domain)}`;
    if (registered.gitBranch || registered.customEnvironmentId || registered.redirect) {
      await withRetry(() => client(target).patch(path, { gitBranch: null, customEnvironmentId: null, redirect: null }));
      registered = await withRetry(() => getProjectDomain(target, domain));
    }
    let verificationHttpStatus = null;
    if (registered?.verified === false) {
      try { await withRetry(() => client(target).post(`${path}/verify`)); }
      catch (error) {
        // Verification challenges may remain pending; permissions and outages retain their own diagnosis.
        if (error.response?.status !== 400) throw error;
        verificationHttpStatus = 400;
      }
      registered = await withRetry(() => getProjectDomain(target, domain));
    }
    if (registered?.verified !== true) {
      throw new DeploymentError('VERCEL_DOMAIN_UNVERIFIED', 'A Vercel ainda não verificou o domínio deste projeto.', {
        stage: 'provisioning_storefront', unitId, retryable: true, httpStatus: verificationHttpStatus,
        action: 'Aguarde a verificação; se persistir, confira propriedade e DNS do domínio.',
      });
    }
    if (registered.projectId !== target.projectId || registered.gitBranch || registered.customEnvironmentId || registered.redirect) {
      throw new DeploymentError('VERCEL_DOMAIN_CONFIGURATION_INVALID', 'O domínio não está associado diretamente a Production.', {
        stage: 'provisioning_storefront', unitId,
      });
    }
    return { domain, projectId: registered.projectId, verified: true, environment: 'production' };
  } catch (error) { throw mapVercelError(error, unitId); }
}

export async function validatedMainDeployment(target, unitId) {
  try {
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
  } catch (error) { throw mapVercelError(error, unitId); }
}

export async function ensureProjectAlias(target, domain, unitId, expectedSha) {
  try {
    const release = await validatedMainDeployment(target, unitId);
    if (expectedSha && release.githubCommitSha !== expectedSha) {
      throw releaseNotReady('A branch main mudou durante a ativação; a nova release precisa ficar READY.', unitId);
    }
    const { deployment } = release;
    await ensureProjectDomain(target, domain, unitId);
    const existing = await withRetry(() => getAlias(target, domain));
    if (existing) {
      assertProject(existing, target, unitId);
      if (existing.deploymentId === deployment.uid) return { alias: existing, ...release };
    }
    await withRetry(async () => {
      try { await client(target).post(`/v2/deployments/${encodeURIComponent(deployment.uid)}/aliases`, { alias: domain }); }
      catch (error) {
        if ([401, 403].includes(error.response?.status)) throw error;
        const found = await getAlias(target, domain);
        assertProject(found, target, unitId);
        if (found?.deploymentId !== deployment.uid) throw error;
      }
    });
    const reconciled = await withRetry(() => getAlias(target, domain));
    assertProject(reconciled, target, unitId);
    if (!reconciled || reconciled.deploymentId !== deployment.uid || reconciled.projectId !== target.projectId) {
      throw new DeploymentError('VERCEL_ALIAS_NOT_READY', 'O alias ainda não aponta para a release esperada.', {
        stage: 'provisioning_storefront', unitId, retryable: true,
      });
    }
    return { alias: reconciled, ...release };
  } catch (error) {
    throw mapVercelError(error, unitId);
  }
}

export async function validateStorefrontIdentity(storefrontTarget, domain, tenantId, unitId) {
  const local = storefrontTarget.driver === 'local' ? localStorefrontProbe(storefrontTarget, domain, unitId) : null;
  const origin = local?.origin || `https://${domain}`;
  const timeoutMs = Math.max(5000, Number(storefrontTarget.healthTimeoutMs || 60000));
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(`${origin}/api/storefront/identity`, {
        timeout: Math.min(10000, Math.max(1000, deadline - Date.now())),
        maxRedirects: 0,
        headers: { Accept: 'application/json', ...local?.headers },
        ...(local ? { proxy: false } : {}),
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
      const catalog = await axios.get(`${origin}/api/catalog/products`, {
        timeout: Math.min(10000, Math.max(1000, deadline - Date.now())), maxRedirects: 0,
        headers: { Accept: 'application/json', ...local?.headers }, params: { page: 1, pageSize: 50, minimumProducts: 20, maximumProducts: 50 },
        ...(local ? { proxy: false } : {}),
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
      let vercelLogin = false;
      try { const redirect = new URL(String(error.response?.headers?.location || '')); vercelLogin = redirect.hostname === 'vercel.com' && /^\/(sso-api|login)(\/|$)/.test(redirect.pathname); } catch { /* Not a login redirect. */ }
      if (vercelLogin || status === 401 || status === 403) {
        throw new DeploymentError(vercelLogin ? 'STOREFRONT_AUTHENTICATION_REQUIRED' : 'STOREFRONT_ACCESS_BLOCKED',
          vercelLogin ? 'A loja está exigindo login da Vercel.' : 'O acesso público à loja foi bloqueado.', {
            stage: 'validating_storefront', unitId, httpStatus: status,
            action: vercelLogin ? 'Confira a política de Production e o cadastro do domínio.' : 'Confira firewall, restrições de IP e proteção adicional.',
          });
      }
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
