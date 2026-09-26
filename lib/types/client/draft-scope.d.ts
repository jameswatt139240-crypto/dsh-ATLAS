/** What {@link draftScopeOf} cannot read for itself. */
export interface ScopeProbe {
    /**
     * Whether the Host's own verdict calls this path a directory. A path token
     * without a trailing separator is a file by syntax (`@e:/work/docs`), and only the
     * Host knows it is the folder the user meant.
     * @param path - the token's decoded path.
     * @returns true when the Host says `dir`.
     */
    isFolder(path: string): Promise<boolean>;
}
/**
 * The folder path a draft is scoped by, or undefined when it names none.
 *
 * Tokens are scanned back to front, so the reference nearest the active token
 * wins; the active token itself names no folder (a category handle like `file:`
 * decodes to nothing, which is what keeps `@file:Ea` from scoping itself).
 * @param tokens - the composer's `@` tokens in document order, trigger included.
 * @param probe - the Host verdict lookup for plain path tokens.
 * @returns the scoping folder path, or undefined.
 */
export declare function draftScopeOf(tokens: readonly string[], probe: ScopeProbe): Promise<string | undefined>;
