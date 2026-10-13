import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceKey, GatewayClient } from 'ash-gateway/client/client';
import { startOwner, type Running } from '../../src/main';
import { startDevice } from '../../../device/src/main';
import { fileSigner } from '../../../device/src/link';
import { connectCodex } from '../../../device/src/setup/connect';
import { callConnectionReady, callReadSourceSetup } from '../../../device/src/setup/material-ipc';
import { captureProtectedReadSource, currentReadSource, readSourceDrained, releaseReadSource } from '../../../device/src/collaboration/read-source';
import { readLocalStateFile } from '../../../device/src/collaboration/local-state';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const nativePath = new URL('../../../device/test/fixtures/read-source-native-realm.mjs', import.meta.url).href;
const native = await import(nativePath);

async function until<T>(read: () => Promise<T> | T, label: string, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(100);
  }
  throw Error(`desktop read chain timed out: ${label}`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Actual loopback Worker + fresh owner/device/browser pairing + installed CLI.
 * Only native HOME selection points at a synthetic temporary tree. No endpoint,
 * transport, signature, history reader, or Core route is replaced.
 */
export async function desktopReadChain() {
  if (process.platform !== 'darwin') throw Error('Installed CLI attestation requires macOS');
  const wrangler = process.env.ASH_READ_CHAIN_WRANGLER;
  if (!wrangler || !resolve(wrangler).startsWith('/tmp/')) throw Error('Set ASH_READ_CHAIN_WRANGLER to a pinned temporary wrangler 4.143.0 installation');
  const version = execFileSync(wrangler, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (!version.includes('4.143.0')) throw Error('The loopback Worker fixture requires wrangler 4.143.0');
  const root = realpathSync(mkdtempSync('/tmp/ash-rrealm.'));
  let worker: ChildProcess | undefined, owner: Running | undefined;
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  let observed: Awaited<ReturnType<typeof native.nativeReader>> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of [() => device?.close(), () => observed?.close(), () => owner?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>(resolve => worker!.once('exit', () => resolve()));
      worker.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exited; }
    }
    rmSync(root, { recursive: true, force: true });
    if (failures.length) throw failures[0];
  };
  try {
    const f = await native.createNativeRealmFixture(root);
    const deniedCwd = join(root, 'not-authorized'); mkdirSync(deniedCwd, { mode: 0o700 });
    const deniedId = randomUUID();
    const deniedRollout = join(f.home, 'not-authorized.jsonl');
    writeFileSync(deniedRollout, JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: deniedId, timestamp: '2026-01-01T00:00:00.000Z', cwd: deniedCwd, originator: 'isolated-fixture', cli_version: native.FIXED_VERSION, source: 'cli', model_provider: 'openai' } }) + '\n', { mode: 0o600 });
    execFileSync('python3', ['-c', `import json,sqlite3,sys
v=json.load(sys.stdin); c=sqlite3.connect(v['db']); cols=[x[1] for x in c.execute('PRAGMA table_info(threads)')]; values=dict(zip(cols,c.execute('SELECT * FROM threads WHERE id=?',(v['original'],)).fetchone())); values.update(id=v['id'],cwd=v['cwd'],rollout_path=v['rollout'],title='unauthorized fixture'); c.execute('INSERT INTO threads ('+','.join(cols)+') VALUES ('+','.join('?' for _ in cols)+')',[values[x] for x in cols]); c.commit(); c.close()
`], { input: JSON.stringify({ db: join(f.home, 'state_5.sqlite'), original: f.markers[0], id: deniedId, cwd: deniedCwd, rollout: deniedRollout }), timeout: 5000 });
    const addTurn = (index: number) => {
      const turnId = randomUUID(), entries: object[] = [];
      const put = (type: string, payload: object) => entries.push({ timestamp: `2026-01-01T00:00:0${index + 1}.000Z`, type, payload });
      put('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: 1000, collaboration_mode_kind: 'default' });
      put('turn_context', { turn_id: turnId, cwd: f.project, approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'synthetic', effort: null, summary: 'auto' });
      put('event_msg', { type: 'user_message', message: `chain user ${index}`, images: [], local_images: [], text_elements: [] });
      put('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `chain user ${index}` }] });
      put('event_msg', { type: 'agent_message', message: `chain assistant ${index}`, phase: 'final_answer' });
      put('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `chain assistant ${index}` }], phase: 'final_answer' });
      put('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: `chain assistant ${index}` });
      appendFileSync(join(f.home, 'synthetic-rollout.jsonl'), entries.map(row => JSON.stringify(row)).join('\n') + '\n');
      return turnId;
    };
    const firstTurn = addTurn(0);
    observed = await native.nativeReader(f.executable, f.home, f.osHome, f.project);
    await observed.call('thread/list', { limit: 1, cwd: [f.project], useStateDbOnly: true });
    const secret = randomUUID(), port = await unusedPort(), base = `http://127.0.0.1:${port}`;
    const workerDir = join(root, 'worker'); mkdirSync(workerDir, { mode: 0o700 });
    writeFileSync(join(workerDir, '.dev.vars'), `BOOTSTRAP_SECRET=${secret}\n`, { mode: 0o600 });
    const config = join(workerDir, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name: 'ash-desktop-read-chain', main: join(repository, 'node_modules/ash-gateway/src/worker.ts'), compatibility_date: '2026-09-01', compatibility_flags: ['enable_request_signal'], durable_objects: { bindings: [{ name: 'HUB', class_name: 'GatewayHub' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['GatewayHub'] }] }), { mode: 0o600 });
    const workerHome = join(root, 'worker-home'); mkdirSync(workerHome, { mode: 0o700 });
    worker = spawn(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--config', config, '--persist-to', join(workerDir, 'state')], { cwd: workerDir, env: { HOME: workerHome, PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' });
    await until(async () => {
      if (worker!.exitCode !== null) throw Error(`Local Worker exited: ${worker!.exitCode}`);
      try { const health = await (await fetch(`${base}/v1/health`)).json(); return health.claimed === false && health.bootstrap_configured === true && health.owner_online === false; } catch { return false; }
    }, 'fresh loopback Worker');
    const ownerDir = join(root, 'owner'); mkdirSync(ownerDir, { mode: 0o700 });
    writeFileSync(join(ownerDir, 'bootstrap-secret'), secret, { mode: 0o600 });
    owner = await startOwner({ stateDir: ownerDir, listen: '127.0.0.1:0', gateway: { url: base }, agents: [{ id: 'agent:main', runtime: 'echo' }] });
    if (!owner.link?.connected) throw Error('Actual OwnerLink did not connect');
    const signer = await fileSigner(f.state);
    const diagnostics: object[] = [];
    const stateFacts = () => {
      const state = owner!.link!.state() as any;
      const pair = JSON.parse(readFileSync(join(f.state, 'paired.json'), 'utf8'));
      const member = state.devices?.find((entry: any) => entry.id === `device:${signer.id}`);
      return { pairing: { revoked: pair.revoked ?? false, grant_version: pair.grant_version, permissions: pair.permissions }, gatewayDevice: member ? { online: member.online, permissions: member.permissions, lends: member.lends, capabilities: member.capabilities } : null, files: Object.fromEntries(['paired.json', 'collaboration-read.json', 'collaboration-read-runtime.json'].map(name => [name, readLocalStateFile(join(f.state, name), 1024 * 1024)?.identity ?? null])) };
    };
    const grant = () => { try { const value = JSON.parse(readFileSync(join(f.state, 'collaboration-read.json'), 'utf8')); return { version: value.version, generation: value.authorization_generation, source_id: value.source_id, binding_revision: value.binding_revision }; } catch { return null; } };
    const sourceStatus = async (phase: string) => {
      try { const value = await callReadSourceSetup(f.state, signer.id, 'source.status', {}); diagnostics.push({ phase, source: { state: value.state, source_id: value.source_id, binding_revision: value.binding_revision, needsReadGrant: value.needsReadGrant }, grant: grant() }); }
      catch (error: any) { diagnostics.push({ phase, sourceCode: error.code ?? String(error), grant: grant() }); }
    };
    const dependencies: NonNullable<Parameters<typeof startDevice>[2]> = { detect: async () => [], testing: {
      sourceHome: f.home, readSource: { home: f.osHome, accountIdentity: { account_id: 'synthetic-fixture-account', subject: 'synthetic-fixture-subject' } },
      read: { source: { capture: (current: () => undefined) => {
        try { const proof = captureProtectedReadSource({ stateDir: f.state, endpointId: signer.id, current, testing: { home: f.osHome, accountIdentity: { account_id: 'synthetic-fixture-account', subject: 'synthetic-fixture-subject' } } }); diagnostics.push({ phase: 'actual-read-source-capture', source_id: proof.source_id, source_revision: proof.source_revision, grant: grant() }); return proof; }
        catch (error: any) { diagnostics.push({ phase: 'actual-read-source-capture', code: error.code, grant: grant() }); throw error; }
      }, current: proof => {
        try { return currentReadSource(proof); }
        catch (error: any) { diagnostics.push({ phase: 'actual-read-source-current-failed', code: error.code, source_id: proof.source_id, source_revision: proof.source_revision, grant: grant() }); throw error; }
      }, drained: readSourceDrained, release: releaseReadSource } },
      detectBrowser: async () => undefined,
      kimiFactory: () => ({ start: async () => {}, url: '', online: false, busy: false, call: async () => ({ ok: false, content: [] }), close: async () => {} }),
    } };
    const deviceConfig = { gateway: base, name: 'Read chain computer', stateDir: f.state, workdir: f.project };
    const ticket = (await owner.link.ticket()).ticket;
    const pendingDevice = startDevice(deviceConfig, ticket, dependencies);
    const request = await until(() => [...owner!.link!.pending.values()].find(entry => entry.name === deviceConfig.name), 'device pairing');
    await owner.link.approve(request.request_id, ['expose_capability']);
    device = await pendingDevice;
    device.run.catch(() => {});
    await until(() => callConnectionReady(f.state, signer.id, 1000), 'signed device connection');
    const connected = await connectCodex({ stateDir: f.state, endpointId: signer.id, project: f.project, computerName: deviceConfig.name, confirm: async () => true });
    if (connected.state !== 'readable') throw Error('Normal connectCodex did not verify synthetic saved history');
    const browserKey = await DeviceKey.generate(), browserGateway = new GatewayClient(base, browserKey);
    const browserPair = await browserGateway.requestPairing((await owner.link.ticket()).ticket, 'Read chain browser');
    await until(() => owner!.link!.pending.has(browserPair.request_id), 'browser pairing');
    await owner.link.approve(browserPair.request_id, ['chat', 'web_ui']);
    await browserGateway.waitForApproval(browserPair.request_id, browserPair.owner_key);
    const browserSession = await browserGateway.authenticate();
    return { base, browserToken: browserSession.token, nodeId: signer.id, nativeId: f.markers[0], deniedId, firstTurn, project: f.project, addTurn,
      nativeTurns: async () => observed!.process.request('thread/turns/list', { threadId: f.markers[0], limit: 50, sortDirection: 'desc', itemsView: 'full' }, 10_000),
      diagnostics: async () => { await sourceStatus('final-source-status'); diagnostics.push({ phase: 'final-state-facts', ...stateFacts() }); return diagnostics; },
      async disconnect() { diagnostics.push({ phase: 'before-disconnect', grant: grant(), ...stateFacts() }); await device!.close(); device = undefined; },
      async reconnect() { device = await startDevice(deviceConfig, undefined, dependencies); device.run.catch(() => {}); await until(() => callConnectionReady(f.state, signer.id, 1000), 'device recovery'); }, close };
  } catch (error) { await close(); throw error; }
}

