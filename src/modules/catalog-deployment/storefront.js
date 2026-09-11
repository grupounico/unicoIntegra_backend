import crypto from 'node:crypto';
import { DeploymentError } from './errors.js';
import { slugify } from './validation.js';

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
