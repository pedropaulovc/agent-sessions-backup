import { describe, expect, it, vi } from 'vitest';
import { proxyPreview } from '../../gateway/preview-front-door';
import configSource from '../../wrangler.preview-front-door.jsonc?raw';

const PUBLIC = 'https://fix-claude-compaction-preview.sessions.vza.net';
const UPSTREAM = 'https://fix-claude-compaction-sessions-hub-preview.pedro-18e.workers.dev';

interface FrontDoorConfig {
  name: string;
  main: string;
  workers_dev: boolean;
  preview_urls: boolean;
  compatibility_flags: string[];
  routes: Array<{ pattern: string; zone_name: string }>;
}

const config = JSON.parse(configSource.replace(/^\s*\/\/.*$/gm, '')) as FrontDoorConfig;

describe('preview front door', () => {
  it('is an independent Worker bound only to the wildcard preview route', () => {
    expect(config).toMatchObject({
      name: 'sessions-preview-front-door',
      main: 'gateway/preview-front-door.ts',
      workers_dev: false,
      preview_urls: false,
      compatibility_flags: ['global_fetch_strictly_public'],
      routes: [{ pattern: '*-preview.sessions.vza.net/*', zone_name: 'vza.net' }],
    });
  });

  it('proxies the matching branch alias without buffering or changing the request', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    const fetchUpstream = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`${UPSTREAM}/s/session?view=chronological&page=4`);
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('authorization')).toBe('Bearer preview-secret');
      expect(await request.text()).toBe('payload');
      return new Response(body, { status: 201, headers: { 'x-upstream': 'yes' } });
    });

    const response = await proxyPreview(
      new Request(`${PUBLIC}/s/session?view=chronological&page=4`, {
        method: 'POST',
        headers: { authorization: 'Bearer preview-secret' },
        body: 'payload',
      }),
      fetchUpstream,
    );

    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('yes');
    expect(response.body).toBe(body);
    expect(await response.text()).toBe('streamed');
  });

  it('rewrites the same-public-origin header for upstream CSRF checks', async () => {
    const fetchUpstream = vi.fn(async (request: Request) => {
      expect(request.headers.get('origin')).toBe(UPSTREAM);
      return new Response('ok');
    });
    await proxyPreview(
      new Request(`${PUBLIC}/webauthn/auth/options`, {
        method: 'POST',
        headers: { origin: PUBLIC },
      }),
      fetchUpstream,
    );
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it('does not launder a cross-origin Origin header', async () => {
    const fetchUpstream = vi.fn(async (request: Request) => {
      expect(request.headers.get('origin')).toBe('https://evil.example');
      return new Response('rejected', { status: 403 });
    });
    const response = await proxyPreview(
      new Request(`${PUBLIC}/webauthn/auth/options`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      fetchUpstream,
    );
    expect(response.status).toBe(403);
  });

  it.each([
    'https://preview.sessions.vza.net/',
    'https://nested.branch-preview.sessions.vza.net/',
    'https://-branch-preview.sessions.vza.net/',
    'https://branch--preview.sessions.vza.net/',
    `https://${'a'.repeat(43)}-preview.sessions.vza.net/`,
    'https://branch-preview.sessions.evil.example/',
  ])('fails closed without fetching for invalid host %s', async (url) => {
    const fetchUpstream = vi.fn();
    const response = await proxyPreview(new Request(url), fetchUpstream);
    expect(response.status).toBe(404);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('rewrites an absolute same-upstream redirect to the public branch host', async () => {
    const response = await proxyPreview(
      new Request(`${PUBLIC}/login`),
      async () => new Response(null, { status: 302, headers: { location: `${UPSTREAM}/s/id?page=2` } }),
    );
    expect(response.headers.get('location')).toBe(`${PUBLIC}/s/id?page=2`);
  });

  it('keeps relative and unrelated redirects unchanged', async () => {
    const relative = await proxyPreview(
      new Request(`${PUBLIC}/private`),
      async () => new Response(null, { status: 302, headers: { location: '/login' } }),
    );
    expect(relative.headers.get('location')).toBe('/login');

    const external = await proxyPreview(
      new Request(`${PUBLIC}/oauth`),
      async () => new Response(null, { status: 302, headers: { location: 'https://example.com/authorize' } }),
    );
    expect(external.headers.get('location')).toBe('https://example.com/authorize');
  });

  it('passes host-only preview cookies through without widening their scope', async () => {
    const cookie = '__Host-preview-auth=value; HttpOnly; Secure; Path=/; SameSite=Strict';
    const response = await proxyPreview(
      new Request(`${PUBLIC}/_preview/bootstrap?token=one-time`),
      async () => new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookie } }),
    );
    expect(response.headers.get('set-cookie')).toBe(cookie);
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
  });
});
