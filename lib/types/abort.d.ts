/**
 * Cancellation versus failure, stated once.
 *
 * The plugin cancels its own work all the time: the browser aborts a superseded
 * menu search on every keystroke, and the Host aborts the expansions of a turn
 * the user stopped. Those cancellations surface as ordinary catchable errors
 * (`gateway/cancelled`, `AbortError`), and reporting them as failures is noise
 * that hides the real ones — so every containment site asks this first.
 */
/**
 * Whether a caught error is the cancellation of the plugin's own request.
 *
 * The caller's own signal is the authority: when the request the plugin handed
 * down was aborted, whatever came back is that abort. An `AbortError` name is
 * honoured too, because a layer may re-throw the reason detached from the
 * signal. Message text is deliberately NOT sniffed — a real failure whose text
 * happens to say "cancelled" must still be reported.
 * @param error - the caught value.
 * @param signal - the signal the plugin handed down, when it has one.
 * @returns true when this is the plugin's own cancellation.
 */
export declare function isCancellation(error: unknown, signal?: AbortSignal): boolean;
