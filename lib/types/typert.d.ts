/**
 * The hand-written host Typert manifest for the atFile and atMention Remote
 * namespaces. Registered through `ctx.typert.register` in the plugin body,
 * it claims every wire endpoint through the strict registry — the same path
 * generated `./typert` artifacts use — so the Host Gateway resolves search,
 * settings, and category picks without consulting the `@Remote` marker
 * table. That marker independence matters in the harness's source-launch
 * development environment, where the tsx-loaded gateway and a profile-loaded
 * plugin bundle can hold separate copies of the decorator module state.
 */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';
/** The host manifest: one package, two service namespaces (strict codecs shared with the client). */
export declare const TYPERT_MANIFEST: TypertContribution;
