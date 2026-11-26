/**
 * Booth's own formats. These are Booth's to define — unlike chain parameters,
 * kit message formats and precompile addresses, which are only ever taken from
 * docs/VERIFIED-FACTS.md.
 *
 * Every string here is versioned. Changing one changes what verifies, so bump
 * the version rather than editing in place.
 */

/** QoreSeal `purpose` for a sealed ballot. Part of the envelope's KDF info. */
export const BALLOT_PURPOSE = 'booth-ballot-v1';

/** QoreSeal `purpose` for a trustee's sealed share of the election key seed. */
export const SHARE_PURPOSE = 'booth-trustee-share-v1';

/**
 * Fixed domain tag of the message a voter's ML-DSA-87 key signs.
 *
 * The signed message binds the choice, a random nonce, the voter's address, the
 * election, the contract and the chain id — and deliberately NOT the envelope
 * hash. Signing the envelope would be circular (the signature lives inside the
 * envelope) and would also let the same ciphertext be replayed by whoever
 * happened to produce it.
 */
export const BALLOT_SIG_DOMAIN = 'booth-ballot-sig-v1';

/**
 * Version byte of the ballot plaintext.
 *
 * v1 carried `{v, choice}` as JSON and no signature. v2 is a compact binary
 * layout carrying the choice, the nonce and the ML-DSA-87 signature. The
 * voter's ML-DSA public key is NOT in the plaintext: the tally fetches it from
 * the chain's PQC registry for `ballotVoter(electionId, ballotId)`, so a ballot
 * cannot assert its own identity.
 */
export const BALLOT_PLAINTEXT_VERSION = 2;

/** ML-DSA-87 signature length, from FIPS 204. Asserted at encode and decode. */
export const ML_DSA_87_SIGNATURE_BYTES = 4627;

/** Length of the per-ballot random nonce. */
export const BALLOT_NONCE_BYTES = 32;
