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

/** Must equal `Booth.BALLOT_DOMAIN` in contracts/Booth.sol. Asserted in tests. */
export const BALLOT_DOMAIN_PREIMAGE = 'booth-ballot-v1';

/** Version tag inside a ballot plaintext. */
export const BALLOT_PLAINTEXT_VERSION = 1;
