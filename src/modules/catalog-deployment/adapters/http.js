import axios from 'axios';

export function createHttpClient(baseURL, headers = {}) {
  return axios.create({ baseURL: String(baseURL || '').replace(/\/+$/, ''), headers, timeout: 30000, maxRedirects: 0 });
}

export async function withRetry(operation, { attempts = 3, baseDelayMs = 250 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      const status = Number(error.response?.status || 0);
      if (attempt === attempts || (status && status !== 429 && status < 500)) throw error;
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (2 ** (attempt - 1)) + jitter));
    }
  }
  throw lastError;
}
