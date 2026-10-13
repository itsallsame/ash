import { test, expect, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceControlService } from '../../../../device/src/collaboration/control-service';
import { ControlAuthorization, controlAuthorizationSnapshot } from '../../../../device/src/collaboration/control-authorization';
import { OperationStore } from '../../../../device/src/collaboration/operation-store';
import { CodexControlAdapter } from '../../../../device/src/collaboration/codex-control';
import { CodexTransport } from '../../../../device/src/collaboration/codex-transport';
import { FixedControlTransport, executeControlRoute, CONTROL_CAPABILITIES } from '../../../src/collaboration/control-service';

const uiRoot = fileURLToPath(new URL('../../', import.meta.url));
const work = { node_id: 'one', endpoint_id: 'one', kind: 'conversation' as const, native_id: 'thread-one' };

// The only native fake is the socket peer. HTTP parsing, fixed Core transport,
// authorization, scope leases, journal, service, adapter and RPC transport are real.
async function fixture(page: Page, { active = false, holdApplyResponse = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ash-ui-control-chain-'));
  const store = new OperationStore(join(dir, 'journal.db'));
  const grant = controlAuthorizationSnapshot({ version: 1, owner_id: 'person:owner', endpoint_id: 'one', authorization_generation: 1, allowed_actions: ['send_input', 'steer'], scope: { kind: 'exact_cwd', cwd: '/project' } }, 'one');
  const authorization = new ControlAuthorization({ nodeId: 'one', endpointId: 'one', pinnedOwnerId: () => 'person:owner', authorization: () => grant, metadata: async target => ({ work: target, cwd: '/project' }) });
  const rpc: any[] = [], http: any[] = [], states: any[] = [];
  let ownerCurrent = true;
  const current = () => { if (!ownerCurrent) throw Object.assign(new Error("owner revoked"), { code: "permission_denied" }); };
  let scopes = 0, applyResult: any, releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const service = new DeviceControlService({
    node_id: 'one', endpoint_id: 'one', store, authorization, grant: () => grant,
    native: scope => {
      const scopeNumber = ++scopes;
      const transport = new CodexTransport({
        socket: '/fake.sock', executable: '/fake-codex', pid: 1, supportedVersions: ['1.2.3'],
        verifyListener: () => ({ socket: '/fake.sock', executable: '/fake-codex', pid: 1, version: '1.2.3', identity: 'fake-listener' }),
        connectSocket: async () => {
          const socket: any = new EventEmitter();
          socket.close = () => socket.emit('close');
          socket.send = (raw: string) => {
            const frame = JSON.parse(raw); if (frame.id === undefined) return;
            rpc.push({ scope: scopeNumber, ...frame }); let result;
            if (frame.method === 'initialize') result = { userAgent: 'codex 1.2.3' };
            else if (['thread/read', 'thread/resume'].includes(frame.method)) result = { thread: { id: 'thread-one', cwd: '/project', status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' } } };
            else if (frame.method === 'thread/turns/list') result = { data: [{ id: 'turn-live', status: 'inProgress' }], nextCursor: null };
            else if (frame.method === 'turn/start') result = { turn: { id: 'turn-new' } };
            else if (frame.method === 'turn/steer') result = { turnId: 'turn-live' };
            else throw new Error(`Unexpected native method ${frame.method}`);
            queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ id: frame.id, result }))));
          };
          return socket;
        },
      });
      return new CodexControlAdapter({ node_id: 'one', endpoint_id: 'one', transport, allowSubscription: scope.allowSubscription, validateHistoryMetadata: target => scope.allowHistory(target), validateMetadata: invocation => scope.authorize(invocation.principal, invocation.request.work, invocation.request.action, 'invoke') });
    },
  });
  const manifest = { protocol: 'ash-dev/1', capabilities: Object.entries(CONTROL_CAPABILITIES).map(([operation, name]) => ({ name, risk: operation === 'apply' ? 'outward' : 'none' })), collaboration_control: service.manifest() };
  const fixed = new FixedControlTransport(() => ({
    current,
    async inspect() { return { id: 'one', online: true, revoked: false, permissions: ['expose_capability'], manifest }; },
    async exchange(_id, call) {
      const operation = Object.entries(CONTROL_CAPABILITIES).find(([, capability]) => capability === call.capability)![0] as keyof typeof CONTROL_CAPABILITIES;
      const data = await service.execute(operation, call.args, { transportOwnerId: 'person:owner', isCurrent: () => ownerCurrent });
      return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, content: [], data })) };
    },
  }));
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url!.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body), operation = req.url!.split('/').pop(); http.push({ operation, input });
        const data: any = await executeControlRoute({ method: req.method!, url: new URL(req.url!, 'http://localhost'), body: Buffer.from(body) }, { authorize: async () => { current(); }, current }, fixed);
        if (operation === 'state') states.push({ action: input.action, ...data });
        if (operation === 'apply') { applyResult = data; if (holdApplyResponse) await responseGate; }
        if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, auth_scope: 'scope-one', ...data })); }
        return;
      }
      res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
      if (req.url === '/') res.end('<script type="module">import {DesktopControl} from "/js/desktop-control.js"; window.DesktopControl=DesktopControl;</script>');
      else if (['/js/desktop-control.js', '/js/desktop-work-store.js', '/js/desktop-image-composer.js', '/js/desktop-materials-contract.js', '/js/desktop-materials-store.js'].includes(req.url!)) res.end(await readFile(join(uiRoot, req.url!.slice(1))));
      else { res.statusCode = 404; res.end(); }
    } catch (error: any) {
      if (!res.destroyed) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: { code: error.code || 'offline' } })); }
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const target = { version: 1, device_id: 'device:one', endpoint_id: 'one', grant_state: 'ready', authorization_revision: grant.authorization_revision, actions: ['send_input', 'steer'], capabilities: ['state', 'apply', 'query', 'reconcile'] };
  const mount = async () => {
    await page.waitForFunction(() => (window as any).DesktopControl);
    await page.evaluate(({ target, work }) => {
      const w: any = window;
      w.net = { endpoint: location.origin, currentScope: 'scope-one', token: 'one', async collaborationControl(operation: string, input: any, signal: AbortSignal) {
        const response = await fetch(`/api/collaboration/control/${operation}`, { method: 'POST', body: JSON.stringify(input), signal });
        const data = await response.json(); if (!response.ok) throw Object.assign(new Error('HTTP'), { code: data.error.code }); return data;
      } };
      w.control = new w.DesktopControl(document, w.net, { pollMs: 100 });
      document.body.append(w.control.update([target], { device_id: 'device:one' }, work));
    }, { target, work });
  };
  try { await page.goto(url); await mount(); }
  catch (error) { ownerCurrent = false; releaseResponse?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return {
    rpc, http, states, mount, get applyResult() { return applyResult; },
    async close() {
      ownerCurrent = false;
      releaseResponse?.(); await page.evaluate(() => (window as any).control?.stop()).catch(() => {});
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const active of [false, true]) test(`actual control chain: ${active ? 'late active join steers expected turn' : 'idle scope action epoch starts exactly once'}`, async ({ page }) => {
  const f = await fixture(page, { active });
  try {
    const action = active ? 'steer' : 'send_input', button = page.getByRole('button', { name: '发送', exact: true });
    await expect(button).toBeEnabled();
    expect(f.rpc.filter(frame => ['turn/start', 'turn/steer'].includes(frame.method))).toHaveLength(0);
    await page.getByRole('textbox').fill('Fake socket control chain input'); await button.click();
    await expect(page.locator('.desktop-operation')).toContainText('已发送');
    const apply = f.http.find(call => call.operation === 'apply').input;
    expect(apply.request.action).toBe(action); expect(f.http.filter(call => call.operation === 'apply')).toHaveLength(1);
    expect(apply.expected_connector_epoch).toBe(f.states.findLast(state => state.action === action).connector_epoch);
    if (active) {
      expect(apply.request.expected_turn_id).toBe('turn-live'); expect(f.states.map(state => state.action)).toEqual(['send_input', 'steer', 'send_input', 'steer']);
      expect(f.states[0].connector_epoch).not.toBe(f.states[1].connector_epoch);
      const steer = f.rpc.filter(frame => frame.method === 'turn/steer'); expect(steer).toHaveLength(1); expect(steer[0].params.expectedTurnId).toBe('turn-live');
      expect(f.rpc.filter(frame => frame.method === 'turn/start')).toHaveLength(0);
    } else {
      expect(apply.request).not.toHaveProperty('expected_turn_id'); expect(f.states.map(state => state.action)).toEqual(['send_input', 'send_input']);
      expect(f.rpc.filter(frame => frame.method === 'turn/start')).toHaveLength(1); expect(f.rpc.filter(frame => frame.method === 'turn/steer')).toHaveLength(0);
    }
  } finally { await f.close(); }
});

test('actual control chain: cancelled HTTP receipt reload queries same operation without reapply', async ({ page }) => {
  const f = await fixture(page, { holdApplyResponse: true });
  try {
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await page.getByRole('textbox').fill('Fake socket lost HTTP receipt'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.applyResult?.fact?.delivery_status).toBe('accepted');
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('ash.desktop.control-outbox.v1')!));
    expect(persisted.items).toHaveLength(1); expect(persisted.items[0].status).toBe('unknown'); expect(persisted.items[0].fact).toBeNull();
    const original = f.http.find(call => call.operation === 'apply').input.request;
    await page.evaluate(() => (window as any).control.stop()); // Aborts waiting HTTP, never native work.
    await page.reload(); await f.mount();
    await expect(page.locator('.desktop-operation')).toContainText('已发送');
    expect(f.http.filter(call => call.operation === 'apply')).toHaveLength(1);
    const queries = f.http.filter(call => call.operation === 'query'); expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) { expect(query.input.operation_id).toBe(original.operation_id); expect(query.input.action).toBe('send_input'); expect(query.input).not.toHaveProperty('request'); expect(query.input).not.toHaveProperty('input'); }
    expect(f.applyResult.fact.operation_id).toBe(original.operation_id); expect(f.applyResult.fact.request_id).toBe(original.request_id);
    expect(f.rpc.filter(frame => frame.method === 'turn/start')).toHaveLength(1); expect(f.rpc.filter(frame => frame.method === 'turn/steer')).toHaveLength(0);
  } finally { await f.close(); }
});
