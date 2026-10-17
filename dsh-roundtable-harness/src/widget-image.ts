/**
 * The launcher artwork.
 *
 * The image lives in `assets/widget-96.png` and is imported as a URL: esbuild's
 * `dataurl` loader inlines it into the Client bundle at build time. Keeping the
 * art as an image — instead of a 30 KB base64 literal in the source — keeps the
 * diff readable and stops source scanners from treating a long opaque blob as an
 * obfuscated script.
 *
 * The art itself: a 1920×1920 illustration, centre-cropped above its caption
 * card, downscaled with a high-quality filter, then flood-filled from the four
 * corners so the white backdrop is gone while the character's own white headdress
 * stays opaque.
 *
 * @module dsh-roundtable-harness/widget-image
 */

import url from '../assets/widget-96.png';

/** Data URL of the launcher artwork, produced by the bundler. */
export const WIDGET_IMAGE: string = url;
