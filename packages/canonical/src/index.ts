// @ledgerline/canonical — Milestone 4.
// LCJ v1 (RFC-8785-BASED restricted profile) + domain-tagged keccak256 + RFC-9162 Merkle.
// Pure, no DB, no viem. The independently-auditable core of the verifier (D-0005).
//
// No-overclaim: this is "LCJ v1, RFC-8785-based," NOT "full RFC 8785." LCJ forbids bare numbers /
// floats / null (§17 Rules 2/3/5), which removes RFC 8785's hard part (IEEE-754 canonicalization);
// what remains is sorted-key emission over closed schemas + Ledgerline-specific validation.
//
// Only dependency: @noble/hashes keccak_256 — the EVM keccak (NOT NIST sha3; different padding).
// Never hand-roll crypto; in-house only the serialization.

import { keccak_256 } from '@noble/hashes/sha3';

// ============================================================================
// bytes + hex
// ============================================================================

const utf8 = new TextEncoder();

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** 0x-prefixed lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Parse 0x-prefixed (or bare) lowercase/upper hex to bytes. Throws on malformed input. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`fromHex: invalid hex "${hex}"`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 32 zero bytes — the first-batch previous_merkle_root convention (§7.12, §17.6 step 12). */
export const ZERO_32: Uint8Array = new Uint8Array(32);

