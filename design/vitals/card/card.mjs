// 「她的状态」桌面小组件的 A2UI 卡片（app.json cards → tool vitals.card 返回它）。
// 一张卡三个尺寸：2×2 = 150×150、4×2 = 330×150、4×4 = 330×330（a2ui.sizes，手机按小组件大小挑能放下的最大那个）。
// 颜色全部是 tokens.json 的 {light, dark} 对，手机跟系统暗色走；不依赖手机上 "red"/"teal" 这些主题色名映射到哪。
// 图用新部件 Chart（见 ../HANDOFF.md §8）。过期（60 分钟没更新）由外框统一处理，卡片本身不画过期态。
import { bucket } from '../chart/chart.mjs';
import tokens from '../../app/tokens.json' with { type: 'json' };
import copy from '../copy.json' with { type: 'json' };

const TOKENS = tokens.color;
const W = copy.widget;
const hex = (v) => {
  if (v.startsWith('#')) return v.toUpperCase();
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(v);
  const h2 = (n) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${h2(+m[1])}${h2(+m[2])}${h2(+m[3])}${h2(+m[4] * 255)}`;
};
/** 令牌名 → 卡片颜色 {light, dark}。 */
export const tok = (name) => { const t = TOKENS[name]; if (!t) throw new Error('no token ' + name); return { light: hex(t.light), dark: hex(t.dark) }; };

const LEVEL = {
  ok: { name: copy.levels.ok.name, fill: 'ok-fill', soft: 'ok-soft', text: 'ok' },
  warn: { name: copy.levels.warn.name, fill: 'warn-fill', soft: 'warn-soft', text: 'warn' },
  err: { name: copy.levels.err.name, fill: 'err-fill', soft: 'err-soft', text: 'err' },
  new: { name: copy.levels.new.name, fill: 'her-fill', soft: 'her-soft', text: 'her' },
  paused: { name: copy.levels.paused.name, fill: 'text-3', soft: 'surface-2', text: 'text-3' },
};
// 24 格里的圆（只用 M/C/Z，手机的路径解析器都认）
const CIRCLE = 'M12 2C17.523 2 22 6.477 22 12C22 17.523 17.523 22 12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2Z';

/**
 * 纵轴不乱跳：新的上限比旧的大就立刻用新的；比旧的一半还小、并且持续 30 分钟，才缩回来；否则沿用旧的。
 * state 由应用自己存（每个图一份）：{max, lowSince}。返回 [max, newState]。
 */
export function stableMax(state, next, now) {
  if (!state || next > state.max) return [next, { max: next, lowSince: null }];
  if (next < state.max * 0.5) {
    const lowSince = state.lowSince ?? now;
    if (now - lowSince >= 30 * 60_000) return [next, { max: next, lowSince: null }];
    return [state.max, { max: state.max, lowSince }];
  }
  return [state.max, { max: state.max, lowSince: null }];
}

/**
 * s = {
 *   level: 'ok'|'warn'|'err'|'new'|'paused', say, at: '14:02', online, busy: null | '在忙什么',
 *   cpu, mem, load: 最近 60 分钟每分钟一个值（health recent kind:minute 的 cpu_pct / rss_mb / msg），旧 → 新
 *   cost7: 近 7 天每天的钱（元），旧 → 新；now: {cpu, mem, load, cost: '¥3.42'}
 *   scale: {cpu, load} 纵轴上限（stableMax 算好的；内存固定从 0 到 max(400, 最大值×1.25)）
 *   today: {turns, calls, errors, reconnects}
 *   alert: null | {tone: 'warn'|'err', long}（只有 4×4 画告警那一行；2×2、4×2 没有）
 *   marks: {cpu?, load?, mem?: {from, to?, tone}}  越界（to 省略 = 到现在）或一小时内已过去（有 to）的那段
 *   limits: {cpu?, load?}  只在出事时给：正常上限虚线
 * }
 */
export function vitalsCard(s) {
  const L = LEVEL[s.level];
  const C = [];
  const add = (c) => { C.push(c); return c.id; };
  const txt = (id, text, size, color, extra = {}) => add({ id, component: 'Text', text, style: { fontSize: size, color: tok(color), maxLines: 1, ellipsize: 'end', ...extra } });
  const lamp = (p) => add({ id: `${p}lamp`, component: 'Stack', children: [
    add({ id: `${p}halo`, component: 'Icon', name: { svgPath: CIRCLE }, style: { width: 16, height: 16, color: tok(L.soft) } }),
    add({ id: `${p}core`, component: 'Icon', name: { svgPath: CIRCLE }, style: { width: 10, height: 10, color: tok(L.fill), place: 'center' } }),
  ], style: { width: 16, height: 16 }, accessibility: { label: L.name } });
  const tone = (m) => (m ? tok(m.tone === 'warn' ? 'warn-fill' : 'err-fill') : undefined);
  const hi = (m) => (m ? { highlight: { from: m.from, ...(m.to !== undefined ? { to: m.to } : {}), color: tone(m) } } : {});
  const colorsFor = (m, k = 1) => { if (!m) return {}; const o = {}; for (let i = m.from; i <= (m.to ?? 59); i++) o[String(Math.floor(i / k))] = tone(m); return { colors: o }; };
  const memMax = Math.max(400, Math.max(...s.mem) * 1.25);
  const valTone = (k) => (s.marks?.[k] && s.marks[k].to === undefined ? (k === 'mem' ? 'warn' : 'err') : 'ink');

  // 一格：标签 / 数 + 单位 / 小图
  const cell = (p, key, label, value, unit, chart, chartH, w = 'fill') => add({ id: `${p}${key}`, component: 'Column', weight: 1, children: [
    txt(`${p}${key}k`, label, 11, 'text-3'),
    add({ id: `${p}${key}v`, component: 'Row', align: 'end', children: [
      txt(`${p}${key}n`, value, 17, valTone(key), { fontWeight: 700 }),
      ...(unit ? [txt(`${p}${key}u`, unit, 10.5, 'text-3', { margin: [0, 0, 2, 2] })] : []),
    ] }),
    add({ id: `${p}${key}c`, component: 'Chart', ...chart, style: { width: w, height: chartH, margin: [5, 0, 0, 0] } }),
  ] });
  const charts = (k) => ({
    load: { series: [{ type: 'bars', values: bucket(s.load, k), color: tok('her-fill'), max: s.scale.load, ...colorsFor(s.marks?.load, k), ...(s.limits?.load !== undefined ? { limit: s.limits.load, limitColor: tok('text-3') } : {}) }], gap: 1 },
    cpu: { series: [{ type: 'line', values: s.cpu, color: tok('her-fill'), fill: true, max: s.scale.cpu, ...hi(s.marks?.cpu), ...(s.limits?.cpu !== undefined ? { limit: s.limits.cpu, limitColor: tok('text-3') } : {}) }] },
    mem: { series: [{ type: 'line', values: s.mem, color: tok('her-fill'), fill: true, max: memMax, ...hi(s.marks?.mem) }] },
    cost: { series: [{ type: 'bars', values: s.cost7, color: tok('surface-3'), lastColor: tok('you-mark') }], gap: 3 },
  });
  const alertBox = (p, text) => add({ id: `${p}alert`, component: 'Column', style: { background: tok(s.alert.tone === 'warn' ? 'warn-soft' : 'err-soft'), cornerRadius: 14, padding: [7, 11, 7, 11] }, children: [
    txt(`${p}alertk`, W.alert_k, 11, s.alert.tone === 'warn' ? 'warn' : 'err'),
    txt(`${p}alertv`, text, 13.5, s.alert.tone === 'warn' ? 'warn' : 'err', { fontWeight: 600 }),
  ] });
  const root = (id, children, padding = [14, 14, 14, 14]) => add({ id, component: 'Column', children, action: { openApp: { app: 'vitals' } },
    style: { background: tok('surface'), padding, cornerRadius: 22 } });
  const head = (p, size) => add({ id: `${p}hd`, component: 'Row', align: 'center', children: [
    lamp(p), txt(`${p}say`, s.say, size, 'ink', { fontWeight: 650, margin: [0, 0, 0, 7] }), add({ id: `${p}gap`, component: 'Spacer', weight: 1 }),
    txt(`${p}at`, s.at, 11.5, 'text-3', { margin: [0, 0, 0, 8] }),
  ] });

  // ---- 2×2：灯 + 叫法 + 时间 / CPU / 今天花
  const p2 = 's2.';
  const row2 = (key, label, value, unit, chart) => add({ id: `${p2}${key}`, component: 'Column', children: [
    add({ id: `${p2}${key}r`, component: 'Row', align: 'end', children: [
      txt(`${p2}${key}k`, label, 11, 'text-3'), add({ id: `${p2}${key}g`, component: 'Spacer', weight: 1 }),
      txt(`${p2}${key}n`, value, 15, key === 'cpu' ? valTone('cpu') : 'ink', { fontWeight: 700 }),
      ...(unit ? [txt(`${p2}${key}u`, unit, 10.5, 'text-3', { margin: [0, 0, 2, 2] })] : []),
    ] }),
    add({ id: `${p2}${key}c`, component: 'Chart', ...chart, style: { width: 'fill', height: 26, margin: [3, 0, 0, 0] } }),
  ] });
  const l22 = root('l22', [
    add({ id: `${p2}hd`, component: 'Row', align: 'center', children: [
      lamp(p2), txt(`${p2}lv`, L.name, 12, L.text, { fontWeight: 650, margin: [0, 0, 0, 6] }), add({ id: `${p2}gap`, component: 'Spacer', weight: 1 }),
      txt(`${p2}at`, s.at, 11.5, 'text-3'),
    ] }),
    add({ id: `${p2}fill`, component: 'Spacer', weight: 1 }),
    row2('cpu', W.cpu, String(s.now.cpu), W.cpu_unit, charts(1).cpu),
    add({ id: `${p2}sp2`, component: 'Spacer', size: 8 }),
    row2('cost', W.cost, s.now.cost, '', charts(1).cost),
  ], [14, 14, 9, 14]); // 2×2 has no alert line (the redlines have none): the lamp and the CPU chart carry it; the content ends 9 above the edge

  // ---- 4×2：一句话 / 四格
  const p4 = 's4.', c3 = charts(3);
  const l42 = root('l42', [
    head(p4, 14),
    add({ id: `${p4}fill`, component: 'Spacer', weight: 1 }),
    add({ id: `${p4}cells`, component: 'Row', children: [
      cell(p4, 'load', W.load, String(s.now.load), W.load_unit, c3.load, 30),
      add({ id: `${p4}g1`, component: 'Spacer', size: 10 }),
      cell(p4, 'cpu', W.cpu, String(s.now.cpu), W.cpu_unit, c3.cpu, 30),
      add({ id: `${p4}g2`, component: 'Spacer', size: 10 }),
      cell(p4, 'mem', W.mem, String(s.now.mem), W.mem_unit, c3.mem, 30),
      add({ id: `${p4}g3`, component: 'Spacer', size: 10 }),
      cell(p4, 'cost', W.cost, s.now.cost, '', c3.cost, 30),
    ] }),
  ]);

  // ---- 4×4：一句话 + 设备 / 大图（负载柱 + CPU 线）/ 内存、近 7 天 / 今天或告警
  const p8 = 's8.', c1 = charts(1);
  const big = { series: [
    { type: 'bars', values: s.load, color: tok('surface-3'), max: s.scale.load * 1.6, ...(s.marks?.load ? { colors: Object.fromEntries(Object.entries(colorsFor(s.marks.load).colors).map(([i]) => [i, tok(s.marks.load.tone === 'warn' ? 'warn-soft' : 'err-soft')])) } : {}) },
    { type: 'line', values: s.cpu, color: tok('her-fill'), width: 2, max: s.scale.cpu, ...hi(s.marks?.cpu), ...(s.limits?.cpu !== undefined ? { limit: s.limits.cpu, limitColor: tok('text-3') } : {}) },
  ], gap: 1.2 };
  const tile = (key, label, value, unit, chart) => add({ id: `${p8}${key}`, component: 'Column', weight: 1, style: { background: tok('surface-2'), cornerRadius: 14, padding: [8, 10, 9, 10] }, children: [
    txt(`${p8}${key}k`, label, 11, 'text-3'),
    add({ id: `${p8}${key}v`, component: 'Row', align: 'end', children: [
      txt(`${p8}${key}n`, value, 17, valTone(key), { fontWeight: 700 }),
      ...(unit ? [txt(`${p8}${key}u`, unit, 10.5, 'text-3', { margin: [0, 0, 2, 2] })] : []),
    ] }),
    add({ id: `${p8}${key}c`, component: 'Chart', ...chart, style: { width: 'fill', height: 30, margin: [4, 0, 0, 0] } }),
  ] });
  const todayRow = () => add({ id: `${p8}today`, component: 'Row', align: 'end', children: W.today.flatMap(([k, label], i) => [
    ...(i ? [add({ id: `${p8}tg${i}`, component: 'Spacer', weight: 1 })] : []),
    txt(`${p8}t${k}`, String(s.today[k]), 16, s.today[k] === 0 && i > 1 ? 'text-3' : 'ink', { fontWeight: 700 }),
    txt(`${p8}t${k}l`, label, 11.5, 'text-3', { margin: [0, 0, 1, 4] }),
  ]) });
  const legend = add({ id: `${p8}lg`, component: 'Row', align: 'center', style: { margin: [12, 0, 0, 0] }, children: [
    txt(`${p8}lgc`, `${W.cpu} ${s.now.cpu}${W.cpu_unit}`, 11.5, s.marks?.cpu && s.marks.cpu.to === undefined ? 'err' : 'text-2'),
    txt(`${p8}lgl`, `${W.load} ${s.now.load} ${W.load_unit}`, 11.5, s.marks?.load && s.marks.load.to === undefined ? 'err' : 'text-3', { margin: [0, 0, 0, 12] }),
    add({ id: `${p8}lgg`, component: 'Spacer', weight: 1 }), txt(`${p8}lgw`, W.legend_window, 11.5, 'text-3'),
  ] });
  const l44 = root('l44', [
    head(p8, 16),
    txt(`${p8}sub`, W.sub.replace('{n}', s.online).replace('{idle_or_busy}', s.busy ? copy.chips.busy.replace('{what}', s.busy) : copy.chips.idle), 12, 'text-3', { margin: [2, 0, 0, 23] }),
    legend,
    add({ id: `${p8}big`, component: 'Chart', ...big, style: { width: 'fill', height: s.alert ? 77 : 84, margin: [6, 0, 0, 0] } }), // with the alert line the chart gives up 7 so that all of it fits in 330
    add({ id: `${p8}tiles`, component: 'Row', style: { margin: [10, 0, 0, 0] }, children: [
      tile('mem', W.mem, String(s.now.mem), W.mem_unit, c1.mem),
      add({ id: `${p8}tgap`, component: 'Spacer', size: 8 }),
      tile('cost', W.cost_7d, s.now.cost, '', c1.cost),
    ] }),
    add({ id: `${p8}fill`, component: 'Spacer', weight: 1 }),
    s.alert ? alertBox(p8, s.alert.long) : todayRow(),
  ]);

  void l22; void l42; void l44;
  return { components: C, root: 'l42', sizes: [{ width: 150, height: 150, root: 'l22' }, { width: 330, height: 150, root: 'l42' }, { width: 330, height: 330, root: 'l44' }] };
}
