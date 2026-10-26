import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type PickerEntry } from './FolderPicker.tsx';
/** Required services: picker pipeline, session projection, carrier, Remote face, slots, and locale. */
export declare const inject: string[];
/**
 * The crumb strip for one absolute path: each ancestor of the location, outermost
 * first, so the user can jump straight back up to any of them.
 *
 * Built from the PATH rather than taken from a backend: the plugin's own listing
 * reports `parent` (one step) but not the whole ancestry, and a drive root is its
 * own first crumb. Each crumb's `name` is the segment it represents, with the
 * drive root keeping its full spelling so it is recognisable in the strip, and
 * the POSIX root contributing a `/` crumb so it stays reachable.
 * @param path - the canonical absolute path being listed.
 * @returns one entry per ancestor, or `[]` for a path with no ancestors.
 */
export declare function crumbsOf(path: string): readonly PickerEntry[];
/**
 * Compose the @ mention surface.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