function uint64BE(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`uint64BE: out of range ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ============================================================================
// domain tags (§17.4) — frozen on first commit
// ============================================================================

export const DOMAIN = {
  CANONICAL_RECORD: 'LEDGERLINE_CANONICAL_RECORD_V1',
  SCHEMA_DESCRIPTOR: 'LEDGERLINE_SCHEMA_DESCRIPTOR_V1',
  METADATA_POLICY: 'LEDGERLINE_METADATA_POLICY_V1',
  DATA_AVAILABILITY_URI: 'LEDGERLINE_DATA_AVAILABILITY_URI_V1',
  BATCH_ID: 'LEDGERLINE_BATCH_ID_V1',
  TENANT_COMMITMENT: 'LEDGERLINE_TENANT_COMMITMENT_V1',
} as const;

/** keccak256 of a domain tag string (the fixed 32-byte prefix, §17.2 Rule 12). */
function domainTag(tag: string): Uint8Array {
  return keccak256(utf8.encode(tag));
}

// ============================================================================
// LCJ v1 serializer (§17.2)
// ============================================================================

/** The only value types LCJ v1 permits: string, boolean, object, array. No numbers, no null. */
export type LcjValue = string | boolean | LcjObject | LcjValue[];
export interface LcjObject {
  [k: string]: LcjValue;
}

/**
 * Serialize an LcjValue to canonical UTF-8 bytes (validate-then-emit):
 * - objects: keys sorted by UTF-16 code unit (JS default sort), no whitespace.
 * - strings: emitted via JSON.stringify (RFC-8785-compatible escaping); preserved AS-IS (no NFC).
 * - booleans: true/false.
 * - REJECTS bare numbers (JS number), null, undefined, NaN, functions, non-plain objects.
 * The numeric-STRING format (Rule 2 regex) is enforced by the leaf builders, not here — the
 * serializer cannot know which strings are numeric.
 */
export function lcjString(value: LcjValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') throw new Error('lcj: bare JSON numbers are forbidden (Rule 2) — encode as a string');
  if (value === null) throw new Error('lcj: null is forbidden (Rule 5) — omit the field instead');
  if (value === undefined) throw new Error('lcj: undefined value — omit the field instead');
  if (Array.isArray(value)) return '[' + value.map(lcjString).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as LcjObject;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + lcjString(obj[k]!)).join(',') + '}';
  }
  throw new Error(`lcj: unsupported value type ${typeof value}`);
}

export function lcj(value: LcjValue): Uint8Array {
  return utf8.encode(lcjString(value));
}

// ============================================================================
// strict canonical JSON parse (rejects null / bare number / duplicate key)
// ============================================================================

/**
 * Parse JSON text into an LcjValue, enforcing LCJ restrictions during parse: rejects `null`, bare
 * numbers, and DUPLICATE object keys (standard JSON.parse silently keeps the last). Strings/booleans
 * pass.
 *
 * SCOPE: this is a PUBLIC API for an INDEPENDENT external verifier ingesting a disclosed
 * verifier-package JSON adversarially. The in-repo verifier (`@ledgerline/anchor` `verify()`) does
 * NOT use it — it rebuilds leaves from typed DB rows via the leaf builders, so disclosed JSON is
 * never its input. Kept (and unit-tested) as the cross-language ingest contract for third parties.
 */
export function parseCanonicalJson(text: string): LcjValue {
  let i = 0;
  const err = (m: string): never => {
    throw new Error(`parseCanonicalJson: ${m} at index ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const parseValue = (): LcjValue => {
    ws();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't' || c === 'f') return parseBool();
    if (c === 'n') err('null is forbidden (Rule 5)');
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) err('bare numbers are forbidden (Rule 2)');
    return err(`unexpected character ${c ?? '<eof>'}`);
  };
  const parseString = (): string => {
    if (text[i] !== '"') err('expected string');
    let s = '';
    i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return s;
      }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === '"' || e === '\\' || e === '/') s += e;
        else if (e === 'n') s += '\n';
        else if (e === 't') s += '\t';
        else if (e === 'r') s += '\r';
        else if (e === 'b') s += '\b';
        else if (e === 'f') s += '\f';
        else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          // Validate the \u escape: exactly 4 hex digits. Without this, parseInt of non-hex returns
          // NaN and String.fromCharCode(NaN) === '\0', silently coercing a malformed escape
          // (\uZZZZ, \u00G1) to NUL — letting a tampered disclosed record slip past this defensive
          // ingest gate. Reject instead.
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) err(`invalid \\u escape "\\u${hex}"`);
          s += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        } else err(`bad escape \\${e ?? ''}`);
        i += 2;
        continue;
      }
      s += c;
      i++;
    }
    return err('unterminated string');
  };
  const parseBool = (): boolean => {
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    return err('expected boolean');
  };
  const parseObject = (): LcjObject => {
    const obj: LcjObject = {};
    const seen = new Set<string>();
    i++; // {
    ws();
    if (text[i] === '}') {
      i++;
      return obj;
    }
    for (;;) {
      ws();
      const key = parseString();
      if (seen.has(key)) err(`duplicate object key "${key}" (Rule 11)`);
      seen.add(key);
      ws();
      if (text[i] !== ':') err('expected ":"');
      i++;
      obj[key] = parseValue();
      ws();
      const d = text[i];
      if (d === ',') {
        i++;
        continue;
      }
      if (d === '}') {
        i++;
        return obj;
      }
      err('expected "," or "}"');
    }
  };
  const parseArray = (): LcjValue[] => {
    const arr: LcjValue[] = [];
    i++; // [
    ws();
    if (text[i] === ']') {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      ws();
      const d = text[i];
      if (d === ',') {
        i++;
        continue;
      }
      if (d === ']') {
        i++;
        return arr;
      }
      err('expected "," or "]"');
    }
  };
  const v = parseValue();
  ws();
  if (i !== text.length) err('trailing content');
  return v;
}

// ============================================================================
// record + descriptor hashing (§17.2 Rule 12, §17.4)
// ============================================================================

/** canonical_record_hash = keccak256( keccak256(TAG) || LCJ(record) ). */
export function canonicalRecordHash(record: LcjValue): Uint8Array {
  return keccak256(concat(domainTag(DOMAIN.CANONICAL_RECORD), lcj(record)));
}

export function schemaHash(descriptor: LcjValue): Uint8Array {
  return keccak256(concat(domainTag(DOMAIN.SCHEMA_DESCRIPTOR), lcj(descriptor)));
}

export function metadataPolicyHash(descriptor: LcjValue): Uint8Array {
  return keccak256(concat(domainTag(DOMAIN.METADATA_POLICY), lcj(descriptor)));
}

