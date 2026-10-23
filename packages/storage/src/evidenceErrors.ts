/**
 * An evidence copy failed an integrity check (WORM object or embedded record file).
 *
 * Always thrown, never returned as a flag: a caller that receives a record has a
 * record whose body still hashes to its seal, and one that does not receives nothing.
 * Handing back evidence known to be inconsistent — even annotated — invites a caller
 * to use it anyway.
 *
 * Lives apart from the S3 module so the embedded backend can raise it without importing
 * the AWS SDK.
 */
export class WormIntegrityError extends Error {
  constructor(
    readonly reason: string,
    readonly key?: string,
  ) {
    super(
      key ? `WORM integrity failure for ${key}: ${reason}` : `WORM integrity failure: ${reason}`,
    );
    this.name = "WormIntegrityError";
  }
}
