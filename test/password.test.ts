import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/utils/password';

const PASSWORD = 'correct-horse-battery-staple';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reproduces the stored format exactly as an older release would have written it. */
async function legacyStoredHash(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    256,
  );
  return `pbkdf2_sha256$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

describe('password hashing', () => {
  it('still verifies hashes written with a different iteration count', async () => {
    // Every password stored by a deployment running an earlier release carries
    // its own iteration count. Lowering HASH_ITERATIONS must never lock those
    // users out, so verification has to follow the stored value, not the
    // current constant.
    const stored = await legacyStoredHash(PASSWORD, 100_000);
    expect(stored).toContain('$100000$');
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password-entirely', stored)).resolves.toBe(false);
  });

  it('accepts the full iteration range the stored format allows', async () => {
    for (const iterations of [50_000, 100_000, 600_000]) {
      const stored = await legacyStoredHash(PASSWORD, iterations);
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    }
  });

  it('writes new hashes with the current iteration count and a fresh salt', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    const [prefix, iterations] = first.split('$');

    expect(prefix).toBe('pbkdf2_sha256');
    expect(Number(iterations)).toBe(50_000);
    // A per-password salt means two hashes of the same password never match.
    expect(first).not.toBe(second);
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });

  it('rejects malformed and out-of-range stored hashes instead of throwing', async () => {
    const cases = [
      '',
      'not-a-hash',
      'pbkdf2_sha256$50000$nothex$nothex',
      // Below the accepted floor, so an attacker-supplied cheap hash is refused.
      await legacyStoredHash(PASSWORD, 1_000),
      // Argon2-style prefix from a hypothetical future format.
      'argon2id$50000$00$00',
    ];
    for (const stored of cases) {
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
    }
  });
});
