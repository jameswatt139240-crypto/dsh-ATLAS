/**
 * The dock stylesheet, hand-written as a template string and injected once by
 * the plugin body: the web server serves exactly one file per client plugin,
 * so no separate CSS artifact may exist. Tokens come only from the shared
 * `--dsw-alias-*` design platform (no literal colors); class names carry the
 * `dsh_atFile` prefix to stay unique in the assembled shell.
 */

/** Stable `<style>` element id (idempotent injection across HMR re-runs). */
export const STYLE_ID = 'dsh-atlas-style'

/** The dock's injected stylesheet text. */
export const cssText = `
.dsh_atFile_rail {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance)
  );
  max-width: var(--dsh-composer-card-max-width);
  min-width: 0;
  margin: 0 auto;
}
.dsh_atFile_row {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
  min-height: 36px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_atFile_path {
  display: inline-flex;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
  max-width: 360px;
  height: 100%;
  padding: 0 6px 0 10px;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh_atFile_path:hover {
  color: var(--dsw-alias-brand-primary);
}
.dsh_atFile_cost {
  flex: none;
  padding: 0 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh_atFile_cost_warn {
  color: var(--dsw-alias-state-error-primary, #ef4444);
  font-weight: 600;
}
.dsh_atFile_missing {
  flex: none;
  padding: 0 6px;
  color: var(--dsw-alias-state-error-primary, #ef4444);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dsh_atFile_icon {
  flex: none;
  width: 14px;
  height: 14px;
}
.dsh_atFile_remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--dsw-alias-label-dimmed);
  cursor: pointer;
}
.dsh_atFile_remove svg {
  width: 12px;
  height: 12px;
}
.dsh_atFile_remove:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh_atFile_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dsh_atFile_title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
}
.dsh_atFile_card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
}
.dsh_atFile_checkbox {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsh_atFile_cardText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh_atFile_cardTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.dsh_atFile_cardDesc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
/* A-23 grouping: a heading plus one explanatory line, so the rows under it cannot be
   read as belonging to the other feature. The top rule separates the groups without
   introducing a card, which would nest one box inside the section's own. */
.dsh_atFile_groupTitle {
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
}
.dsh_atFile_groupDesc {
  margin-top: -4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_atFile_filter {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding-top: 4px;
}
.dsh_atFile_filterHeading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.dsh_atFile_filterHeadingText {
  display: flex;
  flex: 1 1 280px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh_atFile_filterTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.dsh_atFile_filterDesc,
.dsh_atFile_filterHint,
.dsh_atFile_workspaceField > span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_atFile_scopeTabs {
  display: inline-flex;
  flex: 0 1 auto;
  min-width: 220px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_atFile_scopeTab {
  flex: 1 1 0;
  min-width: 0;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh_atFile_scopeTab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh_atFile_scopeTab[aria-selected='true'] {
  background: var(--dsw-alias-button-ghost-active-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dsh_atFile_workspaceField {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dsh_atFile_workspaceSelect,
.dsh_atFile_filterInput {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh_atFile_workspaceSelect:focus,
.dsh_atFile_filterInput:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh_atFile_workspaceSelect:disabled,
.dsh_atFile_filterInput:disabled {
  opacity: 0.55;
}
.dsh_atFile_filterToolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.dsh_atFile_filterGroupTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.dsh_atFile_secondaryButton {
  flex: none;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 15px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh_atFile_secondaryButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh_atFile_secondaryButton:disabled,
.dsh_atFile_filterRemove:disabled,
.dsh_atFile_addButton:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh_atFile_filterList {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_atFile_filterRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 40px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh_atFile_filterRow:last-child {
  border-bottom: 0;
}
.dsh_atFile_filterName {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh_atFile_ruleMain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  flex: 1 1 auto;
  gap: 8px;
  min-width: 0;
}
.dsh_atFile_ruleBadge {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dsh_atFile_ruleMain .dsh_atFile_filterName {
  flex: 1 1 180px;
}
.dsh_atFile_filterRemove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 14px;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh_atFile_filterRemove:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.dsh_atFile_filterRemove svg,
.dsh_atFile_addButton svg {
  width: 15px;
  height: 15px;
}
.dsh_atFile_filterEmpty {
  padding: 16px 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
.dsh_atFile_filterAddRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.dsh_atFile_ruleMode {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh_atFile_ruleModeButton {
  min-width: 72px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh_atFile_ruleModeButton[aria-pressed='true'] {
  background: var(--dsw-alias-button-ghost-active-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dsh_atFile_caseToggle {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh_atFile_caseToggle input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh_atFile_filterAddRow .dsh_atFile_filterInput {
  flex: 1 1 240px;
  width: auto;
}
.dsh_atFile_filterInput[aria-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh_atFile_addButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: 18px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh_atFile_filterError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh_atFile_inherited {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding-top: 4px;
}
.dsh_atFile_inheritedTitle {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh_atFile_inheritedList {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.dsh_atFile_inheritedList code {
  max-width: 100%;
  overflow: hidden;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 560px) {
  .dsh_atFile_scopeTabs {
    width: 100%;
  }
  .dsh_atFile_addButton {
    flex: 1 1 auto;
  }
}


/* Maximize the @ mention menu height: the framework caps the listbox at 400px
   (its own design cap, itself already clamped to the space above the composer)
   inline; target only OUR menu (the atlas data-source marker is present on BOTH
   the pending loading row and the ready option rows, so the override holds from
   the first open and the width never jumps).

   The WIDTH is deliberately left alone. The framework lays the menu out as an
   absolutely positioned box with left:0 and right:0 inside the composer card's
   own overlay anchor, so it is exactly as wide as the card, which is itself
   capped by --dsh-composer-card-max-width. A content-sized width here (the
   previous behaviour) could push the popup past the composer instead — the
   plugin's UI must never leave the chat box. Long names wrap inside the card
   width instead (see the itemName rule below). */
[role="listbox"]:has([data-source="atlas"]) {
  /* Fit as much of the list as the composer leaves room for: MentionNavigator
     measures the composer card's top edge into --dsh-atlas-menu-max on every
     menu change and on resize, so the cap follows the real available height (a
     multi-line draft shrinks it) instead of a fixed viewport guess. The
     fallback keeps the previous behaviour until the first measurement lands,
     and 760px stays the absolute ceiling. */
  max-height: min(760px, var(--dsh-atlas-menu-max, calc(100dvh - 100px))) !important;
}
/* The MENU SHELL's own cap is 400px, set inline by the framework. Our category is
   short by design (a bounded row budget), and the user asked the popup to use the
   space above the composer instead of cutting the list at 400px — so when our
   group is present the shell may grow to the same measured budget. An important
   rule outranks an inline style, and a taller cap never stretches a short list
   (the height stays content-driven). */
[data-trigger-menu]:has([data-source="atlas"]) {
  max-height: min(760px, var(--dsh-atlas-menu-max, calc(100dvh - 100px))) !important;
}
[id^="dsh-slash-option-atlas-"] {
  /* Text and icon share the bottom edge so the label reads against the icon. */
  align-items: flex-end !important;
  gap: 10px !important;
}
[id^="dsh-slash-option-atlas-"] [class*="itemIcon"] {
  /* The icon slot grows with the bigger Tabler icons (36px skill included). */
  width: 32px !important;
  height: 32px !important;
  flex: none !important;
}
[id^="dsh-slash-option-atlas-"] [class*="itemName"] {
  /* The name NEVER shrinks to make room for the description: full width,
     wrapping only when the menu hits its max width. */
  max-width: none !important;
  flex: 0 0 auto !important;
  min-width: 0 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
[id^="dsh-slash-option-atlas-"] [class*="itemDescription"] {
  /* The description stays on ONE line with an ellipsis inside the remaining
     space — it can never spill into the name or the next row. */
  flex: 1 1 auto !important;
  min-width: 0 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}


/* Display-only side ad panel: beside the @ menu, same height, never in the
   list. z-index stays BELOW the menu's 100 so a residual overlap can never
   hide the candidate list (placement also keeps the panel outside the menu). */
.dsh_atAll_ad {
  position: fixed;
  z-index: 90;
  width: 150px; /* overwritten inline: adapts to the ad's aspect */
  border-radius: 12px;
  overflow: hidden;
  pointer-events: none;
  background: linear-gradient(160deg, #0b1e33 0%, #12294a 55%, #1c3d6b 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}
.dsh_atAll_ad img {
  display: block;
  width: 100%;
  height: 100%;
  /* contain (never crop): the whole ad stays visible, letterboxed on the
     panel's gradient when the panel is taller than the image aspect. */
  object-fit: contain;
}
.dsh_atAll_adBanner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 120px;
  padding: 12px;
  box-sizing: border-box;
}
.dsh_atAll_adWordmark {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 6px;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 2px 10px rgba(120, 180, 255, 0.45);
}
.dsh_atAll_adTag {
  font-size: 11px;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.55);
}

/* Sent-message reference chips are inert in this client build (its chat view
   calls projectUserText without the reference actions), so ReferenceLinks
   supplies the click and publishes the affordance itself: only a chip that
   bridge can actually open carries data-dsh-atlas-link. The styling is the
   framework's OWN link language — the tokens its wired chips use (the
   ui-primitives markdown fileMention rule): link-blue at rest, a dotted
   underline under the pointer. A build that wires the chips itself renders
   buttons, which this rule never matches. */
[data-dsh-atlas-link] {
  color: var(--dsw-alias-link);
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
}
[data-dsh-atlas-link]:hover,
[data-dsh-atlas-link]:focus {
  outline: none;
  text-decoration: underline dotted var(--dsw-alias-link);
  text-underline-offset: 3px;
}
/* A reference whose target is gone: the click learned it, so the chip stops
   looking like a link and reads as stale instead — the dock's own 已失效
   language, applied to a chip the plugin does not own. */
[data-dsh-atlas-missing] {
  color: var(--dsw-alias-label-dimmed, inherit);
  text-decoration: line-through;
  cursor: default;
}
/* A composer reference chip: the framework styles its BODY with the chip blue and
   cursor:default, and that rule is a single class — the same specificity as the
   link rule above, so this one is spelled with the host ancestor to win outright
   (a chip that opens must not keep telling the pointer it is not clickable). An
   inert chip keeps the framework's own look and cursor untouched. */
[data-composer-chip] [data-dsh-atlas-link] {
  color: var(--dsw-alias-link);
  cursor: pointer;
}
[data-composer-chip] [data-dsh-atlas-link]:hover {
  text-decoration: underline dotted var(--dsw-alias-link);
  text-underline-offset: 3px;
}
[data-composer-chip] [data-dsh-atlas-missing] {
  color: var(--dsw-alias-label-dimmed, inherit);
  text-decoration: line-through;
  cursor: default;
}
/* A draft reference is drawn as a link by the plugin itself: the framework
   colours only the head of a token it recognises (its matcher stops at the last
   separator or the first non-word character), and a hand-typed token it never
   recognised stays plain. DraftLinks paints the WHOLE token through the CSS
   Custom Highlight API — the one way to colour a text range without
   re-parenting a Lexical text span, whose updateDOM writes through
   firstChild.nodeValue. The colour is the framework's own reference colour (its
   composer-editor textRef rule), so a token it did colour reads unchanged. */
::highlight(dsh-atlas-draft-ref) {
  color: var(--dsw-alias-state-business-primary);
}
/* A draft reference whose target the Host reports as gone: the dock's own 已失效
   language (dimmed and struck through), painted over the same range so a
   reference that cannot open still reads as a reference. It is never a link:
   nothing here touches the cursor, and the click gate refuses it. */
::highlight(dsh-atlas-draft-missing) {
  color: var(--dsw-alias-label-dimmed, inherit);
  text-decoration: line-through;
}
/* Menu glyphs: this plugin's own icons, drawn over the icon slot the framework
   reserves on each of its rows (see MenuIcons). They live in their own fixed
   layer — nothing is inserted into a row the framework owns — and a slot is
   marked only while a glyph covers it, which is what hides the framework's own
   three-glyph set exactly there and nowhere else. */
.dsh_atlas_menuIcon {
  position: fixed;
  z-index: 2147482500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  pointer-events: none;
}
[data-dsh-atlas-menu-icon-host] > svg {
  display: none;
}
/* The folder tab: a directory, one level, walked in place. Rows are the sidebar's
   own density (they sit next to the files tree), the path is the only wide text
   and it ellipsizes rather than pushing the controls out of the header. */
.dsh_atlas_folder {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh_atlas_folderHead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25));
  position: sticky;
  top: 0;
  background: var(--dsw-alias-bg-base, transparent);
}
.dsh_atlas_folderUp,
.dsh_atlas_folderOpen {
  flex: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 6px;
  font: inherit;
}
.dsh_atlas_folderUp:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh_atlas_folderUp:not(:disabled):hover,
.dsh_atlas_folderOpen:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
}
.dsh_atlas_folderPath {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsh_atlas_folderNote {
  margin: 8px 10px;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-size: 12px;
}
.dsh_atlas_folderList {
  list-style: none;
  margin: 0;
  padding: 4px;
}
.dsh_atlas_folderRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  /* A row stays plain until the pointer is on it. The theme paints generic
     buttons, and a list where every line carries a plate reads as a table rather
     than a tree (reported from a screenshot), so this one wins outright. */
  background: none !important;
  box-shadow: none !important;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.dsh_atlas_folderRow:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16)) !important;
}
/* The row the user's second click asked for (A.16). It has to read at rest, not
   under the pointer: by the time this tab renders, the mouse is wherever it was
   when the chip was clicked, so a hover-only look would leave the selection
   invisible. Same token the chooser uses for its cursor row, so the two reading
   of "this one" match. */
.dsh_atlas_folderRowSelected,
.dsh_atlas_folderRowSelected:hover {
  background: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.28)) !important;
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, #5686fe) !important;
}
.dsh_atlas_folderGlyph {
  display: inline-flex;
  flex: none;
  align-items: center;
}
.dsh_atlas_folderName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The folder chooser dialog: the product's browse backend wearing this plugin's
   face (the product's own dialog is a private child slot of the workspace picker,
   so a plugin cannot render it). */
.dsh_atlas_pickerScrim {
  position: fixed;
  inset: 0;
  z-index: 2147482600;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.dsh_atlas_picker {
  display: flex;
  flex-direction: column;
  width: min(560px, 88vw);
  max-height: min(560px, 84vh);
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.3));
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base, #1b1f2a));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  overflow: hidden;
}
.dsh_atlas_pickerHead {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px 8px;
}
.dsh_atlas_pickerTitle {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.dsh_atlas_pickerPathRow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh_atlas_pickerPath {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsh_atlas_pickerCrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dsh_atlas_pickerCrumb {
  border: none;
  background: none !important;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 5px;
}
.dsh_atlas_pickerCrumb:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16)) !important;
}
.dsh_atlas_pickerList {
  list-style: none;
  margin: 0;
  padding: 4px 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 120px;
}
.dsh_atlas_pickerRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: none !important;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
/* The keyboard highlight. It must read as "this is where Enter goes", so it uses
   the selected-surface token rather than the hover tint — a user driving the list
   with the arrow keys is not pointing at anything with a mouse. Rows carry NO
   :hover tint of their own: it stayed painted on whatever sat under a stationary
   pointer, so paging with the arrows lit that row as well as the current one and
   the list showed TWO current items (m05904). Pointer feedback is the same single
   highlight: onPointerEnter moves the cursor onto the row it points at. */
.dsh_atlas_pickerRowHot {
  background: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.28)) !important;
}
.dsh_atlas_pickerRow:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff);
  outline-offset: -2px;
}
/* A group header is a row that is also a heading: it toggles, it does not navigate,
   so it reads as a label rather than as a folder. */
.dsh_atlas_pickerGroup {
  margin-top: 2px;
  font-weight: 600;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
}
.dsh_atlas_pickerTag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.18));
  font-size: 11px;
  opacity: 0.75;
}
.dsh_atlas_pickerKeys {
  margin: 0;
  padding: 2px 14px 6px;
  font-size: 11px;
  opacity: 0.6;
}
.dsh_atlas_pickerGlyph {
  display: inline-flex;
  flex: none;
  align-items: center;
}
.dsh_atlas_pickerName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The absolute path, trailing and dimmed: it is what distinguishes two folders with
   the same name, so it may not push the name out of the row. */
.dsh_atlas_pickerHint {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-size: 12px;
}
.dsh_atlas_pickerChevron {
  flex: none;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
}
.dsh_atlas_pickerNote {
  margin: 6px 16px;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-size: 12px;
}
.dsh_atlas_pickerNewRow {
  display: flex;
  gap: 6px;
  padding: 0 16px 8px;
}
.dsh_atlas_pickerInput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
  font: inherit;
}
.dsh_atlas_pickerFoot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25));
}
.dsh_atlas_pickerButton {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35));
  border-radius: 7px;
  background: none !important;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 4px 10px;
}
.dsh_atlas_pickerButton:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16)) !important;
}
.dsh_atlas_pickerButton:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh_atlas_pickerIconButton {
  border: none;
  background: none !important;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  cursor: pointer;
  font: inherit;
  padding: 2px 6px;
  border-radius: 6px;
}
.dsh_atlas_pickerIconButton:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16)) !important;
}
.dsh_atlas_pickerPrimary {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary, #5686fe) !important;
  color: #fff;
}
.dsh_atlas_pickerToggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, #9aa4b2);
  font-size: 12px;
}
.dsh_atlas_pickerSpacer {
  flex: 1 1 auto;
}
/* ---- History jump (F2 roaming, F1 palette) ---------------------------------
   Roaming is deliberately quiet: it steps the conversation back a little and
   lifts the frame the cursor is on, so the user sees WHERE they are without the
   page moving. The state arrives as attributes on <html>, which keeps the
   painting out of the component and lets a test assert it without class names. */
html[data-atlas-roaming] [data-conversation-scroll] {
  opacity: 0.72;
  transition: opacity 140ms ease-out;
}
html[data-atlas-roaming] [data-composer-card] {
  /* The composer keeps full weight: the draft is still what is being edited. */
  opacity: 1;
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, transparent);
}
html[data-atlas-roaming] [data-atlas-frame-hit] {
  /* The cursor's frame: a band plus a left rule, readable in both themes. */
  position: relative;
  opacity: 1;
  background: var(--dsw-alias-bg-layer-2, transparent);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, transparent);
}
html[data-atlas-roaming] [data-atlas-frame-hit]::before {
  content: '';
  position: absolute;
  inset-block: 6px;
  inset-inline-start: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary, currentColor);
}
/* The readout naming the frame the cursor is on.
   It renders in the conversation.input.dock slot, NOT as a floating overlay, so it is a
   normal flex row of the composer stack: the stack is a column with a gap, which
   is what makes it stack with the goal and todo docks instead of covering them.
   The old position: fixed + measured-left/width + bottom: 96px arrangement existed
   only because the overlay had no ancestor to take those from.

   TWO boxes, matching the framework's own dock cards (GoalBar's .dock > .bar,
   TodoPanel's .root): an OUTER spacer that insets the row from the stack, and an
   INNER surface that is the visible card. Both halves are needed and the split is
   load-bearing, because the two boxes have different widths:
     - the outer width insets by 2 x clearance + 4 x inset from the STACK;
     - the inner max-width caps by card-max-width - 4 x inset, i.e. to the CARD.
   The inner cap is the half that is easy to miss and was missed here first: the
   stack is as wide as the conversation COLUMN, while the input card inside it is
   capped at --dsh-composer-card-max-width and merely centred. So on a wide window
   the stack is much wider than the card (measured live: stack 1390px, card 928px),
   and a row carrying only the outer width came out 1334px — overhanging the card
   by roughly 200px on each side, which is exactly the overflowing-the-chat-box
   symptom the user reported when this was a fixed overlay. Taking the numbers from
   the variables the framework publishes is what keeps the row aligned with where
   the framework puts its own docks, at every window width, without measuring. */
.dsh_atlas_roamBar {
  box-sizing: border-box;
  /* The outer spacer is the dock's own inset rule, verbatim from GoalBar.module.css
     .dock: 2 x clearance + 4 x inset off the stack. It is deliberately NOT capped —
     the cap lives on the inner surface, which is what lets the visible card be
     narrower than the row without the row's centring moving. */
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  margin: 0 auto;
}
/* The visible card. Every value here is the framework's own dock-card recipe
   (GoalBar.module.css .bar), not an approximation of it, so the strip reads as a
   sibling of the goal and todo cards rather than as a plugin-drawn lookalike:
   same 0.5px l1 hairline, same 12px radius, same --dsw-specific-tip surface, same
   36px height and 4px/12px padding. The earlier version invented its own
   (999px pill, --dsw-alias-bg-layer-2, a drop shadow, an em-based font size),
   which is why it did not match — those tokens are a different rung of the same
   palette. */
.dsh_atlas_roamBarInner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  height: 36px;
  margin: 0 auto;
  padding: 4px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-specific-tip);
  /* Inherit the chat column's own type so the strip matches the conversation it
     annotates; the fallback only applies in a shell that sets no font at all. */
  font: inherit;
  color: var(--dsw-alias-label-primary-dimmed);
}
/* The card's leading label, at the family's title metrics (13/24 medium) so the
   three composer-stack cards share one typographic register. */
.dsh_atlas_roamBarTag {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh_atlas_roamBarCount {
  flex: none;
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary-dimmed);
}
/* A-20: names the origin of a system-initiated turn. flex: none like the other
   labels, so it never squeezes the message text out of the row. */
.dsh_atlas_roamBarOrigin {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary-dimmed);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh_atlas_roamBarText {
  /* Takes the leftover room and gives it up first: the position and the label
     are the parts that must stay readable. */
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary-dimmed);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A hairline between the position readout and the preview, drawn with the same
   border token the card's own edge uses so it reads as part of the surface. */
.dsh_atlas_roamBarSep {
  flex: none;
  width: 0.5px;
  height: 16px;
  background: var(--dsw-alias-border-l1);
}
/* A-05's edge notice: the walk stopped at the oldest LOADED frame. Muted, and it
   never wraps the readout onto a second line — the card is a glanceable strip. */
.dsh_atlas_roamBarEdge {
  flex: none;
  overflow: hidden;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* F1 — the history palette. A centred dialog above the composer. */
.dsh_atlas_paletteLayer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
}
.dsh_atlas_paletteBackdrop {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 32%);
}
.dsh_atlas_palette {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 42rem;
  max-height: min(70vh, 32rem);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  border-radius: 12px;
  /* Opaque on purpose: this dialog floats OVER the transcript, and a themed
     surface that resolved to transparent (there is no bg-elevated token in this
     shell) let the conversation read through the rows. Same surface as the
     roaming bar so the two history surfaces match. */
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-layer-1, #1b1f2a));
  backdrop-filter: blur(1px);
  box-shadow: 0 16px 48px rgb(0 0 0 / 32%);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh_atlas_paletteHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #9aa4b2);
}
.dsh_atlas_paletteTitle {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh_atlas_paletteCount {
  font-variant-numeric: tabular-nums;
}
.dsh_atlas_paletteFilter {
  margin: 0 14px 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  font: inherit;
}
.dsh_atlas_paletteList {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0 6px;
  list-style: none;
}
.dsh_atlas_paletteRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh_atlas_paletteRow[data-atlas-history-active] {
  background: var(--dsw-alias-bg-layer-2, rgb(127 127 127 / 14%));
}
.dsh_atlas_paletteRowText {
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh_atlas_paletteRowAnswer {
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #9aa4b2);
}
.dsh_atlas_paletteTag {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-tertiary, #9aa4b2);
  font-size: 11px;
}
.dsh_atlas_paletteEmpty {
  padding: 24px 14px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #9aa4b2);
}
.dsh_atlas_paletteFoot {
  padding: 8px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, transparent);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #9aa4b2);
}
`

/**
 * Inject the dock stylesheet once (stable id; HMR-safe).
 */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Mark ownership explicitly so DSH client HMR cannot attribute this tag to
  // whichever plugin happens to materialize after dsh-atlas.
  style.dataset.plugin = 'dsh-atlas'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = cssText
  document.head.appendChild(style)
}