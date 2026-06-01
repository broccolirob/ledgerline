// CI-friendly check that the canonical impl still reproduces the frozen §17.5 vectors (no vitest /
// no DB needed). Exits non-zero on any drift. Run: pnpm --filter @ledgerline/anchor vectors:check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lcjString, canonicalRecordHash, leafHashOfRecord, merkleRoot, toHex, type LcjObject } from '@ledgerline/canonical';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(here, '..', '..', 'canonical', 'vectors', 'lcj-vectors.json');

interface Vectors {
  records: Record<string, { input: LcjObject; lcj: string; canonical_record_hash: string; leaf_hash: string }>;
  merkle: { three_leaf_root: string };
}

function main(): void {
  const v = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;
  const failures: string[] = [];
  for (const [name, rec] of Object.entries(v.records)) {
    if (lcjString(rec.input) !== rec.lcj) failures.push(`${name}: lcj drift`);
    if (toHex(canonicalRecordHash(rec.input)) !== rec.canonical_record_hash) failures.push(`${name}: canonical_record_hash drift`);
    if (toHex(leafHashOfRecord(rec.input)) !== rec.leaf_hash) failures.push(`${name}: leaf_hash drift`);
  }
  const leaves = [v.records.simple_revenue_event!, v.records.principal_gross_revenue_leg!, v.records.agent_net_payable_leg!].map((r) => leafHashOfRecord(r.input));
  if (toHex(merkleRoot(leaves)) !== v.merkle.three_leaf_root) failures.push('three_leaf_root drift');

  if (failures.length > 0) {
    console.error('[vectors:check] FAIL — canonical format drifted from frozen §17.5 vectors:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`[vectors:check] OK — ${Object.keys(v.records).length} record vectors + merkle reproduced.`);
}

main();
