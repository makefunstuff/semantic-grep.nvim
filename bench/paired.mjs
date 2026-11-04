#!/usr/bin/env node
// Two runs of the bench on the same questions, compared question by question: for each mode's pieces and files view,
// MRR, recall@1 and recall@5 before and after, and the difference with its 95% interval from a paired bootstrap (the
// questions drawn again with replacement, 10,000 times, from a fixed seed: the same runs give the same intervals).
// Overall and by the style of question.
//
//   node bench/paired.mjs BEFORE.json AFTER.json [--modes fused,rerank]
import {readFileSync} from 'node:fs';
import {options} from './common.mjs';

const {flags, rest: [beforeFile, afterFile]} = options(process.argv.slice(2));
if (!beforeFile || !afterFile) {
  process.stderr.write('usage: node bench/paired.mjs BEFORE.json AFTER.json [--modes fused,rerank]\n');
  process.exit(2);
}
const DRAWS = 10_000;
const before = JSON.parse(readFileSync(beforeFile, 'utf8')).perQuestion;
const after = new Map(JSON.parse(readFileSync(afterFile, 'utf8')).perQuestion.map(row => [row.id, row]));
const rows = before.filter(row => after.has(row.id));
const modes = flags.modes ? String(flags.modes).split(',') : Object.keys(rows[0]?.rank ?? {});
const metrics = {mrr: rank => (rank ? 1 / rank : 0), r1: rank => (rank && rank <= 1 ? 1 : 0), r5: rank => (rank && rank <= 5 ? 1 : 0)};

let seed = 20261104;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const fixed = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(3)}`;

console.log(`${rows.length} questions in both`);
for (const mode of modes) {
  for (const [view, key] of [['pieces', 'rank'], ['files', 'fileRank']]) {
    for (const style of [null, 'vague', 'plain', 'multi-hop']) {
      const set = rows.filter(row => !style || row.style === style);
      if (!set.length || set.some(row => row[key][mode] === undefined || after.get(row.id)[key][mode] === undefined)) continue;
      const cells = Object.entries(metrics).map(([name, of]) => {
        const was = set.map(row => of(row[key][mode]));
        const now = set.map(row => of(after.get(row.id)[key][mode]));
        const change = now.map((value, i) => value - was[i]);
        const draws = Array.from({length: DRAWS}, () => {
          let sum = 0;
          for (let i = 0; i < change.length; i++) sum += change[Math.floor(random() * change.length)];
          return sum / change.length;
        }).sort((a, b) => a - b);
        return `${name} ${mean(was).toFixed(3)} → ${mean(now).toFixed(3)} ${fixed(mean(change))} [${fixed(draws[Math.floor(DRAWS * 0.025)])}, ${fixed(draws[Math.ceil(DRAWS * 0.975) - 1])}]`;
      });
      console.log(`${mode.padEnd(7)} ${view.padEnd(6)} ${(style ?? 'all').padEnd(9)} n=${String(set.length).padEnd(4)} ${cells.join('   ')}`);
    }
  }
}
