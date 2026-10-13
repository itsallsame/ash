import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOwner } from '../../../dist/ash-core.mjs';
const target = id => ({device_id:`device:${id}`,node_id:id,endpoint_id:id,name:`电脑 ${id}`,version:1,adapter:'desktop/codex',authorization_generation:1,authorization_revision:'a'.repeat(64),authorization_state:'ready',source:'codex.saved_history',runtime_state:'unknown',runtime_availability:'unknown',scope_kind:'exact_cwd',control:'unsupported',actions:['list_work','read_work']});
const work = id => ({node_id:id,endpoint_id:id,kind:'conversation',native_id:'same-native-id'});
const dto = (items,next_cursor=null) => ({items,next_cursor,observed_at:'2026-10-09T01:00:00Z',source:'codex.saved_history',runtime_state:'unknown',completeness:'source_page'});
const turn = (id, index, text=`消息 ${index}`) => ({turn_id:`turn-${index}`,history_status:null,status_source:'codex.saved_history',messages:[{work:work(id),turn_id:`turn-${index}`,source_message_id:`message-${index}`,role:'assistant',text,material_refs:[{kind:'image',source_type:'image',source_part_index:0,availability:'reference_only'}]}]});
async function fixture(page) {
  const running=await startOwner({stateDir:mkdtempSync(join(tmpdir(),'ash-desktop-ui-')),listen:'127.0.0.1:0',agents:[{id:'agent:main',runtime:'echo'}]});
  const token=Object.entries(running.tokens.api).find(([,member])=>member==='person:owner')[0];
  let scope, fail=false, count=0, revision='a'.repeat(64), targets=[target('one'),target('two')], latest=Array.from({length:12},(_,i)=>turn('one',i+10,`消息 ${i+10}\n${'长消息测试。'.repeat(35)}`));
  let earlier=null; const reads=[]; let holdNext=false, release; const held=()=>new Promise(resolve=>{release=resolve});
  await page.route('**/api/collaboration/endpoints', async route=>{
    scope ||= await page.evaluate(()=>JSON.parse(localStorage.getItem('ash.desktop.saved-history.v1')).scope);
    if(fail) return route.fulfill({status:503,json:{ok:false,error:{code:'offline'}}});
    await route.fulfill({json:{ok:true,auth_scope:scope,observed_at:'2026-10-09T01:00:00Z',targets:targets.map(t=>({...t,authorization_revision:revision}))}});
  });
  await page.route('**/api/collaboration/read',async route=>{
    const input=route.request().postDataJSON(); reads.push(input); count++;
    if(holdNext && input.action==='read_work') {holdNext=false; await held();}
    expect(input).not.toHaveProperty('caller'); expect(route.request().headers()['ash-screen']).toBeTruthy();
    if(fail) return route.fulfill({status:503,json:{ok:false,error:{code:'offline'}}});
    const id=input.endpoint_id;
    const items=input.action==='list_work' ? [{work:work(id),title:`会话 ${id}`,cwd:'/用户/项目',updated_at:Date.now(),runtime_state:'unknown'}] : input.page.cursor ? earlier || [turn(id,1,'更早消息')] : id==='one' ? latest : [turn(id,1,'第二台电脑')];
    await route.fulfill({json:{ok:true,auth_scope:scope,target:{...target(id),authorization_revision:revision},page:dto(input.action==='read_work'?[...items].reverse():items,input.action==='read_work' && !input.page.cursor?'older':null)}});
  });
  await page.setViewportSize({width:412,height:915}); await page.goto(`${running.url}/?token=${token}`); await expect(page.locator('#connection')).toContainText('已连接');
  return {running,reads,get count(){return count},set fail(value){fail=value},set latest(value){latest=value},set earlier(value){earlier=value},set revision(value){revision=value},set targets(value){targets=value},hold(){holdNext=true},release(){release?.()}};
}
const refreshPage = async page => { const menu = page.locator('.desktop-menu'); if (await menu.count()) await menu.locator('summary').click(); await page.getByRole('button',{name:'刷新',exact:true}).click(); };
const openDetail = async page => { await page.locator('#desktopWorkOpen').click(); await page.getByRole('button',{name:'电脑 one · Codex',exact:true}).click(); await page.getByRole('button',{name:/会话 one/}).click(); await expect(page.locator('.desktop-messages')).toContainText('消息 10'); await expect(page.locator('.desktop-cache-policy,.desktop-capabilities')).toHaveCount(0); await expect(page.locator('.desktop-menu')).not.toHaveAttribute('open', ''); };
test('real shell browses scoped list and read-only history, materials and bounded visible refresh', async ({page})=>{
  const f=await fixture(page);
  try {
    await openDetail(page); await expect(page.locator('#desktopWork')).not.toContainText('运行状态未知 · 控制不支持'); await expect(page.locator('#desktopWork')).toContainText('未同步'); await expect(page.locator('#desktopWork input,#desktopWork textarea')).toHaveCount(0);
    const listRequest=f.reads.find(r=>r.action==='list_work'); expect(listRequest.work).toBeUndefined();
    const scroll=page.locator('.desktop-messages'); await scroll.evaluate(el=>{el.scrollTop=300}); const before=await scroll.evaluate(el=>el.scrollTop);
    f.latest=[...Array.from({length:12},(_,i)=>turn('one',i+10,`消息 ${i+10}\n${'长消息测试。'.repeat(35)}`)),turn('one',22,'新消息 <img src=x onerror=alert(1)>')];
    await refreshPage(page); await expect(page.locator('.desktop-new')).toBeVisible(); expect(await scroll.evaluate(el=>el.scrollTop)).toBe(before); await expect(page.locator('.desktop-text img')).toHaveCount(0);
    const anchor=await scroll.evaluate(el=>{const row=[...el.querySelectorAll('[data-message]')].find(r=>r.offsetTop+r.offsetHeight>=el.scrollTop);return {id:row.dataset.message,offset:row.offsetTop-el.scrollTop}});
    await page.getByRole('button',{name:'加载更早消息',exact:true}).evaluate(el=>el.click()); await expect(page.locator('.desktop-messages')).toContainText('更早消息');
    await expect.poll(()=>scroll.evaluate((el,id)=>{const row=[...el.querySelectorAll('[data-message]')].find(r=>r.dataset.message===id);return row.offsetTop-el.scrollTop},anchor.id)).toBe(anchor.offset);
    f.latest=[turn('one',30,'跨页最新消息')]; f.earlier=[turn('one',22,'已有边界消息'),turn('one',23,'缺口消息')];
    await refreshPage(page); await expect(page.getByRole('button',{name:'加载更早消息',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'加载更早消息',exact:true}).evaluate(el=>el.click()); await expect(page.locator('.desktop-messages')).toContainText('缺口消息');
    const ids=await scroll.evaluate(el=>[...el.querySelectorAll('[data-message]')].map(row=>JSON.parse(row.dataset.message)[0])); expect(ids.indexOf('turn-23')).toBeLessThan(ids.indexOf('turn-30'));
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))}); const count=f.count; await page.waitForTimeout(4500); expect(f.count).toBe(count);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))}); await expect.poll(()=>f.count).toBeGreaterThan(count);
    await page.locator('.desktop-menu > summary').click(); await page.locator('.desktop-menu').getByRole('button',{name:'关闭',exact:true}).click(); const closed=f.count; await page.waitForTimeout(4500); expect(f.count).toBe(closed);
  } finally {await f.running.close()}
});
test('cache offline, no cache, and permission revision invalidation',async({page})=>{
  const f=await fixture(page);
  try {
    await openDetail(page); f.fail=true; await refreshPage(page); await expect(page.locator('.desktop-status')).toContainText('显示已保存消息'); await expect(page.locator('.desktop-messages')).toContainText('消息 10');
    await page.getByRole('button',{name:'会话列表',exact:true}).click(); await page.getByRole('button',{name:'电脑列表',exact:true}).click(); await page.getByRole('button',{name:'电脑 two · Codex',exact:true}).click(); await expect(page.locator('.desktop-status')).toContainText('暂时无法连接电脑');
    f.fail=false; await refreshPage(page); await expect(page.getByRole('button',{name:/会话 two/})).toBeVisible();
    f.revision='b'.repeat(64); await refreshPage(page); await expect(page.locator('.desktop-status')).toContainText('读取范围已改变'); await expect(page.locator('.desktop-work')).toHaveCount(0);
    const persisted=await page.evaluate(()=>localStorage.getItem('ash.desktop.saved-history.v1')); expect(persisted).not.toContain('消息 10');
  } finally {await f.running.close()}
});

test('late response after switching computers cannot populate the new target',async({page})=>{
  const f=await fixture(page);
  try {
    await openDetail(page); f.hold(); const previous=f.count; await refreshPage(page); await expect.poll(()=>f.count).toBeGreaterThan(previous);
    await page.getByRole('button',{name:'会话列表',exact:true}).click(); await page.getByRole('button',{name:'电脑列表',exact:true}).click(); await page.getByRole('button',{name:'电脑 two · Codex',exact:true}).click(); await page.getByRole('button',{name:/会话 two/}).click(); await expect(page.locator('.desktop-messages')).toContainText('第二台电脑');
    f.release(); await page.waitForTimeout(300); await expect(page.locator('.desktop-messages')).not.toContainText('消息 10'); await expect(page.locator('.desktop-messages')).toContainText('第二台电脑');
  } finally {f.release();await f.running.close()}
});
