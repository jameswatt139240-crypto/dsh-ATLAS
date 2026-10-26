/**
 * The `at-file` settings namespace: the durable enable switch, pasted-mention
 * policy, and file-name filters managed from the Web settings page. Registered with the settings
 * provider at plugin load; the runtime reads the owner scope's live value on
 * every call, so changes take effect without a restart.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { AtFileSettings } from './contract.ts';
/** The branded namespace name (the Web allowlist must list the same string). */
export declare const AT_FILE_NAMESPACE = "at-file";
/**
 * Schemastery schema of the `at-file` namespace section. The trailing cast only
 * bridges schemastery's `ObjectT` inference — which carries an index signature
 * and mutable arrays — to the readonly interface the wire codec shares; every
 * field is still validated at runtime.
 */
export declare const AtFileSettingsSchema: z<AtFileSettings>;
/**
 * The settings surface this plugin consumes: the `at-file` namespace's live
 * value and a writer for it.
 *
 * Stated here rather than imported because the published settings service types
 * a composition EDITOR (`describe`/`update`/`mutate` over the profile's own
 * entries), while this plugin owns a namespace of its own. The namespace API the
 * runtime still answers — `register(namespace, schema, { applies: 'live' })` —
 * is what this shape names, and {@link registerAtFileSettings} probes for it
 * instead of assuming it, so a profile without it degrades to defaults instead
 * of failing the whole plugin at load.
 */
export interface AtFileSettingsScope {
    /** The namespace's current value, defaults applied. */
    get(): AtFileSettings;
    /** Merge one patch into the namespace and persist it. */
    update(patch: Partial<AtFileSettings>): Promise<void>;
}
/**
 * Register the namespace with the settings provider and return its owner scope.
 * @param ctx - the plugin context carrying the settings provider.
 * @returns the owner scope backing the runtime's live enable check.
 */
export declare function registerAtFileSettings(ctx: Context): AtFileSettingsScope;
