/**
 * Keep the existing stored format and work factor during this compatibility fix.
 * 50,000 is below OWASP's current PBKDF2-SHA256 recommendation; local workerd
 * timings do not establish edge CPU safety. Stronger password storage or an
 * external identity provider requires separate design and edge measurements.
 * Existing hashes always retain their own iteration count.
 */
const HASH_ITERATIONS = 50_000;
const HASH_ALGORITHM = 'SHA-256';
const HASH_PREFIX = 'pbkdf2_sha256';

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, HASH_ITERATIONS);
  return `${HASH_PREFIX}$${HASH_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) {
    // Unknown users take the same derivation work as a newly stored password.
    // There is no stored credential to accept, regardless of the derived bytes.
    await derivePassword(password, new Uint8Array(16), HASH_ITERATIONS);
    return false;
  }
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = await derivePassword(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(actual, parsed.hash);
}

/** Compare setup or API secrets without leaking length or early mismatch timing. */
export async function verifySecret(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: HASH_ALGORITHM, salt, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(derived);
}

function parseStoredHash(stored: string): { salt: Uint8Array; hash: Uint8Array; iterations: number } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return null;

  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const hash = fromHex(parts[3]);
  if (
    !Number.isInteger(iterations)
    || iterations < 50_000
    || iterations > 1_000_000
    || !salt
    || hash?.byteLength !== 32
  ) {
    return null;
  }
  return { salt, hash, iterations };
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(left, right);

  // Node's Web Crypto may not expose the Workers extension during unit tests.
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    result[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return result;
}
