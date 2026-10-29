import crypto from 'node:crypto';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCatalogMcpServer } from './tools.js';

function sameSecret(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Dedicated key: the endpoint stays off until CATALOG_MCP_API_KEY is configured.
export function catalogMcpAuth({ environment = process.env } = {}) {
  return (req, res, next) => {
    const expected = environment.CATALOG_MCP_API_KEY;
    if (!expected || expected.length < 32) return res.status(503).json({ code: 'CATALOG_MCP_DISABLED', message: 'MCP do catálogo desativado. Configure CATALOG_MCP_API_KEY (mínimo de 32 caracteres).' });
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1];
    const provided = bearer || req.headers['x-api-key'];
    if (!provided || !sameSecret(provided, expected)) return res.status(401).json({ code: 'CATALOG_MCP_UNAUTHORIZED', message: 'Chave de acesso ao MCP inválida.' });
    return next();
  };
}

// Stateless Streamable HTTP: a fresh server and transport per request, so any
// instance behind the load balancer can answer and nothing leaks between calls.
export function createCatalogMcpRouter({ services, environment = process.env }) {
  const router = Router();
  router.use(catalogMcpAuth({ environment }));
  router.post('/', async (req, res) => {
    const server = createCatalogMcpServer(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Falha interna no MCP do catálogo.' }, id: null });
    }
  });
  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST: este MCP não mantém sessões.' }, id: null });
  router.get('/', notAllowed);
  router.delete('/', notAllowed);
  return router;
}
