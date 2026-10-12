// 设计稿里四种状态的数据（和画布 VitalsWidget 同一组数），用来生成 examples/*.json。
const r1 = (n) => Math.round(n * 10) / 10;
const series = (seed, lo, amp, spikes) => Array.from({ length: 60 }, (_, i) => {
  let v = lo + amp * (0.5 + 0.5 * Math.sin(i * 0.9 + seed)) * (0.6 + 0.4 * Math.sin(i * 0.37 + seed * 2));
  for (const [a, b, top] of spikes) if (i >= a && i <= b) v = top * (0.85 + 0.15 * Math.sin(i * 1.7));
  return r1(v);
});
const nice = (v, floor) => r1(Math.max(floor, Math.max(...v) * 1.25));
const base = { at: '14:02', online: 2, busy: null, cost7: [2.1, 3.8, 2.6, 4.9, 1.6, 3.0, 3.42], today: { turns: 12, calls: 86, errors: 0, reconnects: 0 } };
const mk = (o) => { const s = { ...base, ...o }; s.scale = { cpu: nice(s.cpu, 15), load: nice(s.load, 20) }; return s; };
export const FIXTURES = {
  ok: mk({ level: 'ok', say: '我一切正常', cpu: series(1, 1, 3, [[18, 21, 13], [41, 43, 9]]), load: series(2, 0, 4, [[18, 22, 14], [41, 44, 10]]), mem: series(3, 182, 6, []),
    now: { cpu: 2, mem: 186, load: 8, cost: '¥3.42' }, alert: null }),
  warn: mk({ level: 'warn', say: '我刚才有点忙，已经缓过来了', cpu: series(1, 1, 3, [[30, 33, 38]]), load: series(2, 0, 4, [[30, 33, 26]]), mem: series(3, 190, 8, [[30, 40, 214]]),
    now: { cpu: 3, mem: 204, load: 8, cost: '¥3.42' }, today: { ...base.today, errors: 2 },
    alert: { tone: 'warn', short: '13:40 · 大脑很忙', long: '13:40 · 闲着时大脑很忙，3 分钟' },
    marks: { cpu: { from: 30, to: 33, tone: 'warn' }, load: { from: 30, to: 33, tone: 'warn' } }, limits: { cpu: 5 } }),
  err: mk({ level: 'err', say: '我在空转，可能很费电', at: '14:08', cpu: series(1, 1, 3, [[54, 59, 38]]), load: series(2, 0, 4, [[54, 59, 44]]), mem: series(3, 300, 6, [[54, 59, 342]]),
    now: { cpu: 38, mem: 342, load: 44, cost: '¥3.42' },
    alert: { tone: 'err', short: '14:02 起 · 6 分钟', long: '14:02 起 · 闲着时消息不停来回，已经 6 分钟' },
    marks: { cpu: { from: 54, tone: 'err' }, load: { from: 54, tone: 'err' }, mem: { from: 54, tone: 'warn' } }, limits: { cpu: 5, load: 30 } }),
};
