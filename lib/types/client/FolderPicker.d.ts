/**
 * The folder chooser dialog: a modal picker over the product's own browse
 * backend.
 *
 * Why not the product's dialog itself: `BrowseDirectoryFlow` is not a service, it
 * is a component filling the workspace picker's PRIVATE child slots
 * (`conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`),
 * and rendering a slot belongs to the entry that declared it — a plugin can
 * neither declare the same hole nor render someone else's. And
 * `directoryPicker/pick` is the NATIVE chooser, which a profile serving the
 * in-app browse capability refuses (`directory-picker/unavailable`).
 *
 * What CAN be borrowed is the backend both of those use: this plugin's own
 * `atFile.browse` / `atFile.list` / `atFile.create` (see the wire face below).
 *
 * The list is ONE tree in TWO groups:
 *
 *     常用区外文件夹        (collapsed until asked for)
 *       ├ Projects          → a jump outside the workspace
 *       └ …
 *     当前文件夹            (open, and where the browsing happens)
 *       ├ ⬆ 上一级
 *       ├ Eason             → Enter expands it in place, Ctrl+Enter adopts it
 *       └ …
 *
 * The path line and the list are two views of the SAME location and may not
 * diverge: typing a path (or pressing Enter on it) re-roots the tree, and every
 * way of moving — a crumb, a drive, the way up, a preset, an expanded folder —
 * updates both.
 *
 * `Enter` and `Ctrl+Enter` are different verbs everywhere in this dialog, and
 * the difference does not depend on which row happens to be current:
 *
 *     Enter        expand what can be expanded (a group, a folder with children);
 *                  adopt what cannot (a folder without children)
 *     Ctrl+Enter   adopt the current row — write the reference and close
 *
 * The cursor is tracked by ROW KEY rather than by index, so expanding a folder
 * (which inserts rows) or filtering (which removes them) leaves it exactly where
 * it was: the only thing that moves the current row is an arrow key.
 */
import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** One row of a browse level, as the product's picker backend reports it. */
export interface PickerEntry {
    readonly name: string;
    readonly path: string;
    readonly hidden: boolean;
    /**
     * Whether this folder holds at least one child folder. Absent when the Host did
     * not say (an older Host, or a probe that ran out of budget): the row then
     * offers expansion and finds out on the way in.
     */
    readonly hasChildren?: boolean;
}
/** One offered folder the chooser can jump to without browsing (see the Host's `recentFolders`). */
export interface PickerPreset {
    readonly path: string;
    readonly name: string;
    readonly reason: 'sibling' | 'parent' | 'child' | 'recent' | 'family';
}
/** One browse level: the folder itself, its ancestry, and its child folders. */
export interface PickerListing {
    readonly path: string;
    readonly home: string;
    readonly crumbs: readonly PickerEntry[];
    readonly entries: readonly PickerEntry[];
    readonly truncated: boolean;
    /** The drive roots, present exactly while the listing IS a drive root. */
    readonly drives?: readonly string[];
    /** The folder above, absent at a drive root (where `drives` takes its place). */
    readonly parent?: string;
    /** Why this level could not be listed, when it could not. */
    readonly error?: 'outside' | 'missing' | 'notDirectory';
    /**
     * What the user actually typed, present only while it is DEEPER than `path`:
     * `path` is the longest valid prefix of it that could be listed, and the rest is
     * the needle the two groups filter by.
     */
    readonly requested?: string;
}
/** The open/closed share between the source's picker row and this dialog. */
export interface FolderPickerSnapshot {
    /** Set while the dialog is open; the token the pick will replace travels with it. */
    readonly value: unknown | null;
}
/** Read-only observable face the dialog subscribes to. */
export interface FolderPickerSource {
    getSnapshot(): FolderPickerSnapshot;
    subscribe(listener: () => void): () => void;
}
/** What the session's shell shares with the dialog. */
export interface FolderPickerInjected {
    /** One directory level for a path being typed: the longest valid prefix plus its child folders. */
    readonly browse: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>;
    /** One directory level; `''` means the session workspace root, undefined means the drive root holding it. */
    readonly list: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>;
    /** Create one child folder and answer its absolute path. */
    readonly create: (path: string, name: string) => Promise<string>;
    /** The folders worth offering before any browsing (ranked; possibly empty). */
    readonly recent: (signal: AbortSignal) => Promise<readonly PickerPreset[]>;
    /** Adopt the folder the path line shows (inserts the reference and closes). */
    readonly confirm: (path: string) => void;
    /** Dismiss without adopting anything. */
    readonly close: () => void;
    readonly hooks: {
        readonly folderPicker: FolderPickerSource;
    };
}
/** The dialog's props: the overlay seat, this plugin's copy, and the shell's face. */
export type FolderPickerProps = PropsRuntime<'conversation.input.overlay'> & PropsLocale<'atlas'> & InjectFace<FolderPickerInjected>;
/**
 * Render the folder chooser while one is requested.
 * @param props - the open state, the browse backend, and the adoption callbacks.
 * @returns the modal, or null while closed.
 */
export declare function FolderPicker({ useFolderPicker, browse, list, create, recent, confirm, close, t }: FolderPickerProps): ReactNode;
