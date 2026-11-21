import type { Context } from '@deepseek-ai/cordis';
import type { AtFileSettings } from './contract.ts';
/** The harness home this profile uses, as far as the plugin can tell. */
export declare function harnessHome(ctx: Context): string;
/** The file that holds the `at-file` section for one harness home. */
export declare function settingsFile(home: string): string;
/**
 * Read the section, or the defaults when the file is absent or unreadable.
 * A corrupt document is reported once and replaced on the next write; it never
 * takes the plugin down.
 * @param file - absolute path of the settings document.
 * @returns the validated section.
 */
export declare function readDurableSettings(file: string): AtFileSettings;
/** One durable document for one harness home. */
export interface DurableSettings {
    /** Absolute path of the document this store reads and writes. */
    readonly file: string;
    /** The section as it stands on disk (defaults when there is nothing yet). */
    load(): AtFileSettings;
    /** Replace the section, atomically and in order with other saves. */
    save(settings: AtFileSettings): Promise<void>;
}
/**
 * Build the store for the profile behind `ctx`.
 * @param ctx - the plugin context; only its profile home is consulted.
 * @returns a store whose saves are serialized and whose failures are reported,
 *   not thrown: a read-only home must not break the composer.
 */
export declare function createDurableSettings(ctx: Context): DurableSettings;
