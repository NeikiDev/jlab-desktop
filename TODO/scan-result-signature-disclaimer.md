# Add "matches are not a verdict" disclaimer to scan results

**Priority:** Medium
**Category:** Frontend
**Effort:** S

## Goal

Make it clear in the result view that signature hits are not a final
malware verdict. Today the result page shows severity counts and a list
of matched signatures, which can read as "this file is malware". A short,
visible disclaimer near the result header should say the literal sentence
"Signature matches alone are not a final file verdict." so a user does
not act on a single hit without thinking.

## Tasks

- [ ] Decide placement: inside the file-metadata header in `SignatureList.tsx`, or as a row above the severity counts. Header row keeps it visible without pushing matches below the fold.
- [ ] Add the line "Signature matches alone are not a final file verdict." with a soft info style (muted text + a small info icon, no severity color so it does not compete with the critical/high counts).
- [ ] Show the disclaimer on every result, including the zero-match case where it matters most.
- [ ] Honor `prefers-reduced-motion`: no animation on the icon. Reuse existing tokens from `src/index.css`, no per-component `<style>` block.
- [ ] Run `npm run check` and eyeball in `npm run tauri dev` against a fixture with and without matches.