export function dataAvailabilityUriHash(uri: string): Uint8Array {
  return keccak256(concat(domainTag(DOMAIN.DATA_AVAILABILITY_URI), lcj({ uri })));
}

/** tenant_commitment = keccak256( keccak256(TAG) || tenant_salt(32) || utf8(tenant_id) ). Salted (§16). */
export function tenantCommitment(tenantSalt: Uint8Array, tenantId: string): Uint8Array {
  if (tenantSalt.length !== 32) throw new Error('tenantCommitment: tenant_salt must be 32 bytes');
  return keccak256(concat(domainTag(DOMAIN.TENANT_COMMITMENT), tenantSalt, utf8.encode(tenantId)));
}

/** batch_id = keccak256( keccak256(TAG) || tenant_commitment(32) || uint64_be(batch_number) || merkle_root(32) ). */
export function batchId(tenantCommitmentBytes: Uint8Array, batchNumber: bigint, merkleRootBytes: Uint8Array): Uint8Array {
  if (tenantCommitmentBytes.length !== 32) throw new Error('batchId: tenant_commitment must be 32 bytes');
  if (merkleRootBytes.length !== 32) throw new Error('batchId: merkle_root must be 32 bytes');
  return keccak256(concat(domainTag(DOMAIN.BATCH_ID), tenantCommitmentBytes, uint64BE(batchNumber), merkleRootBytes));
}

// ============================================================================
// Merkle (§17.3) — RFC-9162-style, keccak256, 0x00/0x01 domain-separated, no odd-leaf duplication
// ============================================================================

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** leaf_hash = keccak256( 0x00 || canonical_record_hash ). */
export function leafHash(canonicalRecordHashBytes: Uint8Array): Uint8Array {
  if (canonicalRecordHashBytes.length !== 32) throw new Error('leafHash: canonical_record_hash must be 32 bytes');
  return keccak256(concat(LEAF_PREFIX, canonicalRecordHashBytes));
}

/** node_hash = keccak256( 0x01 || left_32 || right_32 ). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== 32 || right.length !== 32) throw new Error('nodeHash: children must be 32 bytes');
  return keccak256(concat(NODE_PREFIX, left, right));
}

/** Largest power of two strictly less than n (n > 1). */
function largestPow2LessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * RFC-9162 Merkle Tree Hash over PRE-COMPUTED leaf_hashes. Empty input is invalid (§17.3).
 * MTH({h}) = h; MTH(D_n>1) = node_hash(MTH(D[0:k]), MTH(D[k:n])), k = largest pow2 < n. No odd dup.
 */
export function merkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) throw new Error('merkleRoot: empty batch is invalid (§17.3)');
  if (leafHashes.length === 1) return leafHashes[0]!;
  const k = largestPow2LessThan(leafHashes.length);
  return nodeHash(merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k)));
}

export interface MerkleProof {
  leafIndex: number;
  treeSize: number;
  /** Siblings ordered leaf→root; `side` is the side the SIBLING sits on. */
  siblings: { hash: Uint8Array; side: 'left' | 'right' }[];
}

/** RFC-9162 inclusion (audit) path for the leaf at `index` over pre-computed leaf_hashes. */
export function merkleProof(leafHashes: Uint8Array[], index: number): MerkleProof {
  if (index < 0 || index >= leafHashes.length) throw new Error('merkleProof: index out of range');
  const siblings: { hash: Uint8Array; side: 'left' | 'right' }[] = [];
  const walk = (leaves: Uint8Array[], m: number): void => {
    if (leaves.length === 1) return;
    const k = largestPow2LessThan(leaves.length);
    if (m < k) {
      walk(leaves.slice(0, k), m);
      siblings.push({ hash: merkleRoot(leaves.slice(k)), side: 'right' });
    } else {
      walk(leaves.slice(k), m - k);
      siblings.push({ hash: merkleRoot(leaves.slice(0, k)), side: 'left' });
    }
  };
  walk(leafHashes, index);
  return { leafIndex: index, treeSize: leafHashes.length, siblings };
}

