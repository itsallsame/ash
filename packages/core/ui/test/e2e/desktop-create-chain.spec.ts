import { test, expect, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceCreateService } from '../../../../device/src/collaboration/create-service';
import { CreateAuthorization } from '../../../../device/src/collaboration/create-authorization';
import { controlAuthorizationSnapshot } from '../../../../device/src/collaboration/control-authorization';
import { CreateOperationStore } from '../../../../device/src/collaboration/create-operation-store';
import { CodexCreateAdapter } from '../../../../device/src/collaboration/codex-create';
import { CodexCreateTransport } from '../../../../device/src/collaboration/codex-create-transport';
import { FixedCreateTransport, executeCreateRoute, normalizeCreateTarget, CREATE_CAPABILITIES, CoreCreateError } from '../../../src/collaboration/create-service';

const uiRoot = fileURLToPath(new URL('../../', import.meta.url));
const work = { node_id: 'one', endpoint_id: 'one', kind: 'conversation', native_id: 'native-thread' };
const writes = ['thread/start', 'thread/name/set', 'turn/start'];
type Mode = 'success' | 'name-error' | 'lost-turn' | 'hold-create';

// Actual browser modules → HTTP → executeCreateRoute / FixedCreateTransport →
// DeviceCreateService / CreateAuthorization / SQLite CreateOperationStore →
// CodexCreateAdapter / CodexCreateTransport. The owner gateway bridge and native
// socket peer are fixtures; no fact, response receipt or service is fabricated.
async function fixture(page: Page, mode: Mode = 'success') {
  const dir = await mkdtemp(join(tmpdir(), 'ash-create-browser-chain-'));
  const journalPath = join(dir, 'create.db');
  let store = new CreateOperationStore(journalPath), ownerCurrent = true, projectsOffline = false;
  let grant = controlAuthorizationSnapshot({ version: 1, owner_id: 'person:owner', endpoint_id: 'one', authorization_generation: 1, allowed_actions: ['create_work'], scope: { kind: 'exact_cwd', cwd: '/project' } }, 'one');
  const context = { transportOwnerId: 'person:owner', isCurrent: () => ownerCurrent };
  const http: any[] = [], rpc: any[] = [], intentions: any[] = [], responses: any[] = [], capabilities: string[] = [];
  let pendingCreate: (() => void) | undefined, clientId: string | null = null;
  let historyReady = false;
  const current = () => { if (!ownerCurrent) throw new CoreCreateError('permission_denied'); };
  const makeService = () => {
    const authorization = new CreateAuthorization({ nodeId: 'one', endpointId: 'one', pinnedOwnerId: () => 'person:owner', authorization: () => grant });
    return new DeviceCreateService({ node_id: 'one', endpoint_id: 'one', store, authorization, deadlineMs: 5000, native: () => {
      const transport = new CodexCreateTransport({ socket: '/fake-create.sock', executable: '/fake/codex', pid: 123, supportedVersions: ['1.2.3'], timeoutMs: 3000,
        verifyListener: () => ({ socket: '/fake-create.sock', executable: '/fake/codex', pid: 123, version: '1.2.3', identity: 'selected-listener' }),
        connectSocket: async () => {
          const socket: any = new EventEmitter(); socket.close = () => socket.emit('close');
          socket.send = (raw: string) => {
            const call = JSON.parse(raw); rpc.push(call); if (call.id === undefined) return;
            const stage = call.method === 'thread/start' ? 'create' : call.method === 'thread/name/set' ? 'name' : call.method === 'turn/start' ? 'first_input' : null;
            if (stage) {
              const original = http.find(h => h.operation === 'apply').input.request;
              const fact = store.get('person:owner', original.operation_id)!;
              intentions.push({ stage, fact, call });
              if (stage === 'first_input') clientId = call.params.clientUserMessageId;
            }
            const reply = (result: unknown, error?: unknown) => queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ id: call.id, ...(error ? { error } : { result }) }))));
            if (call.method === 'initialize') reply({ userAgent: 'codex 1.2.3' });
            else if (call.method === 'project/list') {
              if (projectsOffline) reply(null, { code: -32000, message: 'fixture offline' });
              else reply({ data: [{ id: 'actual-project', roots: [{ path: '/project' }] }, { id: 'other-project', roots: [{ path: '/other' }] }], nextCursor: null });
            } else if (call.method === 'thread/start') {
              const done = () => reply({ thread: { id: work.native_id, cwd: '/project', projectId: 'actual-project' } });
              if (mode === 'hold-create') pendingCreate = done; else done();
            } else if (call.method === 'thread/read') reply({ thread: { id: work.native_id, cwd: '/project', projectId: 'actual-project' } });
            else if (call.method === 'thread/name/set') reply({}, mode === 'name-error' ? { code: -32000, message: 'naming outcome unavailable' } : undefined);
            else if (call.method === 'turn/start') {
              // Peer accepts input but drops only its native acknowledgement. Socket
              // close makes the lost outcome deterministic without timing sleeps.
              if (mode === 'lost-turn') queueMicrotask(() => socket.emit('close'));
              else reply({ turn: { id: 'native-turn' } });
            } else if (call.method === 'thread/turns/list') {
              const data = historyReady ? [{ id: 'native-turn', itemsView: 'full', items: [{ type: 'userMessage', id: 'native-message', clientId, content: [] }] }] : [];
              reply({ data, nextCursor: null });
            } else throw new Error(`Unexpected native method ${call.method}`);
          };
          return socket;
        },
      });
      return new CodexCreateAdapter({ node_id: 'one', endpoint_id: 'one', transport });
    } });
  };
  let service = makeService();
  const manifest = () => ({ protocol: 'ash-dev/1', capabilities: Object.entries(CREATE_CAPABILITIES).map(([operation, name]) => ({ name, risk: operation === 'apply' ? 'outward' : 'none' })), collaboration_create: service.manifest(context) });
  const fixed = new FixedCreateTransport(() => ({ current,
    async inspect(id) { return { id, name: '电脑', online: true, revoked: false, permissions: ['expose_capability'], manifest: manifest() }; },
    async exchange(_id, call) {
      capabilities.push(call.capability);
      const operation = Object.entries(CREATE_CAPABILITIES).find(([, capability]) => capability === call.capability)![0] as keyof typeof CREATE_CAPABILITIES;
      try {
        const data = await service.execute(operation, call.args, context);
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, content: [], data })) };
      } catch (error: any) { return { status: 200, body: Buffer.from(JSON.stringify({ ok: false, content: [], error: 'Create failed', data: { code: error.code || 'offline' } })) }; }
    },
  }));
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url!.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const operation = req.url!.split('/').pop()!, input = body ? JSON.parse(body) : null;
        http.push({ operation, input });
        let data: any;
        if (operation === 'endpoints') data = { create_targets: ownerCurrent ? [normalizeCreateTarget('one', '电脑', manifest())].filter(Boolean) : [] };
        else data = await executeCreateRoute({ method: req.method!, url: new URL(req.url!, 'http://localhost'), body: Buffer.from(body) }, { authorize: async () => { current(); }, current }, fixed);
        responses.push({ operation, data }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, auth_scope: 'scope-one', ...data })); return;
      }
      res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
      if (req.url === '/') res.end('<script type="module">import {DesktopCreate} from "/js/desktop-create.js"; window.DesktopCreate=DesktopCreate;</script>');
      else if (['/js/desktop-create.js', '/js/desktop-create-store.js'].includes(req.url!)) res.end(await readFile(join(uiRoot, req.url!.slice(1))));
      else { res.statusCode = 404; res.end(); }
    } catch (error: any) { if (!res.destroyed) { res.statusCode = error.code === 'permission_denied' ? 403 : 503; res.end(JSON.stringify({ ok: false, error: { code: error.code || 'offline' } })); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const mount = async () => {
    await page.goto(url); await page.waitForFunction(() => (window as any).DesktopCreate);
    await page.evaluate(() => {
      const w: any = window;
      const request = async (path: string, input?: any, signal?: AbortSignal) => {
        const response = await fetch(path, { method: input ? 'POST' : 'GET', ...(input ? { body: JSON.stringify(input) } : {}), signal });
        const result = await response.json(); if (!response.ok) throw Object.assign(new Error('HTTP'), { code: result.error.code }); return result;
      };
      w.net = { endpoint: location.origin, currentScope: 'scope-one', token: 'owner-screen', collaborationCreateEndpoints: (signal: AbortSignal) => request('/api/collaboration/create/endpoints', undefined, signal), collaborationCreate: (operation: string, input: any, signal: AbortSignal) => request(`/api/collaboration/create/${operation}`, input, signal) };
      w.create = new w.DesktopCreate(document, w.net, {onRead: (work: any) => {w.openedWork = work;}}); w.create.open();
    });

  };
  const close = async () => {
    pendingCreate?.(); await page.evaluate(() => (window as any).create?.stop()).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close(); store.close(); await rm(dir, { recursive: true, force: true });
  };
  try { await mount(); } catch (error) { await close(); throw error; }
  return { rpc, http, intentions, responses, capabilities, mount, close,
    get original() { return http.find(h => h.operation === 'apply')?.input.request; },
    saved() { const request = http.find(h => h.operation === 'apply')?.input.request; return request ? store.get('person:owner', request.operation_id) : null; },
    setProjectsOffline() { projectsOffline = true; },
    revokeAndRelease() { ownerCurrent = false; grant = { state: 'grant_required', config: null, authorization_revision: null }; pendingCreate?.(); },
    async reopenJournal() { await service.close(); store.close(); store = new CreateOperationStore(journalPath); service = makeService(); historyReady = true; },
  };
}

async function submit(page: Page) {
  await expect(page.getByLabel('项目')).toBeEnabled();


  await page.getByLabel('内容', { exact: true }).fill('Explicit browser chain first input');
  await page.getByRole('button', { name: '创建', exact: true }).click();
}

function assertIntents(f: Awaited<ReturnType<typeof fixture>>) {
  for (const { stage, fact, call } of f.intentions) {
    expect(fact[stage].status).toBe('invoking'); expect(fact[stage].attempt_id).toBeTruthy();
    expect(fact[stage].connector_epoch).toBeTruthy(); expect(fact[stage].native_interface_version).toBe('1.2.3');
    if (stage === 'first_input') expect(call.params.clientUserMessageId).toBe(fact.native_client_message_id);
  }
  expect(f.capabilities.every(cap => (Object.values(CREATE_CAPABILITIES) as string[]).includes(cap))).toBe(true);
  expect(f.rpc.every(call => ['initialize', 'initialized', 'project/list', 'thread/start', 'thread/name/set', 'turn/start', 'thread/read', 'thread/turns/list'].includes(call.method))).toBe(true);
}

test('actual create chain: explicit project selection creates and durably names/starts exactly once', async ({ page }) => {
  const f = await fixture(page);
  try {
    await expect(page.getByLabel('项目')).toBeEnabled();
    expect(f.rpc.filter(c => writes.includes(c.method))).toHaveLength(0);
    expect(await page.getByLabel('项目').locator('option').allTextContents()).toEqual(['请选择项目', 'project']);
    await submit(page); await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');
    expect(f.rpc.filter(c => writes.includes(c.method)).map(c => c.method)).toEqual(writes);
    expect(f.rpc.find(c => c.method === 'thread/start').params).toEqual({ cwd: '/project', projectId: 'actual-project', ephemeral: false });
    expect(f.rpc.find(c => c.method === 'thread/name/set').params).toEqual({ threadId: work.native_id, name: 'Explicit browser chain first input' });
    expect(f.saved()!.work).toEqual(work); expect(f.saved()!.first_input.receipt).toMatchObject({ stage: 'first_input', correlation: 'uncertain' });
    expect(f.saved()!.native_client_message_id).toBe(f.rpc.find(c => c.method === 'turn/start').params.clientUserMessageId);
    assertIntents(f);
    await page.getByRole('button', {name: '打开会话', exact: true}).click();
    expect(await page.evaluate(() => (window as any).openedWork)).toEqual(f.saved()!.work);
    await page.locator('.desktop-create-operation summary').click();
    await page.getByRole('button', { name: '查询结果', exact: true }).click();
    await expect.poll(() => f.responses.filter(r => r.operation === 'query').length).toBe(1);
    expect(f.rpc.filter(c => writes.includes(c.method))).toHaveLength(3);
    expect(await page.evaluate(() => localStorage.getItem('ash.desktop.create-outbox.v1'))).not.toContain('Explicit browser chain first input');
  } finally { await f.close(); }
});

test('actual create chain: native naming failure conservatively keeps real WorkRef and sends no first input', async ({ page }) => {
  const f = await fixture(page, 'name-error');
  try {
    await submit(page); await expect(page.locator('.desktop-create-operation')).toContainText('标题：待确认');
    await expect(page.locator('.desktop-create-operation')).toContainText('消息：尚未开始');
    await expect(page.locator('.desktop-create-operation')).toContainText(work.native_id);
    expect(f.saved()!.work).toEqual(work); expect(f.saved()!.create.status).toBe('accepted'); expect(f.saved()!.name.status).toBe('unknown');
    expect(f.rpc.filter(c => writes.includes(c.method)).map(c => c.method)).toEqual(writes.slice(0, 2)); assertIntents(f);
  } finally { await f.close(); }
});

test('actual create chain: lost native turn ack survives page and SQLite reopen; bounded stable history reconciles without replay', async ({ page }) => {
  const f = await fixture(page, 'lost-turn');
  try {
    await submit(page); await expect.poll(() => f.saved()?.first_input.status).toBe('unknown');
    await page.locator('.desktop-create-operation summary').click();
    await expect(page.getByRole('button', { name: '查询结果', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '查询结果', exact: true }).click();
    await expect(page.locator('.desktop-create-operation')).toContainText('消息：待确认');
    await expect(page.locator('.desktop-create-operation')).toContainText(work.native_id);
    expect(f.saved()!.reconciliation).toBeNull();
    expect(f.rpc.filter(c => c.method === 'thread/turns/list')).toHaveLength(0);
    const original = f.original, before = f.saved()!; expect(before.work).toEqual(work); expect(before.native_client_message_id).toBeTruthy();
    await f.reopenJournal(); expect(f.saved()!.native_client_message_id).toBe(before.native_client_message_id);
    await f.mount(); await expect(page.locator('.desktop-create-operation')).toContainText('消息：待确认');
    await page.locator('.desktop-create-operation summary').click();
    await page.getByRole('button', { name: '核查结果', exact: true }).click();
    await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');
    const after = f.saved()!; expect(after.operation_id).toBe(original.operation_id); expect(after.work).toEqual(work);
    expect(after.native_client_message_id).toBe(before.native_client_message_id);
    expect(after.first_input.receipt).toMatchObject({ correlation: 'stable_message_id', native_turn_id: 'native-turn', native_message_id: 'native-message' });
    expect(after.reconciliation).toMatchObject({ source: 'codex.saved_history', lookup_scope: 'bounded_history_pages', pages_observed: 1, history_exhausted: true, native_client_message_id: before.native_client_message_id, work });
    expect(f.http.filter(h => h.operation === 'apply')).toHaveLength(1);
    for (const h of f.http.filter(h => ['query', 'reconcile'].includes(h.operation))) { expect(h.input.operation_id).toBe(original.operation_id); expect(h.input).not.toHaveProperty('request'); }
    expect(f.rpc.filter(c => c.method === 'thread/turns/list')).toHaveLength(1);
    expect(f.rpc.find(c => c.method === 'thread/turns/list').params).toMatchObject({ threadId: work.native_id, limit: 25, itemsView: 'full' });
    expect(f.rpc.filter(c => writes.includes(c.method)).map(c => c.method)).toEqual(writes); assertIntents(f);
    await expect(page.getByRole('button', { name: /重试|重发/ })).toHaveCount(0);
  } finally { await f.close(); }
});

test('actual create chain: project enumeration offline does not prevent querying saved SQLite receipt', async ({ page }) => {
  const f = await fixture(page);
  try {
    await submit(page); await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');
    const original = f.original; f.setProjectsOffline(); await f.mount();
    await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');
    await expect(page.locator('.desktop-create')).toContainText('暂时无法确认');
    await expect(page.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
    expect(f.http.filter(h => h.operation === 'query').some(h => h.input.operation_id === original.operation_id)).toBe(true);
    expect(f.saved()!.work).toEqual(work); expect(f.rpc.filter(c => writes.includes(c.method))).toHaveLength(3);
  } finally { await f.close(); }
});

test('actual create chain: revoke while native creation waits suppresses late receipt and every later stage', async ({ page }) => {
  const f = await fixture(page, 'hold-create');
  try {
    await submit(page); await expect.poll(() => f.rpc.filter(c => c.method === 'thread/start').length).toBe(1);
    f.revokeAndRelease(); await expect(page.locator('.desktop-create')).toContainText('创建权限已失效');
    await expect(page.locator('.desktop-create-operation')).toHaveCount(0);
    expect(f.rpc.filter(c => writes.includes(c.method)).map(c => c.method)).toEqual(['thread/start']);
    expect(f.saved()!.create.status).toBe('unknown'); expect(f.saved()!.work).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('ash.desktop.create-outbox.v1'))).not.toContain(work.native_id);
    expect(f.responses.filter(r => r.operation === 'apply')).toHaveLength(0); assertIntents(f);
  } finally { await f.close(); }
});
