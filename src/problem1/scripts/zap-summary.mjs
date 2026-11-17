// Prints ZAP alerts by risk and fails on any High or Medium finding.
import { readFileSync } from 'node:fs';

const RISKS = ['High', 'Medium', 'Low', 'Informational'];
let blocking = 0;

for (const file of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const alerts = report.site.flatMap((site) => site.alerts);
  console.log(`\n${file}: ${alerts.length} alert types`);
  for (const risk of RISKS) {
    for (const alert of alerts.filter((a) => a.riskdesc.startsWith(risk))) {
      console.log(`  [${risk}] ${alert.name} (${alert.count} instances)`);
      if (risk === 'High' || risk === 'Medium') blocking += 1;
    }
  }
}

if (blocking > 0) {
  console.error(`\n${blocking} High/Medium alert types need triage`);
  process.exit(1);
}
