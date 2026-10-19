import { isIP } from 'node:net';

const nonProductionMarker = /(?:^|[./_-])(?:stg|staging|sandbox|homolog(?:acao)?|local|dev|test|qa)(?:[./_-]|$)/i;

function fail(code, key) {
  throw new Error(`CATALOG_PRODUCTION_${code}${key ? `_${key}` : ''}`);
}

function required(environment, key, fallback) {
  const primary = String(environment[key] || '').trim();
  const value = primary || String(environment[fallback] || '').trim();
  if (!value) fail('MISSING', key);
  return { value, source: primary ? key : fallback };
}

function productionUrl(environment, key, fallback) {
  const resolved = required(environment, key, fallback);
  let url;
  try { url = new URL(resolved.value); } catch { fail('INVALID_URL', key); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || ['localhost', '[::1]', '::1', '0.0.0.0', '[::]', '::'].includes(host)
      || isIP(host.replace(/^\[|\]$/g, '')) || /\.(?:localhost|local|localdomain|test|invalid)$/.test(host)
      || nonProductionMarker.test(`${host}${url.pathname}`)) fail('UNSAFE_URL', key);
  return { url, source: resolved.source, summary: `${url.host}${url.pathname}` };
}

// Explicit release preflight, separate from the generic server so legitimate
// staging containers can still use NODE_ENV=production. This never contacts a
// target, opens the database, runs migrations, or returns credential values.
export function checkCatalogProductionEnvironment(environment) {
  if (environment.NODE_ENV !== 'production') fail('NODE_ENV_REQUIRED');
  for (const key of ['CATALOG_DEPLOYMENT_ENVIRONMENT', 'CATALOG_WORKER_ENVIRONMENT']) {
    if (environment[key] !== 'production') fail('ENVIRONMENT_REQUIRED', key);
  }
  for (const [key, raw] of Object.entries(environment)) {
    if (key.startsWith('CATALOG_LOCAL_') && !['', 'false', '0'].includes(String(raw || '').trim().toLowerCase())) fail('LOCAL_SETTING_FORBIDDEN', key);
  }
  const sources = {};
  const targets = {};
  for (const [name, prefix, secret] of [
    ['hub', 'HUBUNICO', 'ADMIN_API_KEY'],
    ['banco', 'BANCO_UNICO', 'AUTHORIZATION'],
    ['commerce', 'UNICOMMERCE_BACK', 'INTERNAL_API_KEY'],
  ]) {
    const target = productionUrl(environment, `${prefix}_PRODUCTION_BASE_URL`, `${prefix}_BASE_URL`);
    targets[name] = target.summary;
    sources[`${name}Url`] = target.source;
    sources[`${name}Credential`] = required(environment, `${prefix}_PRODUCTION_${secret}`, `${prefix}_${secret}`).source;
  }
  const encryptionKey = required(environment, 'DEPLOYMENT_ENCRYPTION_KEY').value;
  if ((/^[a-f0-9]{64}$/i.test(encryptionKey) ? Buffer.from(encryptionKey, 'hex') : Buffer.from(encryptionKey, 'base64')).length !== 32) fail('INVALID_ENCRYPTION_KEY');
  required(environment, 'DATABASE_URL');
  if (environment.STOREFRONT_PROVISIONING_ENABLED !== 'true') fail('STOREFRONT_MUST_BE_ENABLED');
  for (const field of ['API_TOKEN', 'TEAM_ID', 'PROJECT_ID']) {
    sources[`vercel${field}`] = required(environment, `VERCEL_PRODUCTION_${field}`, `VERCEL_${field}`).source;
  }
  const feed = productionUrl(environment, 'CATALOG_ATENDERBEM_FEED_BASE_URL');
  const allowedFeedHosts = String(environment.CATALOG_FEED_ALLOWED_HOSTS || 'unicocontato.tech').split(',').map(value => value.trim().toLowerCase());
  if (!allowedFeedHosts.includes(feed.url.hostname.toLowerCase()) || (feed.url.port && feed.url.port !== '443')) fail('FEED_HOST_NOT_ALLOWED');
  targets.atenderBemFeed = feed.summary;
  return { environment: 'production', workerEnvironment: 'production', storefrontDriver: 'vercel', targets, sources };
}
