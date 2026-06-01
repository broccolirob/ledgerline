import { describe, it, expect } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  lcjString,
  lcj,
  parseCanonicalJson,
  canonicalRecordHash,
  leafHash,
  nodeHash,
  leafHashOfRecord,
  merkleRoot,
  merkleProof,
  verifyProof,
  toHex,
  fromHex,
  bytesEqual,
  ZERO_32,
  DOMAIN,
  tenantCommitment,
  batchId,
  schemaHash,
  revenueEventLeaf,
  ledgerEntryLeaf,
  assertClosedLeafSchema,
  SCHEMA_DESCRIPTOR,
  type LcjObject,
} from '@ledgerline/canonical';

const enc = new TextEncoder();
const concat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

describe('LCJ v1 serializer', () => {
  it('sorts object keys recursively (UTF-16 code unit), no whitespace', () => {
    expect(lcjString({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
    expect(lcjString({ z: { y: 'b', x: 'a' }, a: 'c' })).toBe('{"a":"c","z":{"x":"a","y":"b"}}');
  });

  it('emits arrays in order (not sorted)', () => {
    expect(lcjString(['b', 'a', 'c'])).toBe('["b","a","c"]');
  });

  it('booleans are the only non-string scalar', () => {
    expect(lcjString({ ok: true, no: false })).toBe('{"no":false,"ok":true}');
  });

  it('preserves strings as-is (no NFC normalization); unicode round-trips', () => {
    // é as a single NFC code point vs decomposed must NOT be normalized to the same bytes.
    const nfc = 'é'; // é
    const nfd = 'é'; // e + combining acute
    expect(lcjString({ s: nfc })).not.toBe(lcjString({ s: nfd }));
    expect(lcjString({ s: '管理' })).toBe('{"s":"管理"}');
  });

  it('rejects bare numbers (Rule 2)', () => {
    expect(() => lcjString({ n: 5 as unknown as string })).toThrow(/bare JSON numbers/);
  });

  it('rejects null (Rule 5)', () => {
    expect(() => lcjString({ n: null as unknown as string })).toThrow(/null is forbidden/);
  });

  it('rejects undefined', () => {
    expect(() => lcjString({ n: undefined as unknown as string })).toThrow(/undefined/);
  });
});

describe('parseCanonicalJson (verifier ingest path)', () => {
  it('parses sorted-or-unsorted objects to the same value', () => {
    expect(parseCanonicalJson('{"a":"1","b":"2"}')).toEqual({ a: '1', b: '2' });
  });

  it('rejects duplicate object keys (Rule 11)', () => {
    expect(() => parseCanonicalJson('{"a":"1","a":"2"}')).toThrow(/duplicate object key/);
  });

  it('rejects null (Rule 5)', () => {
    expect(() => parseCanonicalJson('{"a":null}')).toThrow(/null is forbidden/);
  });

  it('rejects bare numbers (Rule 2)', () => {
    expect(() => parseCanonicalJson('{"a":5}')).toThrow(/bare numbers are forbidden/);
  });

  it('round-trips through lcj', () => {
    const text = '{"b":"2","a":{"y":"3","x":"4"}}';
    const parsed = parseCanonicalJson(text);
    expect(lcjString(parsed)).toBe('{"a":{"x":"4","y":"3"},"b":"2"}');
  });
});

describe('hashing composition (§17.2 Rule 12) — non-circular', () => {
  const record: LcjObject = { a: '1', b: 'two' };
  const expectedLcj = '{"a":"1","b":"two"}'; // hand-verified

  it('canonical_record_hash = keccak256(keccak256(TAG) || LCJ(record))', () => {
    const tag = keccak_256(enc.encode(DOMAIN.CANONICAL_RECORD));
    const expected = keccak_256(concat(tag, enc.encode(expectedLcj)));
    expect(bytesEqual(canonicalRecordHash(record), expected)).toBe(true);
  });

  it('leaf_hash = keccak256(0x00 || canonical_record_hash)', () => {
    const crh = canonicalRecordHash(record);
    const expected = keccak_256(concat(new Uint8Array([0x00]), crh));
    expect(bytesEqual(leafHash(crh), expected)).toBe(true);
    expect(bytesEqual(leafHashOfRecord(record), expected)).toBe(true);
  });

  it('node_hash = keccak256(0x01 || left || right)', () => {
    const l = canonicalRecordHash({ a: '1' });
    const r = canonicalRecordHash({ a: '2' });
    const expected = keccak_256(concat(new Uint8Array([0x01]), l, r));
    expect(bytesEqual(nodeHash(l, r), expected)).toBe(true);
  });

  it('schema_hash changes when the descriptor changes', () => {
    const h1 = schemaHash(SCHEMA_DESCRIPTOR);
    const h2 = schemaHash({ ...SCHEMA_DESCRIPTOR, lcj_version: 'LCJ.v2' });
    expect(bytesEqual(h1, h2)).toBe(false);
  });
});

describe('hex helpers + ZERO_32', () => {
  it('toHex/fromHex round-trip', () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(b)).toBe('0x0001feff');
    expect(bytesEqual(fromHex('0x0001feff'), b)).toBe(true);
    expect(bytesEqual(fromHex('0001feff'), b)).toBe(true);
  });
  it('ZERO_32 is 32 zero bytes', () => {
    expect(ZERO_32.length).toBe(32);
    expect(ZERO_32.every((x) => x === 0)).toBe(true);
  });
  it('fromHex rejects malformed input', () => {
    expect(() => fromHex('0xabc')).toThrow();
    expect(() => fromHex('0xzz')).toThrow();
  });
});

describe('Merkle (§17.3) — RFC-9162, keccak256, 0x00/0x01, no odd-leaf dup', () => {
  const leaves = (n: number): Uint8Array[] => Array.from({ length: n }, (_, i) => leafHashOfRecord({ i: String(i) }));

  it('single-leaf root equals the leaf hash', () => {
    const L = leaves(1);
    expect(bytesEqual(merkleRoot(L), L[0]!)).toBe(true);
  });

  it('two-leaf root equals node_hash(l, r)', () => {
    const L = leaves(2);
    expect(bytesEqual(merkleRoot(L), nodeHash(L[0]!, L[1]!))).toBe(true);
  });

  it('three-leaf root follows the RFC-9162 split (k=2): node(node(0,1), 2)', () => {
    const L = leaves(3);
    const expected = nodeHash(nodeHash(L[0]!, L[1]!), L[2]!);
    expect(bytesEqual(merkleRoot(L), expected)).toBe(true);
  });

  it('empty batch is rejected', () => {
    expect(() => merkleRoot([])).toThrow(/empty batch/);
  });

  it('proof verifies for every index, 1..9 leaves', () => {
    for (let n = 1; n <= 9; n++) {
      const L = leaves(n);
      const root = merkleRoot(L);
      for (let m = 0; m < n; m++) {
        expect(verifyProof(L[m]!, merkleProof(L, m), root)).toBe(true);
      }
    }
  });

  it('a tampered leaf fails its proof', () => {
    const L = leaves(5);
    const root = merkleRoot(L);
    const proof = merkleProof(L, 2);
    const tampered = leafHashOfRecord({ i: '999' });
    expect(verifyProof(tampered, proof, root)).toBe(false);
  });

  it('a reordered proof (wrong sibling side) fails', () => {
    const L = leaves(4);
    const root = merkleRoot(L);
    const proof = merkleProof(L, 1);
    const broken = { ...proof, siblings: proof.siblings.map((s) => ({ ...s, side: s.side === 'left' ? ('right' as const) : ('left' as const) })) };
    expect(verifyProof(L[1]!, broken, root)).toBe(false);
  });

  it('leaf ordering affects the root (different order, different root)', () => {
    const L = leaves(4);
    const reordered = [L[1]!, L[0]!, L[2]!, L[3]!];
    expect(bytesEqual(merkleRoot(L), merkleRoot(reordered))).toBe(false);
  });
});

describe('derivations: tenant_commitment, batch_id', () => {
  const salt = new Uint8Array(32).fill(7);
  const tid = '00000000-0000-4000-8000-000000000001';

  it('tenant_commitment is deterministic + 32 bytes + salt-sensitive', () => {
    const tc1 = tenantCommitment(salt, tid);
    expect(tc1.length).toBe(32);
    expect(bytesEqual(tc1, tenantCommitment(salt, tid))).toBe(true);
    expect(bytesEqual(tc1, tenantCommitment(new Uint8Array(32).fill(8), tid))).toBe(false);
  });

  it('tenant_commitment requires a 32-byte salt', () => {
    expect(() => tenantCommitment(new Uint8Array(16), tid)).toThrow(/32 bytes/);
  });

  it('batch_id is deterministic + sensitive to batch_number and root', () => {
    const tc = tenantCommitment(salt, tid);
    const root = leafHashOfRecord({ a: '1' });
    const b1 = batchId(tc, 1n, root);
    expect(b1.length).toBe(32);
    expect(bytesEqual(b1, batchId(tc, 1n, root))).toBe(true);
    expect(bytesEqual(b1, batchId(tc, 2n, root))).toBe(false);
    expect(bytesEqual(b1, batchId(tc, 1n, leafHashOfRecord({ a: '2' })))).toBe(false);
  });
});

describe('closed leaf schemas', () => {
  const tcHex = toHex(new Uint8Array(32).fill(1));

  it('revenueEventLeaf builds the closed record; omits absent network', () => {
    const leaf = revenueEventLeaf({
      id: 're-1', tenantCommitmentHex: tcHex, interactionId: 'ix-1', revenueSource: 'x402_purchase',
      grossAmountAtomic: '3000', asset: 'USDC', revenueStatus: 'earned', earnedAt: new Date('2026-05-29T00:00:00.000Z'),
    });
    expect(leaf.schema_version).toBe('revenue_event_leaf.v1');
    expect(leaf.earned_at_ms).toBe(String(Date.parse('2026-05-29T00:00:00.000Z')));
    expect('network' in leaf).toBe(false);
    assertClosedLeafSchema(leaf);
  });

  it('ledgerEntryLeaf excludes memo/account_name; owner_id optional', () => {
    const leaf = ledgerEntryLeaf({
      id: 'le-1', tenantCommitmentHex: tcHex, journalTransactionId: 'jt-1', txnType: 'recognition',
      revenueTreatment: 'principal_gross', accountType: 'payable', ownerType: 'supplier', ownerId: 'c2',
      direction: 'credit', amountAtomic: '600', asset: 'USDC', effectiveAt: new Date('2026-05-29T00:00:00.000Z'),
    });
    expect(leaf.owner_id).toBe('c2');
    expect('memo' in leaf).toBe(false);
    expect('account_name' in leaf).toBe(false);
    assertClosedLeafSchema(leaf);
  });

  it('rejects a non-canonical numeric string', () => {
    expect(() =>
      revenueEventLeaf({
        id: 're-1', tenantCommitmentHex: tcHex, interactionId: 'ix-1', revenueSource: 'x402_purchase',
        grossAmountAtomic: '03000', asset: 'USDC', revenueStatus: 'earned', earnedAt: new Date(),
      }),
    ).toThrow(/numeric string/);
  });

  it('rejects a bad tenant_commitment hex', () => {
    expect(() =>
      revenueEventLeaf({
        id: 're-1', tenantCommitmentHex: '0xdeadbeef', interactionId: 'ix-1', revenueSource: 'x',
        grossAmountAtomic: '3000', asset: 'USDC', revenueStatus: 'earned', earnedAt: new Date(),
      }),
    ).toThrow(/64 lowercase hex/);
  });

  it('max-size atomic amount string (uint256-ish) survives', () => {
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const leaf = ledgerEntryLeaf({
      id: 'le-1', tenantCommitmentHex: tcHex, journalTransactionId: 'jt-1', txnType: 'recognition',
      revenueTreatment: 'principal_gross', accountType: 'revenue', ownerType: 'seller',
      direction: 'credit', amountAtomic: big, asset: 'USDC', effectiveAt: new Date('2026-05-29T00:00:00.000Z'),
    });
    expect(leaf.amount_atomic).toBe(big);
  });
});

describe('assertClosedLeafSchema (§17 Rule 10)', () => {
  const base = revenueEventLeaf({
    id: 're-1', tenantCommitmentHex: toHex(new Uint8Array(32).fill(1)), interactionId: 'ix-1',
    revenueSource: 'x402_purchase', grossAmountAtomic: '3000', asset: 'USDC', revenueStatus: 'earned',
    earnedAt: new Date('2026-05-29T00:00:00.000Z'),
  });

  it('rejects an unknown field', () => {
    expect(() => assertClosedLeafSchema({ ...base, surprise: 'x' })).toThrow(/unknown field/);
  });

  it('rejects a missing required field', () => {
    const { asset, ...missing } = base;
    expect(() => assertClosedLeafSchema(missing as LcjObject)).toThrow(/missing required field/);
  });

  it('rejects an unknown schema_version', () => {
    expect(() => assertClosedLeafSchema({ ...base, schema_version: 'bogus.v9' })).toThrow(/unknown schema_version/);
  });
});
