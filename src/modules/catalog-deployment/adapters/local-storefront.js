import { DeploymentError } from '../errors.js';

export function localStorefrontProbe(target, domain, unitId) {
  let url;
  try { url = new URL(target.localBaseUrl); } catch { /* Rejected below. */ }
  const labels = String(domain).split('.');
  if (target.driver !== 'local' || !url || url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || domain.length > 253 || labels.length < 2 || labels.at(-1) !== 'localhost'
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new DeploymentError('LOCAL_STOREFRONT_INVALID', 'A loja local precisa usar loopback e um domínio .localhost.', {
      statusCode: 503, stage: 'configuration', unitId,
    });
  }
  return { origin: url.origin, headers: { Host: `${domain}${url.port ? `:${url.port}` : ''}` }, proxy: false };
}
