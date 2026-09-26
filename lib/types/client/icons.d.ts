/** Tabler-based vector icons (single icon library) with per-kind semantic colors. */
import type { ReactElement } from 'react';
import type { FileEntry } from './remote.ts';
export type FileIconKind = 'folder' | 'code' | 'text' | 'pdf' | 'image' | 'data' | 'archive' | 'file';
/** Classify one indexed path without reading it. */
export declare function fileIconKind(file: Pick<FileEntry, 'kind' | 'relative'>): FileIconKind;
/**
 * One file-kind icon rendered at menu size. The wrapper span keeps the stable
 * `data-file-icon` marker for classification consumers and tests.
 */
export declare function fileIcon(file: Pick<FileEntry, 'kind' | 'relative'>): ReactElement;
/** Mention kinds that carry their own accent icon. */
export type MentionIconKind = 'file' | 'folder' | 'skill' | 'chat' | 'plugin' | 'back';
/** One category/dock icon with its semantic accent color (sparse glyphs compensated). */
export declare function mentionIcon(kind: MentionIconKind): ReactElement;
/**
 * A leaf-row icon for result rows (skills/chats/plugins), replacing the empty
 * indentation slot. Sizes match the category menu icons (skill 36px, others 28px)
 * so the same kind reads identically everywhere.
 */
export declare function leafIcon(kind: 'skill' | 'chat' | 'plugin'): ReactElement;
/**
 * The framework kind that RESERVES an icon box on one of our menu rows.
 *
 * The framework's row renders an icon only when the candidate carries one, and
 * it can only draw `session`, `file` and `folder`. So a row of ours always
 * carries one of those three: not for the glyph (which `MenuIcons` draws itself
 * over it), but for the BOX — a fixed 16 px slot that indents every name by the
 * same amount, which is what makes the column line up.
 * @param kind - the row's kind in this plugin's vocabulary.
 * @returns the framework kind to declare.
 */
export declare function menuIconKind(kind: MentionIconKind): 'file' | 'folder' | 'session';
/** The row facts one menu glyph is chosen from. */
export interface MenuGlyphRow {
    readonly mentionKind: string;
    readonly value?: string;
    readonly atFileKind?: 'file' | 'dir';
    readonly providerId?: string;
}
/**
 * The colour one menu row's glyph is drawn in.
 * @param row - the candidate row.
 * @returns the accent for a category row (its prefix, else its provider id), or
 *   undefined for a row that carries data, which keeps the neutral glyph colour.
 */
export declare function menuGlyphColor(row: MenuGlyphRow): string | undefined;
export declare function menuGlyph(row: MenuGlyphRow, size?: number): ReactElement;
