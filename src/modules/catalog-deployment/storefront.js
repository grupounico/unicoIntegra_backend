import crypto from 'node:crypto';
import { DeploymentError } from './errors.js';
import { slugify } from './validation.js';

// Routing is tenant-specific. Never consult a global ecommerce URL here.
export function tenantStorefrontUrls({ storefrontDomain, ecommerceBaseUrl } = {}, unitId) {
  const domain = typeof storefrontDomain === 'string' ? storefrontDomain.trim().toLowerCase() : '';
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || labels.length < 2 || labels.some((part) =>
    part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new DeploymentError('STOREFRONT_DOMAIN_INVALID', 'storefrontDomain deve ser um hostname sem protocolo ou caminho.', {
      statusCode: 422, stage: 'provisioning_storefront', unitId,
    });
  }
  const expectedUrl = `https://${domain}`;
  let url;
  try { url = new URL(ecommerceBaseUrl || expectedUrl); } catch { /* rejected below */ }
  if (!url || url.protocol !== 'https:' || url.hostname !== domain || url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new DeploymentError('ECOMMERCE_BASE_URL_INVALID', 'ecommerceBaseUrl deve ser a URL HTTPS do domínio desta unidade, sem caminho ou credenciais.', {
      statusCode: 422, stage: 'provisioning_storefront', unitId,
    });
  }
  return { storefrontDomain: domain, ecommerceBaseUrl: expectedUrl };
}

export function assertTenantStorefrontUrls(tenant, routing, tenantId, unitId, expectedStatus) {
  const expected = tenantStorefrontUrls(routing, unitId);
  if (String(tenant?.id) !== String(tenantId) || tenant?.storefrontDomain !== expected.storefrontDomain
      || (expectedStatus && tenant?.status !== expectedStatus)) {
    throw new DeploymentError('DOMAIN_TENANT_MISMATCH', 'O domínio não foi associado ao tenant e estado esperados.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId,
    });
  }
  if (tenant?.ecommerceBaseUrl !== expected.ecommerceBaseUrl) {
    throw new DeploymentError('ECOMMERCE_BASE_URL_NOT_PERSISTED', 'O tenant não persistiu ecommerceBaseUrl com a URL HTTPS desta unidade. A instalação não pode ser concluída.', {
      statusCode: 409, stage: 'provisioning_storefront', unitId,
      action: 'Confira o suporte a ecommerceBaseUrl no UnicommerceBack e tente novamente pelo painel.',
    });
  }
  return tenant;
}

function label(value, field) {
  const normalized = slugify(value);
  if (!normalized) {
    throw new DeploymentError('STOREFRONT_DOMAIN_INVALID', `Não foi possível gerar o domínio a partir de ${field}.`, {
      statusCode: 422,
      stage: 'provisioning_storefront',
      action: `Revise ${field} no cadastro da implantação.`,
    });
  }
  return normalized;
}

function fitLabel(value) {
  if (value.length <= 63) return value;
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${value.slice(0, 54).replace(/-+$/, '')}-${hash}`;
}

export function buildStorefrontDomain({ username, unit, prefix = 'whatsapp', suffix = 'vercel.app' }) {
  const domainSuffix = String(suffix || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const suffixLabels = domainSuffix.split('.');
  if (suffixLabels.length < 2 || suffixLabels.some((item) => !item || item.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(item))) {
    throw new DeploymentError('STOREFRONT_DOMAIN_INVALID', 'O sufixo de domínio do storefront é inválido.', {
      statusCode: 503,
      stage: 'configuration',
      action: 'Revise STOREFRONT_DOMAIN_SUFFIX.',
    });
  }
  const base = [label(prefix, 'STOREFRONT_DOMAIN_PREFIX'), label(username, 'group.username')];
  if (!unit.isInitial) base.push(label(unit.code, 'units[].codigo'));
  const hostname = `${fitLabel(base.join('-'))}.${domainSuffix}`;
  if (hostname.length > 253) {
    throw new DeploymentError('STOREFRONT_DOMAIN_INVALID', 'O domínio gerado excede o limite permitido.', {
      statusCode: 422,
      stage: 'provisioning_storefront',
      unitId: unit.id,
    });
  }
  return hostname;
}

export function selectStorefrontDomain({ persistedDomain, tenantDomain, ...generated }) {
  const existing = String(persistedDomain || tenantDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!existing) return buildStorefrontDomain(generated);
  const labels = existing.split('.');
  if (existing.length > 253 || labels.length < 2 || labels.some((item) => !item || item.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(item))) {
    throw new DeploymentError('STOREFRONT_DOMAIN_INVALID', 'O domínio já associado ao tenant é inválido.', {
      statusCode: 409,
      stage: 'provisioning_storefront',
      action: 'Revise o domínio configurado no UnicommerceBack antes de repetir.',
    });
  }
  return existing;
}
