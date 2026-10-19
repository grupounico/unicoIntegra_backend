export function createLocalCatalogDeploymentGuard({ database, fullFlowEnabled }) {
  return async (req, res, next) => {
    if (req.path.endsWith('/promote')) return res.status(403).json({ code: 'LOCAL_STAGING_PRODUCTION_DISABLED', message: 'Promoção para produção indisponível no servidor local.' });
    if (req.method === 'POST' && req.path === '/' && (req.body?.flowMode || 'full') === 'full' && !fullFlowEnabled) return res.status(409).json({ code: 'LOCAL_STAGING_FULL_NOT_CONFIGURED', message: 'Configure os destinos de staging do Banco Único e Unicommerce para testar o fluxo completo.' });
    if (req.method === 'GET' && req.path === '/') {
      const url = new URL(req.url, 'http://local'); url.searchParams.set('environment', 'staging'); req.url = `${url.pathname}${url.search}`;
    }
    // Static settings do not identify a deployment.
    if (['GET', 'HEAD'].includes(req.method) && /^\/atenderbem\/settings\/?$/i.test(req.path)) return next();
    const deploymentId = req.path.match(/^\/([^/]+)/)?.[1];
    if (deploymentId) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(deploymentId)) return res.status(404).json({ code: 'DEPLOYMENT_NOT_FOUND', message: 'Implantação de staging não encontrada.' });
      const deployment = await database.clientDeployment.findUnique({ where: { id: deploymentId }, select: { environment: true } });
      if (!deployment || deployment.environment !== 'staging') return res.status(404).json({ code: 'DEPLOYMENT_NOT_FOUND', message: 'Implantação de staging não encontrada.' });
    }
    next();
  };
}
