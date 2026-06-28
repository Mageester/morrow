import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiClient } from '../src/api/client';

// Exercises the internal request() wrapper via real apiClient methods. The
// regression: a 204 / empty-body success response made res.json() throw
// "Unexpected end of JSON input", which surfaced as a console error on every
// Stop/delete even though the request succeeded.

function mockFetch(response: Partial<Response> & { status: number; body?: string }) {
  const r = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => (response.body ? JSON.parse(response.body) : (() => { throw new SyntaxError('Unexpected end of JSON input'); })()),
    text: async () => response.body ?? '',
  } as unknown as Response;
  return vi.fn(async () => r);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('api client request wrapper', () => {
  it('resolves a 204 No Content response without throwing (cancel)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 204 }));
    await expect(apiClient.cancelTask('task-1')).resolves.toBeUndefined();
  });

  it('resolves an empty 200 body without throwing', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: '' }));
    await expect(apiClient.cancelTask('task-1')).resolves.toBeUndefined();
  });

  it('still parses a normal JSON body', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: JSON.stringify([{ id: 'p1' }]) }));
    await expect(apiClient.listProjects()).resolves.toEqual([{ id: 'p1' }]);
  });

  it('surfaces a structured API error message', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 400, body: JSON.stringify({ error: { message: 'bad input' } }) }));
    await expect(apiClient.listProjects()).rejects.toThrow('bad input');
  });
});
