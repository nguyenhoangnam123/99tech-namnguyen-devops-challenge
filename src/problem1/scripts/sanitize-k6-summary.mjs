// k6 summary exports include setup() data, here the users' access tokens.
// Reports are committed, so keep only the metrics.
import { readFileSync, writeFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  delete summary.setup_data;
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
}
