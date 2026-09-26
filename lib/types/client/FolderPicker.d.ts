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
 * What CAN be borrowed is the backend both of those use:
 * `ctx.uiWorkspace.listDirectory` / `createDirectory` (the `directoryPicker`
 * namespace's browse verbs). This dialog is that backend with our own face: the
 * path line is editable, a row with a chevron walks into that folder, and 打开
 * confirms the folder the path line is showing.
 */
import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** One row of a browse level, as the product's picker backend reports it. */
export interface PickerEntry {
    readonly name: string;
    readonly path: string;
    readonly hidden: boolean;
}
/** One browse level: the folder itself, its ancestry, and its child folders. */
export interface PickerListing {
    readonly path: string;
    readonly home: string;
    readonly crumbs: readonly PickerEntry[];
    readonly entries: readonly PickerEntry[];
    readonly truncated: boolean;
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
    /** One directory level from the product's picker backend; undefined starts at home. */
    readonly list: (path: string | undefined, signal: AbortSignal) => Promise<PickerListing>;
    /** Create one child folder and answer its absolute path. */
    readonly create: (path: string, name: string) => Promise<string>;
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
export declare function FolderPicker({ useFolderPicker, list, create, confirm, close, t }: FolderPickerProps): ReactNode;
