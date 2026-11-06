import crypto from 'node:crypto';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCatalogMcpServer } from './tools.js';
import { prisma } from '../../../prisma/PrismaClient.js';

function sameSecret(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Two ways in: a per-user token created in the Integra (scoped, expiring,
// revocable) or the optional static CATALOG_MCP_API_KEY (full access).
export function catalogMcpAuth({ environment = process.env, database = prisma, now = () => new Date() } = {}) {
  return async (req, res, next) => {
    const expected = environment.CATALOG_MCP_API_KEY;
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1];
    const provided = bearer || req.headers['x-api-key'];
    if (provided && String(provided).startsWith('uim_')) {
      const secretHash = crypto.createHash('sha256').update(String(provided)).digest('hex');
      const credential = await database.mcpCredential.findUnique({ where: { secretHash } }).catch(() => null);
      if (credential && !credential.revokedAt && credential.expiresAt > now()) {
        await database.mcpCredential.update({ where: { id: credential.id }, data: { lastUsedAt: now() } }).catch(() => {});
        req.mcpCredential = credential;
        return next();
      }
      return res.status(401).json({ code: 'CATALOG_MCP_UNAUTHORIZED', message: 'Token MCP inválido, revogado ou expirado.' });
    }
    if (!provided || !expected || expected.length < 32 || !sameSecret(provided, expected)) return res.status(401).json({ code: 'CATALOG_MCP_UNAUTHORIZED', message: 'Chave de acesso ao MCP inválida ou expirada.' });
    return next();
  };
}

// Stateless Streamable HTTP: a fresh server and transport per request, so any
// instance behind the load balancer can answer and nothing leaks between calls.
export function createCatalogMcpRouter({ services, environment = process.env, database = prisma }) {
  const router = Router();
  router.use(catalogMcpAuth({ environment, database }));
  router.post('/', async (req, res) => {
    const server = createCatalogMcpServer(services, req.mcpCredential);
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
