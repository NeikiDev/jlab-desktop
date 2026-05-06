# Sync API types with latest API and hide disclaimer when family is confirmed

**Priority:** Medium
**Category:** Other
**Effort:** S-M

## Goal

Two things:

1. Re-check the public scan API docs at <https://jlab.threat.rip/api-docs.html>
   and align the Rust types in `src-tauri/src/api.rs` and the TypeScript
   mirror in `src/lib/types.ts` with whatever changed (new fields, new
   `kind` values, new severity values, response shape tweaks). The
   contract section in `CLAUDE.md` may need updates too.
2. The signature warning box (`SignatureDisclaimer.tsx`) should only show
   when no malware family is confirmed. When `FamilyAlert` is rendered
   (one or more confirmed families), hide the disclaimer entirely. The
   "Exception" paragraph that currently changes copy based on
   `hasConfirmedFamily` becomes unreachable in the confirmed case, so
   simplify the component.

## Tasks

- [ ] Read the live API docs at <https://jlab.threat.rip/api-docs.html> and
      diff the response shape against `ScanResult` in
      `src-tauri/src/api.rs` and `src/lib/types.ts`
- [ ] Update Rust types in `src-tauri/src/api.rs` to match (preserve the
      `type` -> `kind` rename rule from CLAUDE.md)
- [ ] Update TS mirror in `src/lib/types.ts` (extend `SignatureKind` if
      new values appeared, add new severity values to the union if any)
- [ ] If a new signature match field appeared, extend the empty-match
      filter and the renderer in `SignatureCard.tsx`
- [ ] Update `CLAUDE.md` API contract section so it reflects the new
      shape (severity scale, `kind` values, match fields)
- [ ] Hide `SignatureDisclaimer` in `SignatureList.tsx` when
      `confirmedFamilies.length > 0` (only render when no family is
      confirmed)
- [ ] Simplify `SignatureDisclaimer.tsx`: drop the `hasConfirmedFamily`
      prop and the conditional "Exception" branch, keep only the
      no-confirmed-family copy
- [ ] Verify: `npm run check`, `cargo check`, `cargo clippy -- -D
      warnings`, `cargo fmt --check`, then `npm run tauri dev` and run
      one scan that produces a confirmed family and one that does not,
      to confirm the disclaimer shows only when no family is confirmed
