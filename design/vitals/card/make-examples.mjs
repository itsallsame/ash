// node design/app/vitals/card/make-examples.mjs → examples/<状态>.json（vitals.card 应该返回的 a2ui）
import { mkdirSync, writeFileSync } from 'node:fs';
import { vitalsCard } from './card.mjs';
import { FIXTURES } from './fixtures.mjs';
const dir = new URL('./examples/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [k, s] of Object.entries(FIXTURES)) writeFileSync(new URL(`${k}.json`, dir), JSON.stringify(vitalsCard(s), null, 1) + '\n');
console.log(Object.keys(FIXTURES).join(' '));
