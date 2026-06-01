import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lcjString, canonicalRecordHash, leafHashOfRecord, merkleRoot, merkleProof, toHex, type LcjObject } from '@ledgerline/canonical';

// §17.5 cross-language / regression vectors. These golden values are FROZEN: a diff here means the
// canonical byte form changed, which would invalidate every previously committed Arc root. Only
// regenerate with an intentional, version-bumped format change.
const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '..', 'vectors', 'lcj-vectors.json'), 'utf8')) as {
  records: Record<string, { input: LcjObject; lcj: string; canonical_record_hash: string; leaf_hash: string }>;
  merkle: { three_leaf_root: string; three_leaf_proof_index1_siblings: { hash: string; side: 'left' | 'right' }[] };
  chain: { first_previous_root: string; batch1_id: string };
};

describe('§17.5 frozen canonicalization vectors', () => {
  for (const [name, v] of Object.entries(vectors.records)) {
    it(`reproduces lcj + hashes for "${name}"`, () => {
      expect(lcjString(v.input)).toBe(v.lcj);
      expect(toHex(canonicalRecordHash(v.input))).toBe(v.canonical_record_hash);
      expect(toHex(leafHashOfRecord(v.input))).toBe(v.leaf_hash);
    });
  }

  it('reproduces the three-leaf Merkle root + index-1 proof', () => {
    const leaves = [
      vectors.records.simple_revenue_event!,
      vectors.records.principal_gross_revenue_leg!,
      vectors.records.agent_net_payable_leg!,
    ].map((r) => leafHashOfRecord(r.input));
    expect(toHex(merkleRoot(leaves))).toBe(vectors.merkle.three_leaf_root);
    const proof = merkleProof(leaves, 1).siblings.map((s) => ({ hash: toHex(s.hash), side: s.side }));
    expect(proof).toEqual(vectors.merkle.three_leaf_proof_index1_siblings);
  });

  it('first-batch previous_root is the all-zero hash', () => {
    expect(vectors.chain.first_previous_root).toBe('0x' + '00'.repeat(32));
  });
});
