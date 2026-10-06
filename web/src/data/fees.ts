/**
 * The platform's cut of a collection, as a percentage.
 *
 * Keep this in sync with FLUTTERWAVE_SPLIT in src/config/constants.ts, which
 * reads FLUTTERWAVE_SPLIT_VALUE from the environment and defaults to 0.95 —
 * the merchant keeps 95%, so the platform keeps 5%. If that env var is changed
 * in production, change this number too, or the site will quote a fee the
 * product does not charge.
 */
export const PLATFORM_FEE_PERCENT = 5;