// Playwright's ESM loader does not resolve the gateway package's extensionless
// TS imports. Run the real entries under their normal tsx Node loader instead.
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  let fixture: Awaited<ReturnType<typeof desktopReadChain>> | undefined;
  process.on('disconnect', () => { if (fixture) void fixture.close().finally(() => process.exit()); });
  process.on('message', async (message: any) => {
    try {
      let value: unknown;
      if (message.op === 'start') {
        fixture = await desktopReadChain();
        if (!process.connected) { await fixture.close(); process.exit(); }
        const { base, browserToken, nodeId, nativeId, deniedId, firstTurn, project } = fixture;
        value = { base, browserToken, nodeId, nativeId, deniedId, firstTurn, project };
      } else if (fixture && message.op === 'nativeTurns') value = await fixture.nativeTurns();
      else if (fixture && message.op === 'diagnostics') value = await fixture.diagnostics();
      else if (fixture && message.op === 'addTurn') value = fixture.addTurn(message.index);
      else if (fixture && message.op === 'disconnect') value = await fixture.disconnect();
      else if (fixture && message.op === 'reconnect') value = await fixture.reconnect();
      else if (fixture && message.op === 'close') { value = await fixture.close(); fixture = undefined; }
      else throw Error('Unknown desktop read fixture operation');
      process.send?.({ id: message.id, value });
      if (message.op === 'close') process.disconnect();
    } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
  });
}
