// Fails when any tracked source file exceeds MAX_LINES lines.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MAX_LINES = 1000;
const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.endsWith('package-lock.json'));
const offenders = files
  .map((f) => ({ f, n: readFileSync(f, 'utf8').split('\n').length }))
  .filter(({ n }) => n > MAX_LINES);
for (const { f, n } of offenders) console.error(`${f}: ${n} lines (> ${MAX_LINES})`);
if (offenders.length) process.exit(1);
console.log(`OK: ${files.length} files <= ${MAX_LINES} lines`);
