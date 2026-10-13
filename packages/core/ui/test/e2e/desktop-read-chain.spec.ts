import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function startFixture() {
  const child = fork(fileURLToPath(new URL('../../../test/fixtures/desktop-read-chain.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.on('message', (message: any) => {
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(Error(message.error)); else call.resolve(message.value);
  });
  child.on('exit', code => { for (const call of pending.values()) call.reject(Error(`Actual read fixture exited: ${code}`)); pending.clear(); });
  const call = (op: string, args = {}) => new Promise<any>((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, op, ...args }); });
  try {
    const state = await call('start');
    return { ...state, diagnostics: () => call('diagnostics'), nativeTurns: () => call('nativeTurns'), addTurn: (index: number) => call('addTurn', { index }), disconnect: () => call('disconnect'), reconnect: () => call('reconnect'), close: async () => { try { await call('close'); } finally { child.kill(); } } };
  } catch (error) { child.kill(); throw error; }
}

test('formal Ash shell reads installed Codex history through actual Core, local Worker and paired device', async ({ page, context }) => {
  test.skip(!process.env.ASH_READ_CHAIN_WRANGLER || process.platform !== 'darwin', 'Needs pinned temporary wrangler 4.143.0 and validated installed macOS Codex');
  test.setTimeout(180_000);
  const f = await startFixture();
  const reads: any[] = [];
  const endpoints: object[] = [];
  // Observe actual responses; neither routes nor browser modules are replaced.
  context.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/collaboration/read') {
      try { reads.push(await response.json()); } catch {}
    } else if (new URL(response.url()).pathname === '/api/collaboration/endpoints') {
      try { const result = await response.json(); endpoints.push({ status: response.status(), targets: result.targets?.length ?? -1, manifests: result.targets?.map((target: any) => ({ authorization_state: target.authorization_state, authorization_generation: target.authorization_generation, authorization_revision: target.authorization_revision, actions: target.actions })) }); } catch {}
    }
  });
  try {
    await context.addCookies([{ name: 'ash_session', value: f.browserToken, url: f.base, httpOnly: true, sameSite: 'Strict' }]);
    const open = async () => {
      await page.goto(f.base);
      await expect(page.locator('#connection')).toHaveText('已连接', { timeout: 20_000 });
      await page.locator('#desktopWorkOpen').click();
      await page.getByRole('button', { name: 'Read chain computer · Codex', exact: true }).click();
      await page.locator('.desktop-work').filter({ hasText: 'synthetic fixture' }).click();
    };
    const refresh = async () => {
      await page.locator('#desktopWork .desktop-menu > summary').click();
      await page.locator('#desktopWork').getByRole('button', { name: '刷新', exact: true }).click();
    };
    await open();
    await expect(page.locator('.desktop-user .desktop-text')).toHaveText('chain user 0');
    await expect(page.locator('.desktop-assistant .desktop-text')).toHaveText('chain assistant 0');
    const original: any = await f.nativeTurns();
    const messages = original.data.flatMap((turn: any) => turn.items.filter((item: any) => ['userMessage', 'agentMessage'].includes(item.type)).map((item: any) => [turn.id, item.id]));
    expect(await page.locator('[data-message]').evaluateAll(rows => rows.map(row => JSON.parse((row as HTMLElement).dataset.message!)))).toEqual(messages);
    expect(reads.some(result => result.page?.items?.some((row: any) => row.work?.native_id === f.nativeId && row.work?.node_id === f.nodeId))).toBe(true);
    expect(reads.some(result => result.page?.items?.some((row: any) => row.work?.native_id === f.deniedId))).toBe(false);
    const listRequest = await page.evaluate(async () => {
      const response = await fetch('/api/collaboration/endpoints', { headers: { 'Ash-Screen': sessionStorage.getItem('ash.screen.token.v2')! } });
      return response.json();
    });
    const target = listRequest.targets[0];
    const denied = await page.evaluate(async ({ target, nativeId }) => {
      const response = await fetch('/api/collaboration/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Ash-Screen': sessionStorage.getItem('ash.screen.token.v2')! }, body: JSON.stringify({ version: 1, device_id: target.device_id, endpoint_id: target.endpoint_id, authorization_generation: target.authorization_generation, authorization_revision: target.authorization_revision, action: 'read_work', work: { node_id: target.node_id, endpoint_id: target.endpoint_id, kind: 'conversation', native_id: nativeId }, page: { limit: 50 } }) });
      return { status: response.status, body: await response.json() };
    }, { target, nativeId: f.deniedId });
    expect(denied.status).toBe(403); expect(denied.body.ok).toBe(false);
    const addedTurn = await f.addTurn(1);
    await refresh();
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 1', { timeout: 20_000 });
    expect(await page.locator('[data-message]').evaluateAll(rows => rows.map(row => JSON.parse((row as HTMLElement).dataset.message!)[0]))).toContain(addedTurn);
    await open();
    await expect(page.locator('.desktop-messages')).toContainText('chain user 1');
    // End the page before the native source changes. A fresh page must reopen
    // this exact synthetic conversation and discover the new stable turn.
    await page.close();
    const addedWhileClosed = await f.addTurn(2);
    page = await context.newPage();
    await open();
    await expect(page.locator('.desktop-messages')).toContainText('chain user 2');
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 2');
    expect(await page.locator('[data-message]').evaluateAll(rows => rows.map(row => JSON.parse((row as HTMLElement).dataset.message!)[0]))).toContain(addedWhileClosed);
    await f.disconnect();
    const offlineResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/collaboration/read' && response.status() === 503);
    await refresh();
    expect((await (await offlineResponse).json()).error.code).toBe('offline');
    await expect(page.locator('.desktop-status')).toHaveText('暂时无法连接电脑，显示已保存消息', { timeout: 20_000 });
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 1');
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 2');
    const recoveredResponse = page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== '/api/collaboration/read' || response.status() !== 200) return false;
      const input = response.request().postDataJSON();
      return input?.action === 'read_work' && input?.work?.native_id === f.nativeId;
    });
    // Reconnection can trigger the existing background poll before the manual
    // menu refresh. Observe that real receipt before restarting the device.
    console.log('read recovery: reconnecting');
    await f.reconnect();
    console.log('read recovery: device ready');
    await refresh();
    const recovered = await (await recoveredResponse).json();
    console.log('read recovery: received exact conversation receipt');
    expect(recovered.ok).toBe(true);
    expect(recovered.page.items.map((turn: any) => turn.turn_id)).toContain(addedWhileClosed);
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 1');
    await expect(page.locator('.desktop-messages')).toContainText('chain assistant 2');
    expect(await page.locator('[data-message]').evaluateAll(rows => rows.map(row => JSON.parse((row as HTMLElement).dataset.message!)[0]))).toContain(addedWhileClosed);
    // The simplified conversation UI omits the normal synced status. The
    // successful read receipt and stable native turn above prove recovery.
    await expect(page.locator('.desktop-status')).toHaveCount(0);
    console.log('read recovery: message and recovery assertions passed');
  } finally {
    try {
      const evidence = test.info().outputPath('actual-read-chain-evidence.json');
      await writeFile(evidence, JSON.stringify({ gateway: 'ash-gateway/0.5.0 local Worker, fresh signed owner/device/browser pairing', endpoints, nativeDiagnostics: await f.diagnostics(), readResponses: reads.map(result => ({ ok: result.ok, code: result.error?.code, items: result.page?.items?.length })), desktopStatus: await page.locator('.desktop-status').allTextContents().then(values => values.join('') || null).catch(() => null), visibleMessages: await page.locator('[data-message]').count().catch(() => 0) }, null, 2));
      await test.info().attach('actual-read-chain-evidence', { contentType: 'application/json', path: evidence });
      await page.goto('about:blank').catch(() => {});
    } finally { await f.close(); }
  }
});
