import { createHash } from 'node:crypto';
export function getUserPercentile(userId, salt) {
  const h = createHash('sha256').update(salt + ':' + userId).digest();
  return (h.readUInt32BE(0) / 0xffffffff) * 100;
}
