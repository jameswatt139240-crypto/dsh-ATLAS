/**
 * The dsh-atlas wire contracts, shared verbatim by the host manifests
 * (`ctx.typert.register` in typert.ts) and the client contributions
 * (`ctx.remote.$mount` in client/remote.ts). The `atFile` namespace keeps
 * workspace index search and plugin-owned settings access; the `atMention`
 * namespace serves the category pickers (skills, past chats, plugins).
 * File bytes never cross this boundary; the Host only marks validated
 * references at `agent/pre-step`.
 */
import { z } from 'zod';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
/** One indexed workspace entry (a file or a directory), with its display path. */
export interface FileEntry {
    readonly path: string;
    readonly relative: string;
    readonly kind: 'file' | 'dir';
}
/** Skill management tier (mirrors the sidebar Skill Manager grouping). */
export type SkillTier = 'system' | 'user' | 'project' | 'custom' | 'plugin';
/** One discoverable skill for the @skill mention picker. */
export interface SkillCandidate {
    readonly name: string;
    readonly description: string;
    /** Grouping tier (system/user/project/custom/plugin). */
    readonly tier: SkillTier;
}
/** One discoverable past session for the @chat mention picker. */
export interface ChatCandidate {
    readonly sessionId: string;
    readonly label: string;
    /** Host-built `dsh-session:<...>` mention URI (the browser never encodes it). */
    readonly uri: string;
    readonly cwd?: string;
    readonly createdAt: number;
}
/** One installed plugin entry for the @plugin mention picker. */
export interface PluginCandidate {
    readonly entryId: string;
    readonly moduleName: string;
    readonly enabled: boolean;
}
/** One changed workspace path, as the built-in `@git` provider reports it. */
export interface GitChange {
    /** Repository-relative path; also the item id that travels in `@git/…`. */
    readonly path: string;
    /** Porcelain status: `M`, `A`, `D`, `R`, `??`, … */
    readonly status: string;
    /** Lines added against HEAD when Git could count them (absent for binaries). */
    readonly added?: number;
    readonly removed?: number;
}
/**
 * Read-only facts about one referenced workspace path. `size` comes from the
 * directory entry; the Host never opens the file to compute it, which is what
 * lets the dock price a reference without breaking "paths only, never content".
 */
export interface ReferenceInfo {
    /** The workspace-relative path as requested (no leading `@`, no line range). */
    readonly relative: string;
    /** Whether the path resolves inside the workspace to an existing entry. */
    readonly exists: boolean;
    /** Entry kind; present only when the path exists. */
    readonly kind?: 'file' | 'dir';
    /** Byte size of a file entry (directory-entry metadata only). */
    readonly size?: number;
    /**
     * True when `relative` is an out-of-workspace path this session is allowed to
     * reference (`src/external.ts`). The dock marks those rows so an external
     * reference is never mistaken for a workspace one.
     */
    readonly outside?: true;
}
/**
 * One out-of-workspace path the user has actually referenced, kept so the menu
 * can offer it again without searching anything.
 *
 * Only the path and its usage metadata are stored — never file content, and
 * never a directory listing.
 */
export interface ExternalRef {
    /** Canonical absolute path with forward slashes. */
    readonly path: string;
    /** What it was referenced as; only directories can become search roots. */
    readonly kind: 'file' | 'dir';
    /** How many times it has been referenced. */
    readonly count: number;
    /** Epoch milliseconds of the last reference. */
    readonly lastUsedAt: number;
    /** Workspaces it was referenced from, most recent first (bounded). */
    readonly workspaces?: readonly string[];
}
/**
 * What one session may do with out-of-workspace paths, plus the folder rows
 * `@folder:` may offer. Computed by the Host (settings + the resolved sandbox
 * policy), never by the browser.
 */
