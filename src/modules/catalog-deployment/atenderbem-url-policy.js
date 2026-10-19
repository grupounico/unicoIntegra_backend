const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// This exception belongs only to the dedicated local staging process. It never
// permits HTTP MCP endpoints or arbitrary HTTP feeds, ports, origins or paths.
export function isLocalAtenderBemFeedAllowed(raw, environment = process.env) {
  if (environment.CATALOG_LOCAL_STAGING_SERVER !== 'true' || environment.CATALOG_DEPLOYMENT_ENVIRONMENT !== 'staging'
      || environment.NODE_ENV === 'production'
      || (environment.CATALOG_LOCAL_DEPLOYMENT_ENVIRONMENT ?? environment.CATALOG_DEPLOYMENT_ENVIRONMENT) !== 'staging') return false;
  let feed; let banco;
  try { feed = new URL(raw); banco = new URL(environment.BANCO_UNICO_STAGING_BASE_URL); } catch { return false; }
  if ([feed, banco].some((url) => url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || url.port !== '4196'
      || url.username || url.password || url.search || url.hash)) return false;
  return feed.toString().length <= 2048 && feed.origin === banco.origin
    && feed.pathname === `${banco.pathname.replace(/\/+$/, '')}/api/products/catalog/feed.csv`;
}
