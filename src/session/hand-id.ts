import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const HAND_ID_NAMESPACE = 'poker-engine:hand';

function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createDeterministicHandId(
  sessionId: string,
  handNumber: number,
): string {
  const input = `${HAND_ID_NAMESPACE}:${sessionId}:${handNumber.toString(10)}`;
  const hash = sha1(utf8ToBytes(input));
  const bytes = hash.slice(0, 16);
  const versionSource = bytes[6] ?? 0;
  bytes[6] = (versionSource & 0x0f) | 0x50;
  const variantSource = bytes[8] ?? 0;
  bytes[8] = (variantSource & 0x3f) | 0x80;

  return formatUuid(bytes);
}
