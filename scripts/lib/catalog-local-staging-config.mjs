export const LOCAL_CATALOG_DATABASE = 'unico_catalog_staging_local';
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function applyLocalCatalogStagingEnvironment(configuration, envPath, destination = process.env) {
  Object.assign(destination, configuration.environment, { DOTENV_CONFIG_PATH: envPath, DOTENV_CONFIG_QUIET: 'true' });
  // dotenv/config passes string env options through: even the string 'false'
  // enables override. Leave this option absent so guarded values stay intact.
  delete destination.DOTENV_CONFIG_OVERRIDE;
}

function required(environment, key) {
  const value = String(environment[key] || '').trim();
  if (!value) throw new Error(`LOCAL_STAGING_MISSING_${key}`);
  return value;
}

function target(value, key, { pathOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`LOCAL_STAGING_INVALID_${key}`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (!loopback.has(url.hostname) && url.protocol !== 'https:')) throw new Error(`LOCAL_STAGING_UNSAFE_${key}`);
  const marker = /(?:^|[./_-])staging(?:[./_-]|$)/i;
  if (!(marker.test(url.pathname) || (!pathOnly && (loopback.has(url.hostname) || marker.test(url.hostname))))) throw new Error(`LOCAL_STAGING_TARGET_NOT_STAGING_${key}`);
  return url;
}

