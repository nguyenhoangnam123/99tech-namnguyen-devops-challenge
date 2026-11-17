// Regenerates every artefact derived from contracts/. CI fails on drift.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const run = (cmd, args, cwd = '.') => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const out = 'packages/contracts/src/gen';

run('npx', ['buf', 'lint'], 'contracts');
run('npx', ['buf', 'generate'], 'contracts');

mkdirSync(`${out}/openapi`, { recursive: true });
for (const api of ['oms', 'marketdata']) {
  run('npx', [
    'openapi-typescript',
    `contracts/openapi/${api}.yaml`,
    '-o',
    `${out}/openapi/${api}.ts`,
  ]);
}

if (!process.argv.includes('--skip-db')) run('bash', ['scripts/gen-db.sh']);