export interface ExternalAccessScope {
    /** Whether this session may reference paths the ledger does not know yet. */
    readonly canDiscover: boolean;
    /** Ledger directories this session may reference into (canonical paths). */
    readonly roots: readonly string[];
    /** Folder rows to offer, each an absolute path outside the workspace. */
    readonly folders: readonly string[];
}
/** One row of a one-level directory listing. */
export interface DirectoryEntry {
    readonly name: string;
    readonly kind: 'file' | 'dir';
}
/** Why a directory could not be listed (the browser says which, in its own words). */
export type DirectoryRefusal = 'outside' | 'missing' | 'notDirectory';
/**
 * One bounded, one-level directory listing.
 *
 * `path` is the canonical spelling of the listed directory (forward slashes); it
 * carries a trailing separator ONLY when it is a drive root (`E:/`), so a child is
 * always `${path}/${name}` and nobody has to remember which case they are in.
 * `parent` is absent exactly at a drive root, where `drives` takes its place —
 * which is how a browser leaves the drive it started on.
 */
export interface DirectoryListing {
    readonly path: string;
    readonly parent?: string;
    readonly entries: readonly DirectoryEntry[];
    readonly truncated?: true;
    readonly drives?: readonly string[];
    readonly error?: DirectoryRefusal;
}
/** One file filter. Legacy string values remain accepted as exact, insensitive rules. */
export interface FileIgnoreRule {
    readonly kind: 'exact' | 'regex';
    readonly pattern: string;
    readonly caseSensitive: boolean;
}
/** Durable and wire-compatible input for one file filter. */
export type FileIgnoreRuleInput = string | FileIgnoreRule;
/** File-name filters attached to one canonical workspace path. */
export interface WorkspaceIgnoreFiles {
    /** Canonical workspace directory path supplied by the Harness. */
    readonly workspace: string;
    /** Additional basenames ignored only inside this workspace. */
    readonly ignoreFiles: FileIgnoreRuleInput[];
}
/** Recently referenced relative paths for one canonical workspace path. */
export interface WorkspaceRecentFiles {
    /** Canonical workspace directory path supplied by the Harness. */
    readonly workspace: string;
    /** Relative paths, most recent first, capped at the plugin maximum. */
    readonly files: readonly string[];
}
/**
 * One cross-category usage counter. The key is `${kind}:${value}`, the same
 * mention-kind vocabulary the picker and the dock already share, so a category
 * added later is counted without a schema change.
 */
