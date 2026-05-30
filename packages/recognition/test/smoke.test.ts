import { describe, it, expect } from 'vitest';
// Proves workspace alias resolution (raw-TS `exports: './src/index.ts'`) before any DB test runs.
import * as recognition from '@ledgerline/recognition';
import * as sellerClient from '@ledgerline/seller-client';

describe('workspace resolution', () => {
  it('resolves @ledgerline/recognition exports', () => {
    expect(typeof recognition.parseReceipt).toBe('function');
    expect(typeof recognition.allocateSplit).toBe('function');
    expect(typeof recognition.buildPostingLegs).toBe('function');
    expect(typeof recognition.recognizeOne).toBe('function');
    expect(typeof recognition.runRecognitionPass).toBe('function');
    expect(typeof recognition.hexToBytea).toBe('function');
  });

  it('resolves @ledgerline/seller-client exports', () => {
    expect(typeof sellerClient.canonicalHash).toBe('function');
    expect(typeof sellerClient.allocateOneSplit).toBe('function');
  });
});
