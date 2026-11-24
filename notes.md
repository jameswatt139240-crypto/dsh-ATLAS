
### Added

- `@in:` — declare a folder in the draft (`@in:/data/reports/`) and search it
  **recursively** from then on (`@in:q3`), three levels deep, files and sub-folders
  alike. A trailing separator means "this folder"; without it the last segment is the
  query, so `@in:/data/reports/q3` goes straight there. Declaring a folder also hands
  it to the host ledger, so it is an out-of-workspace folder everywhere else too.
- The recursive search is a category of its own because the **plain** `@` menu belongs
  to the harness's file picker once its index is warm: it discards the rows a plugin
  source answers with (verified live three ways — full answer, one-row answer, and a
  synchronous answer all rendered as the harness's own list). A category we own is the
  only surface where these rows are guaranteed to render.

