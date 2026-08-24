import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ALLOWED_ORIGINS = [
  'https://status.example.test',
  'https://dashboard.example.test',
];

function expectVaryOrigin(response: Response): void {
  const varyTokens = response.headers.get('vary')
    ?.split(',')
    .map((value) => value.trim().toLowerCase());
  expect(varyTokens).toContain('origin');
}

describe('public health probe', () => {
  it('serves a lightweight health response without authentication', async () => {
    const response = await SELF.fetch('https://example.test/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'edge-kintai',
    });
  });

  it.each(ALLOWED_ORIGINS)('allows %s to read the health response', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expectVaryOrigin(response);
  });

  it.each(ALLOWED_ORIGINS)('answers the %s health preflight', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expectVaryOrigin(response);
  });

  it.each([
    'https://example.com',
    'http://status.example.test',
    'https://status.example.test/',
    'https://dashboard.example.test/',
    'https://dashboard.example.test/project/',
    'https://dashboard.example.test.evil.example',
  ])('does not grant CORS access to %s', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps probe CORS isolated and retires the duplicate API health route', async () => {
    const response = await SELF.fetch('https://example.test/api/health', {
      headers: { Origin: 'https://dashboard.example.test' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: 'APIが見つかりません' });
  });

  it('keeps the D1 readiness probe authenticated and outside public CORS', async () => {
    const response = await SELF.fetch('https://example.test/api/health/ready', {
      headers: { Origin: 'https://dashboard.example.test' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
