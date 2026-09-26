/**
 * The folder tab: one directory, one level, in the right Sidebar.
 *
 * Why a type of this plugin's own: a `dsh-resource://file/…` address is claimed
 * by the file viewers, and a directory makes them answer `"…" is a directory`;
 * the built-in `files` tab is a page (a tree rooted at the session workspace)
 * that claims no address at all. So a folder click has nowhere to go in the
 * shipped product, and this tab is that destination — for a workspace folder and
 * for an out-of-workspace one alike, because the Host gates the listing with the
 * same rule it uses for a reference.
 *
 * The body walks on its own: a directory row descends in this tab, a file row
 * opens the file's own viewer, and the header carries the way back up plus the
 * OS opener. Nothing here reads a file — `atFile/list` returns names and kinds.
 */
import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { DirectoryListing } from '../contract.ts';
import type { AtFileKey } from './locales.ts';
import { childOf } from './model.ts';
/** This type's identity in the tab registry, and the key its body registers under. */
export declare const FOLDER_TAB_ID = "dsh-atlas/folder";
/** The tab kind this plugin owns. */
export declare const FOLDER_TAB_KIND = "atlas-folder";
/**
 * The folder tab's registry definition: it claims every address of our own
 * `folder` resource type, so nothing else can be asked to open one.
 * @param t - namespace-bound translate for the chip title.
 * @returns the definition to register.
 */
export declare function folderTabDefinition(t: (key: AtFileKey, params?: Record<string, string>) => string): SidebarRightTabDefinition;
/** What the session's shell shares with the folder tab. */
export interface FolderTabInjected {
    /** List one directory (one level); `''` means the session workspace root. */
    readonly list: (path: string, signal: AbortSignal) => Promise<DirectoryListing>;
    /** Open a file the way every other reference does. */
    readonly openFile: (path: string) => void;
    /** Hand a path to the OS file manager. */
    readonly openNative: (path: string) => void;
}
/** The folder tab's props: the tab seat, the copy seat, and the shell's face. */
export type FolderTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'atlas'> & InjectFace<FolderTabInjected>;
export { childOf };
/**
 * Render one directory's contents.
 * @param props - the tab's live info, the Host listing call, and the openers.
 * @returns the folder's rows, or the reason it could not be listed.
 */
export declare function FolderTab({ useTabInfo, list, openFile, openNative, t }: FolderTabProps): ReactNode;
