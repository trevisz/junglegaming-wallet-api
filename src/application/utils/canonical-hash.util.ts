import * as crypto from 'crypto';

export function canonicalJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }

  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((key) => `"${key}":${canonicalJsonStringify(obj[key])}`);
  return `{${entries.join(',')}}`;
}

export function computePayloadHash(businessPayload: Record<string, any>): string {
  const canonicalString = canonicalJsonStringify(businessPayload);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}