/** Fold a leaf_hash up its audit path and compare to the expected root. */
export function verifyProof(leaf: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean {
  let acc = leaf;
  for (const s of proof.siblings) acc = s.side === 'left' ? nodeHash(s.hash, acc) : nodeHash(acc, s.hash);
  return bytesEqual(acc, root);
}

// ============================================================================
// closed leaf schemas (§17 Rule 10, D-0008) — the two committable record types
// ============================================================================

const NUM_RE = /^(0|[1-9][0-9]*)$/;
/** uint256 max — the upper bound for atomic token amounts (USDC `numeric(78,0)` is uint256-bounded). */
const MAX_UINT256 = 2n ** 256n - 1n;
function numStr(v: string, field: string): string {
  if (typeof v !== 'string' || !NUM_RE.test(v)) throw new Error(`leaf: ${field} must be a canonical numeric string, got "${v}"`);
  return v;
}
/** numStr + uint256 range check, for atomic token-amount fields that must be on-chain representable. */
function atomicStr(v: string, field: string): string {
  numStr(v, field);
  if (BigInt(v) > MAX_UINT256) throw new Error(`leaf: ${field} exceeds uint256 max (${v})`);
  return v;
}
function hex32(v: string, field: string): string {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) throw new Error(`leaf: ${field} must be 0x + 64 lowercase hex, got "${v}"`);
  return v;
}
function reqStr(v: string, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`leaf: ${field} required`);
  return v;
}
/** integer milliseconds since epoch, as a canonical decimal string (Rule 4). */
function msString(d: Date, field: string): string {
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new Error(`leaf: ${field} is not a valid Date`);
  return numStr(String(t), field);
}

export const REVENUE_EVENT_LEAF_SCHEMA = 'revenue_event_leaf.v1';
export const LEDGER_ENTRY_LEAF_SCHEMA = 'ledger_entry_leaf.v1';

export interface RevenueEventLeafInput {
  id: string;
  tenantCommitmentHex: string; // 0x + 64 hex
  interactionId: string;
  revenueSource: string;
  grossAmountAtomic: string; // numeric string
  asset: string;
  network?: string;
  revenueStatus: string;
  earnedAt: Date;
}

/** Build the closed canonical leaf record for a revenue_event (omits any optional absent field). */
export function revenueEventLeaf(i: RevenueEventLeafInput): LcjObject {
  const leaf: LcjObject = {
    schema_version: REVENUE_EVENT_LEAF_SCHEMA,
    id: reqStr(i.id, 'id'),
    tenant_commitment: hex32(i.tenantCommitmentHex, 'tenant_commitment'),
    interaction_id: reqStr(i.interactionId, 'interaction_id'),
    revenue_source: reqStr(i.revenueSource, 'revenue_source'),
    gross_amount_atomic: atomicStr(i.grossAmountAtomic, 'gross_amount_atomic'),
    asset: reqStr(i.asset, 'asset'),
    revenue_status: reqStr(i.revenueStatus, 'revenue_status'),
    earned_at_ms: msString(i.earnedAt, 'earned_at_ms'),
  };
  if (i.network !== undefined && i.network !== null) leaf.network = reqStr(i.network, 'network');
  return leaf;
}

export interface LedgerEntryLeafInput {
  id: string;
  tenantCommitmentHex: string;
  journalTransactionId: string;
  txnType: string;
  revenueTreatment: string;
  accountType: string;
  ownerType: string;
  ownerId?: string | null;
  direction: string;
  amountAtomic: string; // numeric string
  asset: string;
  effectiveAt: Date;
}

