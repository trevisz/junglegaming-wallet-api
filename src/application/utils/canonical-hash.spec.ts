import { describe, it, expect } from 'bun:test';
import { computePayloadHash } from './canonical-hash.util';

describe('Canonical Payload Hash Utility', () => {
  it('should generate identical hashes regardless of object key order', () => {
    const payloadA = {
      roundId: 'round-1',
      providerId: 'prv-1',
      gameId: 'fortune-chimp',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const payloadB = {
      gameId: 'fortune-chimp',
      money: { currency: 'BRL', amount: '25.00' },
      providerId: 'prv-1',
      roundId: 'round-1',
    };

    const hashA = computePayloadHash(payloadA);
    const hashB = computePayloadHash(payloadB);

    expect(hashA).toBe(hashB);
  });

  it('should produce different hashes for different payloads', () => {
    const hash1 = computePayloadHash({ amount: '10.00' });
    const hash2 = computePayloadHash({ amount: '20.00' });

    expect(hash1).not.toBe(hash2);
  });
});
