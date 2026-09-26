/**
 * The draft's own SCOPE (内部需求 R-05): a category token is scoped by the nearest
 * folder reference typed BEFORE it, so `@e:/work/docs/ @file:` lists that folder's
 * files. The scope is positional on purpose — a connective word ("的") would add a
 * natural-language grammar for no gain, and every spelling of it would have to be
 * recognised in every language the composer accepts.
 *
 * Pure string/verdict work, so the browser bridge only supplies the two facts this
 * module cannot know: which token spellings are folders by syntax, and whether the
 * Host calls one plain path token a directory.
 */
import { draftLink } from './draft-links.ts'

/** What {@link draftScopeOf} cannot read for itself. */
export interface ScopeProbe {
  /**
   * Whether the Host's own verdict calls this path a directory. A path token
   * without a trailing separator is a file by syntax (`@e:/work/docs`), and only the
   * Host knows it is the folder the user meant.
   * @param path - the token's decoded path.
   * @returns true when the Host says `dir`.
   */
  isFolder(path: string): Promise<boolean>
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
export async function draftScopeOf(tokens: readonly string[], probe: ScopeProbe): Promise<string | undefined> {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token === undefined) continue
    const link = draftLink(token)
    if (link === undefined) continue
    if (link.kind === 'folder') return link.path
    if (link.kind !== 'file') continue
    if (await probe.isFolder(link.path)) return link.path
  }
  return undefined
}