export function buildLocalCatalogStagingEnvironment(input) {
  const environment = { ...input };
  let database;
  try { database = new URL(required(environment, 'DATABASE_URL')); } catch { throw new Error('LOCAL_STAGING_INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !loopback.has(database.hostname)
      || decodeURIComponent(database.pathname.slice(1)) !== LOCAL_CATALOG_DATABASE || !database.username || !database.password
      || [...database.searchParams.keys()].some((key) => !['schema', 'sslmode', 'application_name'].includes(key))
      || (database.searchParams.has('schema') && database.searchParams.get('schema') !== 'sistema')
      || (database.searchParams.has('sslmode') && database.searchParams.get('sslmode') !== 'disable')) throw new Error('LOCAL_STAGING_DATABASE_MUST_BE_DEDICATED_LOOPBACK');
  const hub = target(required(environment, 'HUBUNICO_STAGING_BASE_URL'), 'HUBUNICO_STAGING_BASE_URL', { pathOnly: true });
  required(environment, 'HUBUNICO_STAGING_ADMIN_API_KEY');
  // An explicit empty value prevents dotenv from inheriting a production feed.
  const atenderBemFeed = String(environment.CATALOG_ATENDERBEM_FEED_BASE_URL || '').trim();
  if (atenderBemFeed) {
    if (!isLocalAtenderBemFeedAllowed(atenderBemFeed, { ...environment, CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging' })) {
      const feed = target(atenderBemFeed, 'CATALOG_ATENDERBEM_FEED_BASE_URL');
      if (feed.protocol !== 'https:') throw new Error('LOCAL_STAGING_UNSAFE_CATALOG_ATENDERBEM_FEED_BASE_URL');
    }
  }
  environment.CATALOG_ATENDERBEM_FEED_BASE_URL = atenderBemFeed;
  const encryptionKey = required(environment, 'DEPLOYMENT_ENCRYPTION_KEY');
  if ((/^[a-f0-9]{64}$/i.test(encryptionKey) ? Buffer.from(encryptionKey, 'hex') : Buffer.from(encryptionKey, 'base64')).length !== 32) throw new Error('LOCAL_STAGING_INVALID_ENCRYPTION_KEY');
  for (const key of ['BANCO_UNICO_STAGING_BASE_URL', 'UNICOMMERCE_BACK_STAGING_BASE_URL']) {
    if (environment[key]) target(environment[key], key);
  }
  const fullFlowEnabled = environment.CATALOG_LOCAL_FULL_FLOW_ENABLED === 'true';
  if (fullFlowEnabled) {
    for (const key of ['BANCO_UNICO_STAGING_BASE_URL', 'BANCO_UNICO_STAGING_AUTHORIZATION', 'UNICOMMERCE_BACK_STAGING_BASE_URL', 'UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY']) required(environment, key);
  }
  let localStorefront = null;
  if (environment.CATALOG_LOCAL_STOREFRONT_BASE_URL) {
    if (environment.CATALOG_LOCAL_STAGING_SERVER !== 'true') throw new Error('LOCAL_STAGING_STOREFRONT_REQUIRES_LOCAL_FLAG');
    localStorefront = target(environment.CATALOG_LOCAL_STOREFRONT_BASE_URL, 'CATALOG_LOCAL_STOREFRONT_BASE_URL');
    if (!loopback.has(localStorefront.hostname) || localStorefront.pathname !== '/') throw new Error('LOCAL_STAGING_STOREFRONT_MUST_BE_LOOPBACK');
  }
  const storefrontEnabled = Boolean(localStorefront) || environment.STOREFRONT_PROVISIONING_ENABLED === 'true';
  if (storefrontEnabled) {
    if (!fullFlowEnabled) throw new Error('LOCAL_STAGING_STOREFRONT_REQUIRES_FULL_FLOW');
    if (!localStorefront) for (const key of ['VERCEL_STAGING_API_TOKEN', 'VERCEL_STAGING_TEAM_ID', 'VERCEL_STAGING_PROJECT_ID']) required(environment, key);
  }
  for (const key of Object.keys(environment)) {
    if (key.includes('_PRODUCTION_')) environment[key] = '';
  }
  for (const key of ['HUBUNICO_BASE_URL', 'HUBUNICO_ADMIN_API_KEY', 'UNICOMMERCE_BACK_BASE_URL', 'UNICOMMERCE_BACK_INTERNAL_API_KEY', 'BANCO_UNICO_BASE_URL', 'BANCO_UNICO_AUTHORIZATION', 'MULTIPROVIDER_BASE_URL', 'MULTIPROVIDER_ADMIN_API_KEY', 'VERCEL_API_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID']) environment[key] = '';
  Object.assign(environment, {
    HOST: '127.0.0.1', PORT: '4199', CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging', CATALOG_WORKER_ENVIRONMENT: 'staging',
    CATALOG_LOCAL_STAGING_SERVER: 'true',
    CATALOG_PRODUCTION_PROMOTION_ENABLED: 'false', BANCO_UNICO_IMPORT_WORKER_ENABLED: 'false', AI_URA_AUDIT_ENABLED: 'false',
    DEPLOYMENT_WORKER_ENABLED: environment.DEPLOYMENT_WORKER_ENABLED === 'false' ? 'false' : 'true',
    STOREFRONT_PROVISIONING_ENABLED: String(storefrontEnabled),
    DBHOST: database.hostname.replace(/^\[|\]$/g, ''), DBPORT: database.port || '5432',
    DBUSER: decodeURIComponent(database.username), DBPASSWORD: decodeURIComponent(database.password), DB_DATABASE: LOCAL_CATALOG_DATABASE,
    ...(localStorefront ? { STOREFRONT_DOMAIN_PREFIX: 'qa', STOREFRONT_DOMAIN_SUFFIX: 'test.localhost' } : {}),
  });
  const origins = String(environment.CATALOG_LOCAL_FRONTEND_ORIGINS || 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173').split(',').map((value) => value.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('LOCAL_STAGING_INVALID_FRONTEND_ORIGIN'); }
    if (!loopback.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('LOCAL_STAGING_INVALID_FRONTEND_ORIGIN');
  }
  return { environment, origins, fullFlowEnabled, summary: {
    bind: 'http://127.0.0.1:4199', database: `${database.hostname}:${database.port || '5432'}/${LOCAL_CATALOG_DATABASE}`,
    hub: `${hub.hostname}${hub.port ? `:${hub.port}` : ''}${hub.pathname}`, workerEnvironment: 'staging', fullFlowEnabled, storefrontEnabled,
    storefrontDriver: localStorefront ? 'local' : storefrontEnabled ? 'vercel' : 'disabled',
    bancoConfigured: Boolean(environment.BANCO_UNICO_STAGING_BASE_URL && environment.BANCO_UNICO_STAGING_AUTHORIZATION),
    unicommerceConfigured: Boolean(environment.UNICOMMERCE_BACK_STAGING_BASE_URL && environment.UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY),
  } };
}
import { isLocalAtenderBemFeedAllowed } from '../../src/modules/catalog-deployment/atenderbem-url-policy.js';
