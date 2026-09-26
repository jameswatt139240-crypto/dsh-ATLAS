/**
 * The client-side Typert Remote contribution for the dsh-atlas host
 * services: mounts the shared strict descriptors into `ctx.remote` under the
 * `atFile` and `atMention` namespaces. The descriptors and codecs come from
 * the shared contract module, so the browser bundle and the host manifest
 * stay on one wire definition. One contribution per package face: both
 * namespaces ride the same `dsh-atlas` package.
 */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { AtlasRuntimeInfo } from '../atlas.ts';
import type { AtFileSettings, AtFileSettingsUpdate, ChatCandidate, DirectoryListing, GitChange, PluginCandidate, ReferenceInfo, SkillCandidate } from '../contract.ts';
export type { DirectoryEntry, DirectoryListing, FileEntry, SkillCandidate, ChatCandidate, PluginCandidate, GitChange } from '../contract.ts';
/** The combined Remote namespace contribution (one package face). */
export declare const AT_REMOTE: TypertRemoteContribution;
declare module '@deepseek-ai/dsh-typert-protocol' {
    /** The `atFile` namespace face. */
    interface TypertRemoteNamespace$617446696c65 {
        search: (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly import('../contract.ts').FileEntry[]>>;
        inspect: (agentId: SessionId, targets: readonly string[], signal?: AbortSignal) => Promise<RemoteResult<readonly ReferenceInfo[]>>;
        getSettings: () => Promise<RemoteResult<AtFileSettings>>;
        updateSettings: (update: AtFileSettingsUpdate) => Promise<RemoteResult<AtFileSettings>>;
        list: (agentId: SessionId, path: string, signal?: AbortSignal) => Promise<RemoteResult<DirectoryListing>>;
    }
    /** The `atlas` namespace face (host half of the @ data-source seam). */
    interface TypertRemoteNamespace$61746c6173 {
        runtime: (signal?: AbortSignal) => Promise<RemoteResult<AtlasRuntimeInfo>>;
        gitChanges: (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly GitChange[]>>;
    }
    /** The `atMention` namespace face. */
    interface TypertRemoteNamespace$61744d656e74696f6e {
        listSkills: (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly SkillCandidate[]>>;
        listChats: (agentId: SessionId, query: string, limit: number, signal?: AbortSignal) => Promise<RemoteResult<readonly ChatCandidate[]>>;
        listPlugins: (signal?: AbortSignal) => Promise<RemoteResult<readonly PluginCandidate[]>>;
    }
    interface TypertRemoteMap {
        'atFile/search': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly import('../contract.ts').FileEntry[]>>;
        'atFile/inspect': (agentId: SessionId, targets: readonly string[], signal?: AbortSignal) => Promise<RemoteResult<readonly ReferenceInfo[]>>;
        'atFile/external': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<import('../contract.ts').ExternalAccessScope>>;
        'atFile/list': (agentId: SessionId, path: string, signal?: AbortSignal) => Promise<RemoteResult<DirectoryListing>>;
        'atFile/getSettings': () => Promise<RemoteResult<AtFileSettings>>;
        'atFile/updateSettings': (update: AtFileSettingsUpdate) => Promise<RemoteResult<AtFileSettings>>;
        'atMention/listSkills': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly SkillCandidate[]>>;
        'atMention/listChats': (agentId: SessionId, query: string, limit: number, signal?: AbortSignal) => Promise<RemoteResult<readonly ChatCandidate[]>>;
        'atMention/listPlugins': (signal?: AbortSignal) => Promise<RemoteResult<readonly PluginCandidate[]>>;
        'atlas/runtime': (signal?: AbortSignal) => Promise<RemoteResult<AtlasRuntimeInfo>>;
        'atlas/gitChanges': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<readonly GitChange[]>>;
    }
    interface TypertRemoteNamespaceMap {
        atFile: TypertRemoteNamespace$617446696c65;
        atMention: TypertRemoteNamespace$61744d656e74696f6e;
        atlas: TypertRemoteNamespace$61746c6173;
    }
}
