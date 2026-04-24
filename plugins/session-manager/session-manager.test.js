import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';

// Mock auth middleware so route handlers can be tested directly
jest.unstable_mockModule('../../lib/auth.js', () => ({
  requireAuth: () => (req, res, next) => { if (next) next(); },
}));

const { register } = await import('./index.js');

describe('session-manager plugin', () => {
  let tmpDir, events, ctx, mockApp, routes;

  function createMockApp() {
    const r = {};
    const app = {
      get: (p, ...handlers) => { r[`GET ${p}`] = handlers; },
      post: (p, ...handlers) => { r[`POST ${p}`] = handlers; },
      delete: (p, ...handlers) => { r[`DELETE ${p}`] = handlers; },
    };
    return { app, routes: r };
  }

  async function invokeRoute(methodPath, req, res) {
    const handlers = routes[methodPath];
    if (!handlers) throw new Error(`Route ${methodPath} not found`);
    for (const handler of handlers) {
      let nextCalled = false;
      const next = () => { nextCalled = true; };
      await handler(req, res, next);
      if (!nextCalled) break;
    }
  }

  function mockReq(params = {}, body = {}) {
    return { params, body, reqId: 'test-req-1' };
  }

  function mockRes() {
    const res = {
      statusCode: 200,
      jsonBody: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.jsonBody = obj; },
    };
    return res;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-session-manager-'));
    events = createPluginEvents();
    const mock = createMockApp();
    mockApp = mock.app;
    routes = mock.routes;
    ctx = {
      events,
      config: { profileDir: tmpDir },
      log: jest.fn(),
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('skips registration when no profileDir configured', async () => {
    await register(mockApp, { ...ctx, config: {} }, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no profileDir'));
  });

  test('GET /profiles returns empty list initially', async () => {
    await register(mockApp, ctx, {});
    const req = mockReq();
    const res = mockRes();
    await invokeRoute('GET /profiles', req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.profiles).toEqual([]);
  });

  test('POST /profiles creates a profile', async () => {
    await register(mockApp, ctx, {});
    const req = mockReq({}, { name: 'work' });
    const res = mockRes();
    await invokeRoute('POST /profiles', req, res);
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.name).toBe('work');
  });

  test('POST /profiles rejects duplicate names', async () => {
    await register(mockApp, ctx, {});
    const req = mockReq({}, { name: 'work' });
    const res1 = mockRes();
    await invokeRoute('POST /profiles', req, res1);
    expect(res1.statusCode).toBe(201);

    const res2 = mockRes();
    await invokeRoute('POST /profiles', req, res2);
    expect(res2.statusCode).toBe(409);
  });

  test('GET /profiles/:name returns profile details', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'personal' }), mockRes());

    const res = mockRes();
    await invokeRoute('GET /profiles/:name', mockReq({ name: 'personal' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.name).toBe('personal');
  });

  test('GET /profiles/:name returns 404 for missing profile', async () => {
    await register(mockApp, ctx, {});
    const res = mockRes();
    await invokeRoute('GET /profiles/:name', mockReq({ name: 'missing' }), res);
    expect(res.statusCode).toBe(404);
  });

  test('DELETE /profiles/:name removes a profile', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'temp' }), mockRes());

    const res = mockRes();
    await invokeRoute('DELETE /profiles/:name', mockReq({ name: 'temp' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.deleted).toBe('temp');

    // Verify it's gone
    const res2 = mockRes();
    await invokeRoute('GET /profiles/:name', mockReq({ name: 'temp' }), res2);
    expect(res2.statusCode).toBe(404);
  });

  test('POST /sessions/:userId/profile/:name attaches profile', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'work' }), mockRes());

    const res = mockRes();
    await invokeRoute('POST /sessions/:userId/profile/:name', mockReq({ userId: 'u1', name: 'work' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.profile).toBe('work');
  });

  test('POST /sessions/:userId/profile/:name returns 404 for missing profile', async () => {
    await register(mockApp, ctx, {});
    const res = mockRes();
    await invokeRoute('POST /sessions/:userId/profile/:name', mockReq({ userId: 'u1', name: 'ghost' }), res);
    expect(res.statusCode).toBe(404);
  });

  test('DELETE /sessions/:userId/profile detaches profile', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'work' }), mockRes());
    await invokeRoute('POST /sessions/:userId/profile/:name', mockReq({ userId: 'u1', name: 'work' }), mockRes());

    const res = mockRes();
    await invokeRoute('DELETE /sessions/:userId/profile', mockReq({ userId: 'u1' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.detached).toBe(true);
  });

  test('session:creating hook injects userDataDir when profile is attached', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'work' }), mockRes());
    await invokeRoute('POST /sessions/:userId/profile/:name', mockReq({ userId: 'u1', name: 'work' }), mockRes());

    const contextOptions = {};
    await events.emitAsync('session:creating', { userId: 'u1', contextOptions });
    expect(contextOptions.userDataDir).toBe(path.join(tmpDir, 'named', 'work'));
  });

  test('session:creating hook does nothing when no profile is attached', async () => {
    await register(mockApp, ctx, {});
    const contextOptions = {};
    await events.emitAsync('session:creating', { userId: 'u2', contextOptions });
    expect(contextOptions.userDataDir).toBeUndefined();
  });

  test('session:destroyed hook clears profile mapping', async () => {
    await register(mockApp, ctx, {});
    await invokeRoute('POST /profiles', mockReq({}, { name: 'work' }), mockRes());
    await invokeRoute('POST /sessions/:userId/profile/:name', mockReq({ userId: 'u1', name: 'work' }), mockRes());

    // Verify mapping exists
    const contextOptions = {};
    await events.emitAsync('session:creating', { userId: 'u1', contextOptions });
    expect(contextOptions.userDataDir).toBeDefined();

    // Destroy session
    await events.emitAsync('session:destroyed', { userId: 'u1', reason: 'test' });

    // Mapping should be cleared
    const contextOptions2 = {};
    await events.emitAsync('session:creating', { userId: 'u1', contextOptions2 });
    expect(contextOptions2.userDataDir).toBeUndefined();
  });

  test('sanitizeName strips invalid characters', async () => {
    await register(mockApp, ctx, {});
    const req = mockReq({}, { name: 'test@profile!123' });
    const res = mockRes();
    await invokeRoute('POST /profiles', req, res);
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.name).toBe('testprofile123');
  });
});
