// Per-bucket status counts and p99 from k6 --out json, plus totals.
import { readFileSync } from 'node:fs';

const [file, bucketArg = '5', expectedArg, droppedArg = '0'] = process.argv.slice(2);
const bucket = Number(bucketArg) * 1000;
const rows = new Map();
let start;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.includes('"type":"Point"')) continue;
  const { metric, data } = JSON.parse(line);
  if (metric !== 'http_req_duration') continue;
  const t = Date.parse(data.time);
  start ??= t;
  const key = Math.floor((t - start) / bucket);
  const row = rows.get(key) ?? { status: {}, ms: [] };
  const status = data.tags.status === '0' ? 'failed' : data.tags.status;
  row.status[status] = (row.status[status] ?? 0) + 1;
  row.ms.push(data.value);
  rows.set(key, row);
}

const p99 = (ms) => ms.sort((a, b) => a - b)[Math.ceil(ms.length * 0.99) - 1];
const total = { status: {}, ms: [] };
console.log('response end  statuses                                              p99 ms');
for (const [key, row] of [...rows].sort((a, b) => a[0] - b[0])) {
  const from = (key * bucket) / 1000;
  const statuses = Object.entries(row.status).map(([s, n]) => `${s}:${n}`).join(' ');
  console.log(`${String(from).padStart(3)}-${String(from + bucket / 1000).padEnd(4)}s     ${statuses.padEnd(52)} ${p99(row.ms).toFixed(0)}`);
  for (const [s, n] of Object.entries(row.status)) total.status[s] = (total.status[s] ?? 0) + n;
  total.ms.push(...row.ms);
}
const sent = total.ms.length;
const ok = total.status['200'] ?? 0;
// Requests still hanging when k6 stops never report a duration.
// Dropped: k6 had no free VU, as every VU was waiting on a hung request.
const expected = Number(expectedArg) || sent;
const dropped = Number(droppedArg);
const pct = (n) => `${((n / expected) * 100).toFixed(1)}%`;
console.log(
  `\nscheduled ${expected}: ${ok} ok (${pct(ok)}), ${sent - ok} errors, ` +
    `${Math.max(0, expected - sent - dropped)} no response by the end, ${dropped} never sent; p99 ${p99(total.ms).toFixed(0)} ms`,
);
console.log(`statuses: ${JSON.stringify(total.status)}`);
