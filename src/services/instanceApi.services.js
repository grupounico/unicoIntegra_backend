import axios from 'axios';

import loginInstance from './loginInstance.js';
import { resolveInstanceExecutionCredentials } from './instanceExecutionAuth.services.js';

export async function authenticateInstance(
  instance,
  username,
  password,
  code,
  loginOptions,
) {
  const resolved = resolveInstanceExecutionCredentials({
    username,
    password,
    code2fa: code,
  });

  const loginData = await loginInstance(
    instance,
    resolved.username,
    resolved.password,
    resolved.code2fa,
    loginOptions,
  );
  return loginData.token;
}

function getInstanceHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function postToInstance(instance, endpoint, payload, token) {
  const response = await axios.post(`${instance}${endpoint}`, payload, {
    headers: getInstanceHeaders(token),
  });

  return response.data;
}

async function putToInstance(instance, endpoint, payload, token) {
  const response = await axios.put(`${instance}${endpoint}`, payload, {
    headers: getInstanceHeaders(token),
  });

  return response.data;
}

async function getFromInstance(instance, endpoint, token) {
  const response = await axios.get(`${instance}${endpoint}`, {
    headers: getInstanceHeaders(token),
  });

  return response.data;
}

export function postIvr(instance, payload, token) {
  return postToInstance(instance, '/ivrs/', payload, token);
}

export function updateIvr(instance, ivrId, payload, token) {
  return putToInstance(instance, `/ivrs/${ivrId}`, payload, token);
}

export function getIvr(instance, ivrId, token) {
  return getFromInstance(instance, `/ivrs/${ivrId}`, token);
}

export function createAssistantItem(instance, payload, token) {
  return postToInstance(instance, '/assistants/createItem', payload, token);
}

export function updateAssistantItem(instance, payload, token) {
  return postToInstance(instance, '/assistants/updateItem', payload, token);
}
