# Download Progress Bar — Design Spec

**Date:** 2026-05-30  
**Status:** Approved

## Summary

Add a terminal progress bar to the updater's ZIP download step. The bar overwrites a single line as data arrives and shows filled/empty blocks plus a percentage.

## Output format

```
  Downloading... [████████████░░░░░░░░░░░░] 45%
```

- Bar is 24 characters wide using `█` (filled) and `░` (empty)
- Line is rewritten in-place with `\r` on each chunk
- A newline is printed when the download completes
- If `content-length` is absent, shows bytes received with no bar: `  Downloading... 12.1 MB`

## Changes to updater.js

**Add:** `downloadWithProgress(url, destPath, timeout)` — streams the ZIP to `destPath`, reads `content-length`, renders progress on each chunk, follows redirects.

**Remove:** the `get(ZIP_URL, 120000)` + `writeFileSync` block.

**Replace with:** `await downloadWithProgress(ZIP_URL, tmpZip, 120000)`

**No change to:** `get()` — still used as-is for the small version-check fetch.

## Error handling

- Timeout and network errors bubble up the same way as before; the caller's existing `catch` block handles them.
- If the response status is not 200 (after following redirects), reject with `HTTP <code>` as before.

## Scope

Single file: `app/updater.js`. No new dependencies.
