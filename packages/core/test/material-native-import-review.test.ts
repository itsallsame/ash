import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {productionFixture} from './fixtures/material-production';
import {MaterialNativeImport, captureMaterialNativeScreen} from '../src/collaboration/material-native-import';
import {EdgeRouter} from '../src/server';
import {WorldRouter} from '../src/world/router';
import {WorldMembers} from '../src/world/member';
import {MaterialRegistry} from '../src/collaboration/material-registry';

test('concurrent native begin reserves one import identity and never leaves an unowned source file', async () => {
  const f = await productionFixture();
  const world = new WorldRouter(f.ledger, async () => false);
  const edge = new EdgeRouter(f.ledger, world, new WorldMembers(world),
    {api:{native:'person:owner'}, mcp:{}}, {authScopeKey:Buffer.alloc(32, 19), nativeUiToken:'isolated-native-proof'});
  const headers = {authorization:'Bearer native', 'x-ash-native-ui':'isolated-native-proof'};
  const screen = edge.screens.register(edge.localCaller(headers)!, 'review-native-picker');
  const registry = await MaterialRegistry.open({...f.options, edge});
  const permit = registry.management(headers, screen.token);
  const root = join(f.root, 'native-import');
  const importer = new MaterialNativeImport(registry, root);
  const native = captureMaterialNativeScreen(edge, headers, screen.token);
  try {
    const input = {import_id:'concurrent-selection', name:'selected.txt', media_type:'text/plain',
      reported_length:0, page_epoch:1};
    const results = await Promise.allSettled([
      importer.begin(input, native, permit),
      importer.begin(input, native, permit),
    ]);
    assert.ok(results.some(result => result.status === 'fulfilled'));
    assert.equal(readdirSync(root).length, 1, 'same import ID must have one physical source');
    await importer.close();
    assert.deepEqual(readdirSync(root), [], 'close must own and remove every created source');
  } finally {await importer.close(); registry.close(); await f.close();}
});
