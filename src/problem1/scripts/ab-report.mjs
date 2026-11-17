// Compares two k6 summary exports as a Markdown table.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [fileA, fileB] = process.argv.slice(2);
const load = (file) => JSON.parse(readFileSync(file, 'utf8')).metrics;
const [a, b] = [load(fileA), load(fileB)];

const rows = [
  ['p50 all load (ms)', 'http_req_duration{phase:load}', 'p(50)'],
  ['p95 all load (ms)', 'http_req_duration{phase:load}', 'p(95)'],
  ['p99 all load (ms)', 'http_req_duration{phase:load}', 'p(99)'],
  ['p99 place order (ms)', 'http_req_duration{scenario:place}', 'p(99)'],
  ['p99 balances (ms)', 'http_req_duration{scenario:balances}', 'p(99)'],
  ['p99 depth (ms)', 'http_req_duration{scenario:depth}', 'p(99)'],
  ['max all load (ms)', 'http_req_duration{phase:load}', 'max'],
  ['error rate', 'http_req_failed{phase:load}', 'value'],
  ['dropped iterations', 'dropped_iterations', 'count'],
];

const value = (metrics, name, stat) => metrics[name]?.[stat] ?? 0;
const format = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const delta = (x, y) => (x === 0 ? 'n/a' : `${(((y - x) / x) * 100).toFixed(1)}%`);

console.log(`| metric | A ${basename(fileA, '.json')} | B ${basename(fileB, '.json')} | change |`);
console.log('|---|---:|---:|---:|');
for (const [label, name, stat] of rows) {
  const [x, y] = [value(a, name, stat), value(b, name, stat)];
  console.log(`| ${label} | ${format(x)} | ${format(y)} | ${delta(x, y)} |`);
}
