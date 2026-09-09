import { env } from '../../config/env.js';
import { DeploymentError } from './errors.js';

export const CATALOG_ENVIRONMENTS = ['production', 'staging'];

export function selectedCatalogEnvironment() {
  const value = String(env.CATALOG_DEPLOYMENT_ENVIRONMENT || '').toLowerCase();
  if (!CATALOG_ENVIRONMENTS.includes(value)) {
    throw new DeploymentError('CATALOG_ENVIRONMENT_INVALID', 'O ambiente do Catálogo é inválido.', {
      statusCode: 503,
      stage: 'configuration',
      action: 'Use CATALOG_DEPLOYMENT_ENVIRONMENT=production ou staging.',
    });
  }
  return value;
}

export function catalogTargets(environment) {
  const selected = String(environment || '').toLowerCase();
  if (!CATALOG_ENVIRONMENTS.includes(selected)) {
    throw new DeploymentError('CATALOG_ENVIRONMENT_INVALID', 'A implantação possui um ambiente inválido.', {
      statusCode: 503, stage: 'configuration', retryable: false,
    });
  }
  const production = selected === 'production';
  return {
    environment: selected,
    hub: {
      baseUrl: production ? env.HUBUNICO_PRODUCTION_BASE_URL || env.HUBUNICO_BASE_URL : env.HUBUNICO_STAGING_BASE_URL,
      adminApiKey: production ? env.HUBUNICO_PRODUCTION_ADMIN_API_KEY || env.HUBUNICO_ADMIN_API_KEY : env.HUBUNICO_STAGING_ADMIN_API_KEY,
    },
    unicommerce: {
      baseUrl: production ? env.UNICOMMERCE_BACK_PRODUCTION_BASE_URL || env.UNICOMMERCE_BACK_BASE_URL : env.UNICOMMERCE_BACK_STAGING_BASE_URL,
      internalApiKey: production ? env.UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY || env.UNICOMMERCE_BACK_INTERNAL_API_KEY : env.UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY,
    },
    bancoUnico: {
      baseUrl: production ? env.BANCO_UNICO_PRODUCTION_BASE_URL || env.BANCO_UNICO_BASE_URL : env.BANCO_UNICO_STAGING_BASE_URL,
      authorization: production ? env.BANCO_UNICO_PRODUCTION_AUTHORIZATION || env.BANCO_UNICO_AUTHORIZATION : env.BANCO_UNICO_STAGING_AUTHORIZATION,
    },
  };
}
