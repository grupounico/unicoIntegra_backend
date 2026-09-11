import { publicError } from './errors.js';
import * as service from './service.js';

function actor(req) { return String(req.body?.requestedBy || req.headers['x-operator-name'] || 'Sistema').trim() || 'Sistema'; }
function correlation(req) { return String(req.headers['x-correlation-id'] || req.headers['x-request-id'] || '').trim() || null; }
function key(req) { return String(req.headers['idempotency-key'] || '').trim(); }
function handler(operation, success = 200) { return async (req, res) => { try { const value = await operation(req); return res.status(success).json(value); } catch (error) { const body = publicError(error, { deploymentId: req.params.deploymentId, unitId: req.params.unitId }); return res.status(error.statusCode || 500).json(body); } }; }

export const create = handler((req) => service.createDeployment(req.body || {}, key(req), correlation(req)), 202);
export const list = handler((req) => service.listDeployments(req.query || {}));
export const get = handler((req) => service.getDeployment(req.params.deploymentId));
export const start = handler((req) => service.startDeployment(req.params.deploymentId, actor(req)), 202);
export const retry = handler((req) => service.retryDeployment(req.params.deploymentId, actor(req)), 202);
export const retryUnit = handler((req) => service.retryUnit(req.params.deploymentId, req.params.unitId, actor(req)), 202);
export const runUnit = handler((req) => service.runUnit(req.params.deploymentId, req.params.unitId, key(req)), 202);
export const activateShadow = handler((req) => service.activateUnitShadow(req.params.deploymentId, req.params.unitId, key(req)), 202);
export const activateTenants = handler((req) => service.activateTenants(req.params.deploymentId, actor(req), key(req)), 202);
export const provisionStorefronts = handler((req) => service.provisionStorefronts(req.params.deploymentId, actor(req), key(req)), 202);
export const cancel = handler((req) => service.cancelDeployment(req.params.deploymentId, actor(req)), 202);
export const presignAssets = handler((req) => service.presignDeploymentAssets(req.params.deploymentId, req.body?.assets || []));
export const confirmAsset = handler((req) => service.confirmDeploymentAsset(req.params.deploymentId, req.body || {}));
export async function events(req, res) { try { return res.json(await service.listDeploymentEvents(req.params.deploymentId, req.query || {})); } catch (error) { return res.status(error.statusCode || 500).json(publicError(error, { deploymentId: req.params.deploymentId })); } }
export async function stream(req, res) { try { await service.getDeployment(req.params.deploymentId); service.subscribe(req.params.deploymentId, res); } catch (error) { if (!res.headersSent) res.status(error.statusCode || 500).json(publicError(error, { deploymentId: req.params.deploymentId })); } }
