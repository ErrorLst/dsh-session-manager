// @dsh-external/dsh-session-manager — host-half regression tests (node:test, zero dependencies).
//
// 覆盖会话工件定位与删除：当前会话格式代是 v3（session.v3.jsonl.zstd，
// 官方 SESSION_FORMAT_VERSION = 3；0.1.3 曾为 v2），旧会话可能仍是 v0
// （session.jsonl.zstd）。固定文件名列表会让删除变成空操作、快照判成工件缺失
// ——这里用真实临时目录验证「定位 → 删除 → 目录清理」对 v3 / v2 / v0 各代都成立。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { name, inject, apply } from '../lib/index.mjs';

/** Minimal host context: captures the registered routes and serves fake services. */
function makeCtx({ root, headers }) {
  const routes = [];
  const logs = [];
  const persistence = {
    list: async () => headers.map((header) => ({ header, revision: 'r1', sizeBytes: 10 })),
    // 官方后端 locate 返回「当前代」路径（可能尚未物化）。
    locate: (header) => ({ kind: 'jsonl', path: join(root, '--C-x--', header.id, 'session.v2.jsonl.zstd') }),
    open: async () => { throw new Error('not used'); },
    stat: async () => undefined,
  };
  const domain = {
    global: { get: () => ({}), set: async () => {} },
    table: () => ({ get: () => undefined, put: async () => {} }),
    close: async () => {},
  };
  return {
    ctx: {
      webServer: { register: (desc) => { routes.push(desc); return () => {}; } },
      sessions: { get: () => undefined, list: () => [] },
      sessionPersistence: persistence,
      agents: { get: () => undefined },
      storageDomain: { open: async () => domain },
      loader: undefined,
      logger: { info: (message) => logs.push(String(message)), warn: () => {}, error: () => {} },
      effect: (fn) => fn(),
      emit: () => {},
      get: () => undefined,
    },
    routes,
    logs,
  };
}

/** Invoke one registered route with a fake node request/response pair. */
async function invoke(route, { method = 'GET', url = '/', body } = {}) {
  const req = {
    method,
    url,
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status) { captured.status = status; return res; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); },
  };
  await route.handler(req, res);
  return { status: captured.status, body: JSON.parse(captured.body || '{}') };
}

function writeArtifact(root, id, filename) {
  const dir = join(root, '--C-x--', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), 'header\n');
  return dir;
}

test('plugin surface declares the expected identity', () => {
  assert.equal(name, 'dsh-session-manager');
  assert.deepEqual(inject, ['webServer', 'sessions', 'sessionPersistence', 'agents', 'storageDomain']);
});

test('delete removes the current v2 artifact and the session directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-v2-'));
  process.env.DSH_HOME = join(root, 'home');
  const dir = writeArtifact(join(root, 'home', 'sessions'), 'sess-v2', 'session.v2.jsonl.zstd');
  const { ctx, routes } = makeCtx({ root: join(root, 'home', 'sessions'), headers: [{ id: 'sess-v2', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'POST', body: { action: 'delete', id: 'sess-v2' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(existsSync(join(dir, 'session.v2.jsonl.zstd')), false, 'v2 artifact must be deleted');
  assert.equal(existsSync(dir), false, 'empty session directory must be removed');
});

test('delete removes a legacy v0 artifact when locate points at an unmaterialized v2 path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-v0-'));
  process.env.DSH_HOME = join(root, 'home');
  const dir = writeArtifact(join(root, 'home', 'sessions'), 'sess-v0', 'session.jsonl.zstd');
  const { ctx, routes } = makeCtx({ root: join(root, 'home', 'sessions'), headers: [{ id: 'sess-v0', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'POST', body: { action: 'delete', id: 'sess-v0' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(existsSync(dir), false, 'legacy session directory must be removed');
});

test('delete removes every generation artifact of a migrated session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-mixed-'));
  process.env.DSH_HOME = join(root, 'home');
  const sessionsRoot = join(root, 'home', 'sessions');
  const dir = writeArtifact(sessionsRoot, 'sess-mixed', 'session.jsonl.zstd');
  writeFileSync(join(dir, 'session.v2.jsonl.zstd'), 'header\n');
  writeFileSync(join(dir, 'unrelated.txt'), 'keep me');
  const { ctx, routes } = makeCtx({ root: sessionsRoot, headers: [{ id: 'sess-mixed', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'POST', body: { action: 'delete', id: 'sess-mixed' } });
  assert.equal(res.body.ok, true);
  assert.deepEqual(readdirSync(dir), ['unrelated.txt'], 'only official generation artifacts are removed');
});

test('delete keeps the session directory when only session.lock remains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-lock-'));
  process.env.DSH_HOME = join(root, 'home');
  const dir = writeArtifact(join(root, 'home', 'sessions'), 'sess-lock', 'session.v3.jsonl.zstd');
  writeFileSync(join(dir, 'session.lock'), '');
  const { ctx, routes, logs } = makeCtx({ root: join(root, 'home', 'sessions'), headers: [{ id: 'sess-lock', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'POST', body: { action: 'delete', id: 'sess-lock' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, 'sess-lock');
  assert.deepEqual(res.body, { ok: true, id: 'sess-lock' }, 'internal dirKept must not leak into the response');
  assert.equal(existsSync(join(dir, 'session.v3.jsonl.zstd')), false, 'generation artifact must be deleted');
  assert.equal(existsSync(join(dir, 'session.lock')), true, 'session.lock must never be deleted');
  assert.equal(existsSync(dir), true, 'directory must be kept while only session.lock remains');
  assert.deepEqual(readdirSync(dir), ['session.lock']);
  assert.ok(
    logs.some((line) => line.includes('sess-lock') && line.includes('session.lock')),
    'keeping the directory for session.lock must be logged',
  );
});

test('sizeBytes excludes session.lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-size-'));
  process.env.DSH_HOME = join(root, 'home');
  const sessionsRoot = join(root, 'home', 'sessions');
  const dir = writeArtifact(sessionsRoot, 'sess-size', 'session.v3.jsonl.zstd');
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(16));
  writeFileSync(join(dir, 'session.lock'), Buffer.alloc(4096));
  const { ctx, routes } = makeCtx({ root: sessionsRoot, headers: [{ id: 'sess-size', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'GET' });
  assert.equal(res.status, 200);
  const row = res.body.sessions.find((session) => session.id === 'sess-size');
  assert.ok(row, 'the session must be listed');
  assert.equal(row.sizeBytes, 16, 'session.lock must not count toward the log size threshold');
});

test('delete reports no-location when the session has no artifact on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-none-'));
  process.env.DSH_HOME = join(root, 'home');
  const { ctx, routes } = makeCtx({ root: join(root, 'home', 'sessions'), headers: [{ id: 'sess-none', createdAt: 1, cwd: 'C:\\x', isSeeded: false }] });
  apply(ctx);
  const route = routes.find((r) => r.path === '/api/dsh-session-manager');
  const res = await invoke(route, { method: 'POST', body: { action: 'delete', id: 'sess-none' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no-location');
});