export interface UsageEntry {
    /** `${mentionKind}:${value}`, e.g. `file:src/a.ts`, `skill:blender`, `plugin:dsh-atlas`. */
    readonly key: string;
    /** How many times the user picked this reference. */
    readonly count: number;
    /** Last pick time (epoch ms); the tie-breaker when counts are equal. */
    readonly at: number;
}
/** The `at-file` settings namespace's durable shape (host and client share it). */
export interface AtFileSettings {
    /** Whether the @file surface is enabled; false hides picker, dock, and reference injection. */
    readonly enabled: boolean;
    /** Global Exact and Regex basename filters; legacy strings are insensitive Exact rules. */
    readonly ignoreFiles: FileIgnoreRuleInput[];
    /** Workspace-specific filters added to the global filters. */
    readonly workspaceIgnoreFiles: WorkspaceIgnoreFiles[];
    /** Per-workspace recently referenced paths (most recent first). */
    readonly recentFiles?: WorkspaceRecentFiles[];
    /** Whether @ tokens inserted through paste stay ordinary text. */
    readonly ignorePastedMentions?: boolean;
    /** Whether the @skill picker and reference injection are enabled. */
    readonly enableSkills?: boolean;
    /** Whether the @past-chats picker and snapshot injection are enabled. */
    readonly enableChats?: boolean;
    /** Whether the @plugin picker and reference injection are enabled. */
    readonly enablePlugins?: boolean;
    /** Maximum candidate rows returned by the past-chats picker. */
    readonly candidateLimit?: number;
    /** Cross-category pick counters, highest count first (bounded by the plugin). */
    readonly usage?: readonly UsageEntry[];
    /** Out-of-workspace paths the user has referenced, most recent first (bounded). */
    readonly externalRefs?: readonly ExternalRef[];
    /**
     * What clicking a FOLDER reference does: open the right Sidebar, the OS file
     * manager, or both. Absent means `both` — the sidebar is the newer half and
     * the local opener is the behaviour that came first.
     */
    readonly folderOpen?: FolderOpenTarget;
}
/** How a folder reference opens when it is clicked. */
export type FolderOpenTarget = 'both' | 'sidebar' | 'native';
/** One field update sent through the plugin-owned settings Remote. */
export type AtFileSettingsUpdate = {
    readonly field: 'enabled';
    readonly value: boolean;
} | {
    readonly field: 'ignoreFiles';
    readonly value: FileIgnoreRuleInput[];
} | {
    readonly field: 'workspaceIgnoreFiles';
    readonly value: WorkspaceIgnoreFiles[];
} | {
    readonly field: 'ignorePastedMentions';
    readonly value: boolean;
} | {
    readonly field: 'enableSkills';
    readonly value: boolean;
} | {
    readonly field: 'enableChats';
    readonly value: boolean;
} | {
    readonly field: 'enablePlugins';
    readonly value: boolean;
} | {
    readonly field: 'candidateLimit';
    readonly value: number;
} | {
    readonly field: 'recentFiles';
    readonly value: WorkspaceRecentFiles[];
} | {
    readonly field: 'usage';
    readonly value: UsageEntry[];
} | {
    readonly field: 'externalRefs';
    readonly value: ExternalRef[];
} | {
    readonly field: 'folderOpen';
    readonly value: FolderOpenTarget;
};
/** Wire codec: one session identity (branded string on the wire). */
export declare const sessionIdSchema: z.ZodString;
/** Wire codec: one workspace entry (file or directory). */
export declare const fileEntrySchema: z.ZodReadonly<z.ZodObject<{
    path: z.ZodString;
    relative: z.ZodString;
    kind: z.ZodEnum<{
        file: "file";
        dir: "dir";
    }>;
}, z.core.$strip>>;
/** Wire codec: one discoverable skill row. */
export declare const skillCandidateSchema: z.ZodReadonly<z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    tier: z.ZodEnum<{
        system: "system";
        user: "user";
        project: "project";
        custom: "custom";
        plugin: "plugin";
    }>;
}, z.core.$strip>>;
/** Wire codec: one past-session candidate row. */
export declare const chatCandidateSchema: z.ZodReadonly<z.ZodObject<{
    sessionId: z.ZodString;
    label: z.ZodString;
    uri: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
}, z.core.$strip>>;
/** Wire codec: one plugin inventory row. */
export declare const pluginCandidateSchema: z.ZodReadonly<z.ZodObject<{
    entryId: z.ZodString;
    moduleName: z.ZodString;
    enabled: z.ZodBoolean;
}, z.core.$strip>>;
/** Wire schema of one reference inspection row. */
export declare const referenceInfoSchema: z.ZodReadonly<z.ZodObject<{
    relative: z.ZodString;
    exists: z.ZodBoolean;
    kind: z.ZodOptional<z.ZodEnum<{
        file: "file";
        dir: "dir";
    }>>;
    size: z.ZodOptional<z.ZodNumber>;
    outside: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strip>>;
/** Wire schema of one ledger row for an out-of-workspace reference. */
export declare const externalRefSchema: z.ZodReadonly<z.ZodObject<{
    path: z.ZodString;
    kind: z.ZodEnum<{
        file: "file";
        dir: "dir";
    }>;
    count: z.ZodNumber;
    lastUsedAt: z.ZodNumber;
    workspaces: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>>;
/** Wire schema of one session's out-of-workspace scope. */
export declare const externalAccessScopeSchema: z.ZodReadonly<z.ZodObject<{
    canDiscover: z.ZodBoolean;
    roots: z.ZodArray<z.ZodString>;
    folders: z.ZodArray<z.ZodString>;
}, z.core.$strip>>;
/** Wire schema of one directory-listing row. */
export declare const directoryEntrySchema: z.ZodReadonly<z.ZodObject<{
    name: z.ZodString;
    kind: z.ZodEnum<{
        file: "file";
        dir: "dir";
    }>;
}, z.core.$strip>>;
/** Wire schema of one one-level directory listing. */
export declare const directoryListingSchema: z.ZodReadonly<z.ZodObject<{
    path: z.ZodString;
    parent: z.ZodOptional<z.ZodString>;
    entries: z.ZodArray<z.ZodReadonly<z.ZodObject<{
        name: z.ZodString;
        kind: z.ZodEnum<{
            file: "file";
            dir: "dir";
        }>;
    }, z.core.$strip>>>;
    truncated: z.ZodOptional<z.ZodLiteral<true>>;
    drives: z.ZodOptional<z.ZodArray<z.ZodString>>;
    error: z.ZodOptional<z.ZodEnum<{
        outside: "outside";
        missing: "missing";
        notDirectory: "notDirectory";
    }>>;
}, z.core.$strip>>;
/** Wire schema of one directory target (`''` means the session workspace root). */
export declare const directoryTargetSchema: z.ZodString;
/** Strict wire codec for one structured file filter. */
export declare const fileIgnoreRuleSchema: z.ZodReadonly<z.ZodObject<{
    kind: z.ZodEnum<{
        exact: "exact";
        regex: "regex";
    }>;
    pattern: z.ZodString;
    caseSensitive: z.ZodBoolean;
}, z.core.$strip>>;
/** Strict wire codec accepting both legacy strings and structured filters. */
export declare const fileIgnoreRuleInputSchema: z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
    kind: z.ZodEnum<{
        exact: "exact";
        regex: "regex";
    }>;
    pattern: z.ZodString;
    caseSensitive: z.ZodBoolean;
}, z.core.$strip>>]>;
/** Strict wire codec for one workspace-specific filter row. */
export declare const workspaceIgnoreFilesSchema: z.ZodReadonly<z.ZodObject<{
    workspace: z.ZodString;
    ignoreFiles: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
        kind: z.ZodEnum<{
            exact: "exact";
            regex: "regex";
        }>;
        pattern: z.ZodString;
        caseSensitive: z.ZodBoolean;
    }, z.core.$strip>>]>>;
}, z.core.$strip>>;
/** Strict wire codec for one workspace's recent-file list. */
export declare const workspaceRecentFilesSchema: z.ZodReadonly<z.ZodObject<{
    workspace: z.ZodString;
    files: z.ZodArray<z.ZodString>;
}, z.core.$strip>>;
/** Strict wire codec for one cross-category usage counter. */
export declare const usageEntrySchema: z.ZodReadonly<z.ZodObject<{
    key: z.ZodString;
    count: z.ZodNumber;
    at: z.ZodNumber;
}, z.core.$strip>>;
/** Strict wire codec for the running Harness facts the atlas seam gates on. */
export declare const atlasRuntimeSchema: z.ZodReadonly<z.ZodObject<{
    dshVersion: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
/** Strict wire codec for the resolved at-file settings section. */
export declare const atFileSettingsSchema: z.ZodReadonly<z.ZodObject<{
    enabled: z.ZodBoolean;
    ignoreFiles: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
        kind: z.ZodEnum<{
            exact: "exact";
            regex: "regex";
        }>;
        pattern: z.ZodString;
        caseSensitive: z.ZodBoolean;
    }, z.core.$strip>>]>>;
    workspaceIgnoreFiles: z.ZodArray<z.ZodReadonly<z.ZodObject<{
        workspace: z.ZodString;
        ignoreFiles: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
            kind: z.ZodEnum<{
                exact: "exact";
                regex: "regex";
            }>;
            pattern: z.ZodString;
            caseSensitive: z.ZodBoolean;
        }, z.core.$strip>>]>>;
    }, z.core.$strip>>>;
    ignorePastedMentions: z.ZodDefault<z.ZodBoolean>;
    enableSkills: z.ZodDefault<z.ZodBoolean>;
    enableChats: z.ZodDefault<z.ZodBoolean>;
    enablePlugins: z.ZodDefault<z.ZodBoolean>;
    candidateLimit: z.ZodDefault<z.ZodNumber>;
    recentFiles: z.ZodDefault<z.ZodArray<z.ZodReadonly<z.ZodObject<{
        workspace: z.ZodString;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>>;
    usage: z.ZodDefault<z.ZodArray<z.ZodReadonly<z.ZodObject<{
        key: z.ZodString;
        count: z.ZodNumber;
        at: z.ZodNumber;
    }, z.core.$strip>>>>;
    folderOpen: z.ZodDefault<z.ZodEnum<{
        both: "both";
        sidebar: "sidebar";
        native: "native";
    }>>;
}, z.core.$strip>>;
/** Strict wire codec for one field update. */
export declare const atFileSettingsUpdateSchema: z.ZodDiscriminatedUnion<[z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"enabled">;
    value: z.ZodBoolean;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"ignoreFiles">;
    value: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
        kind: z.ZodEnum<{
            exact: "exact";
            regex: "regex";
        }>;
        pattern: z.ZodString;
        caseSensitive: z.ZodBoolean;
    }, z.core.$strip>>]>>;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"workspaceIgnoreFiles">;
    value: z.ZodArray<z.ZodReadonly<z.ZodObject<{
        workspace: z.ZodString;
        ignoreFiles: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodReadonly<z.ZodObject<{
            kind: z.ZodEnum<{
                exact: "exact";
                regex: "regex";
            }>;
            pattern: z.ZodString;
            caseSensitive: z.ZodBoolean;
        }, z.core.$strip>>]>>;
    }, z.core.$strip>>>;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"ignorePastedMentions">;
    value: z.ZodBoolean;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"enableSkills">;
    value: z.ZodBoolean;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"enableChats">;
    value: z.ZodBoolean;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"enablePlugins">;
    value: z.ZodBoolean;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"candidateLimit">;
    value: z.ZodNumber;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"recentFiles">;
    value: z.ZodArray<z.ZodReadonly<z.ZodObject<{
        workspace: z.ZodString;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"usage">;
    value: z.ZodArray<z.ZodReadonly<z.ZodObject<{
        key: z.ZodString;
        count: z.ZodNumber;
        at: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>>, z.ZodReadonly<z.ZodObject<{
    field: z.ZodLiteral<"folderOpen">;
    value: z.ZodEnum<{
        both: "both";
        sidebar: "sidebar";
        native: "native";
    }>;
}, z.core.$strip>>], "field">;
/**
 * The built-in `@git` provider's shared facts.
 *
 * Both halves declare them: the browser half because the registry demands a
 * governance declaration for every registration, the Host half because it
 * answers `resolve`. Keeping one copy means a provider cannot end up with two
 * different `testedOn` claims depending on which half speaks first.
 */
export declare const GIT_PROVIDER_ID = "git";
/** What the built-in @git source reaches for: the git process, and no file read. */
export declare const GIT_SCOPES: readonly string[];
/**
 * The DSH builds this plugin's built-in providers have actually been exercised
 * on. The seam compares it for equality, so bumping it is part of the release
 * checklist — an unlisted build is reported as unverified, never as verified.
 */
export declare const BUILTIN_TESTED_ON: readonly string[];
/** Strict wire codec for one changed workspace path (the built-in `@git` source). */
export declare const gitChangeSchema: z.ZodReadonly<z.ZodObject<{
    path: z.ZodString;
    status: z.ZodString;
    added: z.ZodOptional<z.ZodNumber>;
    removed: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>;
/** The atFile Remote namespace's strict invocation descriptors. */
export declare const AT_FILE_INVOCATIONS: readonly InvocationDescriptor[];
/** The atMention Remote namespace's strict invocation descriptors. */
export declare const AT_MENTION_INVOCATIONS: readonly InvocationDescriptor[];
/**
 * The atlas seam's own invocations — the Host half of the @ data-source seam.
 * `runtime` reports the facts a provider's `testedOn` claim is judged against;
 * the Host-half provider registry lands here as the seam grows.
 */
export declare const ATLAS_INVOCATIONS: readonly InvocationDescriptor[];
