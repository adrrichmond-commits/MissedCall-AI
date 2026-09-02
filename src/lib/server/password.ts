/**
 * Runtime-agnostic password hashing.
 *
 * The dev server (Vite) runs under Node even when launched via `bun --bun`,
 * while production (`bun run serve.ts`) runs under Bun. Bun-specific APIs
 * (`Bun.password`) are therefore unavailable in dev, so hashing uses ONLY
 * `node:crypto` scrypt — implemented identically by Node and Bun — for any
 * hash this module creates.
 *
 * Stored format for hashes created here: `scrypt$<saltHex>$<hashHex>`
 * (salt 16 bytes, scrypt N=16384 r=8 p=1, derived key 64 bytes).
 *
 * Legacy back-compat: seeded users may carry Bun-generated `$argon2id$…`
 * hashes. Verification of those delegates to `Bun.password.verify` when the
 * Bun global exists; under a pure-Node runtime they cannot be recomputed, so
 * we fail loudly with a clear operator-facing error instead of a cryptic
 * ReferenceError.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const SCRYPT_PREFIX = "scrypt$";
const ARGON2_PREFIX = "$argon2id$";

/** Promisified scrypt (callback form keeps us on node:crypto in both runtimes). */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
    );
  });
}

/** Hash a plaintext password into the runtime-agnostic `scrypt$…` format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN);
  return `${SCRYPT_PREFIX}${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash in either format.
 * Returns false for malformed/unknown formats rather than throwing, so a
 * corrupted row reads as a failed login, not a 500.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== "string" || stored.length === 0) return false;

  if (stored.startsWith(ARGON2_PREFIX)) {
    // Legacy Bun-generated hash. Only the Bun runtime can evaluate argon2id.
    if (typeof Bun === "undefined") {
      throw new Error(
        "Legacy argon2id hash cannot be verified under Node — re-run `bun scripts/seed.ts` (or reset the password) to store a runtime-agnostic scrypt$ hash.",
      );
    }
    return Bun.password.verify(password, stored);
  }

  if (stored.startsWith(SCRYPT_PREFIX)) {
    const parts = stored.split("$");
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
    const derived = await scrypt(password, salt, KEY_LEN);
    return timingSafeEqual(derived, expected);
  }

  return false;
}