/** Build the closed canonical leaf record for a ledger_entry. account_name/memo are EXCLUDED (§12 never-commit). */
export function ledgerEntryLeaf(i: LedgerEntryLeafInput): LcjObject {
  const leaf: LcjObject = {
    schema_version: LEDGER_ENTRY_LEAF_SCHEMA,
    id: reqStr(i.id, 'id'),
    tenant_commitment: hex32(i.tenantCommitmentHex, 'tenant_commitment'),
    journal_transaction_id: reqStr(i.journalTransactionId, 'journal_transaction_id'),
    txn_type: reqStr(i.txnType, 'txn_type'),
    revenue_treatment: reqStr(i.revenueTreatment, 'revenue_treatment'),
    account_type: reqStr(i.accountType, 'account_type'),
    owner_type: reqStr(i.ownerType, 'owner_type'),
    direction: reqStr(i.direction, 'direction'),
    amount_atomic: atomicStr(i.amountAtomic, 'amount_atomic'),
    asset: reqStr(i.asset, 'asset'),
    effective_at_ms: msString(i.effectiveAt, 'effective_at_ms'),
  };
  if (i.ownerId !== undefined && i.ownerId !== null) leaf.owner_id = reqStr(i.ownerId, 'owner_id');
  return leaf;
}

// ============================================================================
// committed descriptors (§17.4) — frozen preimages reproduced by the verifier
// ============================================================================

/** The schema descriptor for the M4 mixed (revenue_event + ledger_entry) batch. Frozen. */
export const SCHEMA_DESCRIPTOR: LcjObject = {
  lcj_version: 'LCJ.v1',
  hash_function: 'keccak256',
  merkle_tree_version: 'rfc9162-keccak.v1',
  domain_separation: 'leaf=0x00;node=0x01',
  leaf_record_types: [REVENUE_EVENT_LEAF_SCHEMA, LEDGER_ENTRY_LEAF_SCHEMA],
  field_order_policy: 'lcj-sorted-keys',
  batch_ordering_rule:
    'mixed:record_type_rank(revenue_event_leaf=0,ledger_entry_leaf=1);revenue_event by id;ledger_entry by effective_at_ms,journal_transaction_id,id',
};

/** The metadata-policy descriptor. Frozen. */
export const METADATA_POLICY_DESCRIPTOR: LcjObject = {
  policy_version: 'metadata-policy.v1',
  raw_fields: 'none',
  hashed_fields: 'payer_address;resource;response_body (sha256;0x-hex;capture-time)',
  omitted_from_leaf: 'account_name;memo;units;raw_urls;customer_id',
  encrypted_fields: 'none',
  retention_policy: 'default',
};

/** Convenience: full leaf_hash for a canonical leaf record (canonical_record_hash then 0x00 leaf-hash). */
export function leafHashOfRecord(record: LcjValue): Uint8Array {
  return leafHash(canonicalRecordHash(record));
}

// ============================================================================
// closed-schema validation (§17 Rule 10) — used by the verifier on disclosed records
// ============================================================================

const LEAF_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  [REVENUE_EVENT_LEAF_SCHEMA]: {
    required: ['schema_version', 'id', 'tenant_commitment', 'interaction_id', 'revenue_source', 'gross_amount_atomic', 'asset', 'revenue_status', 'earned_at_ms'],
    optional: ['network'],
  },
  [LEDGER_ENTRY_LEAF_SCHEMA]: {
    required: ['schema_version', 'id', 'tenant_commitment', 'journal_transaction_id', 'txn_type', 'revenue_treatment', 'account_type', 'owner_type', 'direction', 'amount_atomic', 'asset', 'effective_at_ms'],
    optional: ['owner_id'],
  },
};

/**
 * Reject a record that does not match the closed schema for its `schema_version` (§17 Rule 10):
 * unknown fields rejected (not ignored), required fields present. The verifier runs this on every
 * disclosed record BEFORE re-canonicalizing, so a tampered record with an extra/missing field fails
 * loudly rather than silently producing a different hash.
 */
export function assertClosedLeafSchema(record: LcjObject): void {
  const sv = record.schema_version;
  if (typeof sv !== 'string') throw new Error('assertClosedLeafSchema: missing schema_version');
  const spec = LEAF_FIELDS[sv];
  if (!spec) throw new Error(`assertClosedLeafSchema: unknown schema_version "${sv}"`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(record)) {
    if (!allowed.has(k)) throw new Error(`assertClosedLeafSchema: unknown field "${k}" for ${sv} (Rule 10)`);
  }
  for (const k of spec.required) {
    if (!(k in record)) throw new Error(`assertClosedLeafSchema: missing required field "${k}" for ${sv}`);
  }
}
