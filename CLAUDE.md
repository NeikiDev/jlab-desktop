# CLAUDE.md

Notes for Claude (and humans) working on this repo.

## What this is

Cross-platform (macOS, Windows, Linux) desktop client for the public **JLab static
JAR scanner** at `https://jlab.threat.rip/api/public/static-scan`. User drops
a `.jar` (or a `.zip` / `.mcpack` / `.mrpack` containing one), the app
uploads it as `multipart/form-data`, and renders the matched signatures
grouped by severity. For container drops, the Rust side opens the archive,
picks the largest inner `.jar`, and uploads only that file.

Open-source, dual-licensed **MIT OR Apache-2.0**. Repo:
`https://github.com/NeikiDev/jlab-desktop`.

## Stack

- **Shell:** Tauri 2 (Rust)
- **Frontend:** React 19 + TypeScript + Vite, styled with Tailwind v4 (tokens defined in `@theme` inside `src/index.css`, wired up via `@tailwindcss/vite`, no `tailwind.config.js`, no PostCSS config)
- **HTTP:** `reqwest` 0.12 with `multipart` + `rustls-tls` (no OpenSSL)
- **Async runtime:** `tokio`
- **Errors:** `thiserror` + `serde(tag = "kind")` so the frontend can discriminate

The HTTP upload runs in **Rust**, never in the webview. File bytes don't
cross the IPC boundary as JSON. The frontend only passes the file path.

## Layout

```
src/                    React frontend
  main.tsx              createRoot mount, imports ./index.css
  App.tsx               State machine (idle | scanning | result | error)
                        plus the inline idle landing (hero, dropzone, steps)
  index.css             Tailwind v4 entry + @theme tokens (dark only),
                        keyframes, prefers-reduced-motion override
  lib/
    api.ts              invoke() wrappers + AppError type guards
    types.ts            Mirror of the API JSON schema
    cn.ts               Six-line className concat helper
    components/         DropZone, ScanProgress, SignatureList,
                        SignatureCard, SeverityBadge, ErrorBanner,
                        RemoteStatus, FamilyAlert
src-tauri/              Rust shell
  src/
    main.rs             Thin entry; calls lib::run()
    lib.rs              tauri::Builder, plugin + command registration
    api.rs              scan_jar, check_status, open_url commands
    error.rs            AppError enum (tagged, serializable)
  capabilities/         Tauri 2 permission scopes
  tauri.conf.json       Bundle config (DMG/APP/MSI/NSIS), CSP, window
TODO/                   Tracked via /todo skill
```

**UI states (driven by `App.tsx`'s `ScanState`):**
- `idle`: hero copy, drop zone, three step cards. The marketing surface.
- `scanning`: `ScanProgress` with elapsed counter, phase list, rotating tip.
- `result`: `SignatureList` (file metadata header, severity counts, grouped signature cards).
- `error`: `ErrorBanner` above the drop zone so retry is one click away.

**Default window:** `1180 x 780`, min `760 x 540`, centered on first launch (set in `tauri.conf.json`). Don't shrink defaults below this without a reason. The result view needs room for five severity columns.

## Toolchain requirements

- **Rust ≥ 1.85** (edition2024 stable). `rust-version = "1.85"` is pinned in `src-tauri/Cargo.toml`.
- **Node 20+** (CI uses 20).
- **Tauri 2 platform prereqs:** <https://tauri.app/start/prerequisites/>.

## Common commands

```bash
npm install
npm run tauri dev              # dev with hot reload
npm run tauri build            # release bundle for current OS
npm run check                  # tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Icons (one-time, after replacing the placeholder):

```bash
npm run tauri icon path/to/source-1024.png
```

## API contract

Single endpoint, no auth, public. Documented at <https://jlab.threat.rip/api-docs.html>.

```
POST https://jlab.threat.rip/api/public/static-scan
Content-Type: multipart/form-data
Field:        file (≤ 50 MB, .jar)
Rate limit:   15 requests / minute / IP
```

The endpoint only accepts a single `.jar`. The desktop client accepts a
broader set of inputs and unwraps containers locally before upload.

**Accepted local inputs (`src-tauri/src/api.rs`):**

| Extension | Handling                                                        |
|-----------|-----------------------------------------------------------------|
| `.jar`    | uploaded as-is                                                  |
| `.zip`    | opened locally, largest inner `.jar` is extracted and uploaded  |
| `.mcpack` | same as `.zip`                                                  |
| `.mrpack` | same as `.zip`                                                  |
| other     | rejected with `AppError::UnsupportedFile`                       |

**Container handling rules:**

- Magic-byte check: every accepted input must start with a `PK` zip
  signature. Renamed text files are rejected with `UnsupportedFile`.
- Multi-jar archives: the **largest inner `.jar` by uncompressed size** is
  picked. Rationale: in modpacks the largest jar is almost always the
  payload while bundled libraries already have their own signatures, and
  the API is single-file + 15 req / minute, so scanning every jar is not
  practical. Document any change to this policy.
- Inner jar size limit: the extracted inner `.jar` itself must be ≤ 50 MB.
  This is what guards against zip bombs (the entry's uncompressed `size()`
  is checked before extraction).
- Empty archives or archives without any `.jar` entry produce
  `AppError::NoJarInArchive`.

Status mapping in `src-tauri/src/api.rs`:

| Status | Maps to                                       |
|--------|-----------------------------------------------|
| 200    | `ScanResult` (success)                        |
| 413    | `AppError::TooLarge { max_mb: 50 }`           |
| 429    | `AppError::RateLimited { retry_after_seconds }` (parses `Retry-After`) |
| other  | `AppError::Server { status, message }`        |

Local 50 MB check happens **before** the network call to avoid wasted upload.

## Domain model

Anything below is what the JLab API actually returns today. Frontend types in `src/lib/types.ts` and Rust types in `src-tauri/src/api.rs` mirror this. Keep them in sync.

**Severity scale (ordered, most to least severe):**

```
critical | high | medium | low | info
```

All five render. UI order in `SignatureList.tsx` matches this list. Unknown values fall back to `info`.

**Signature `type` ↔ `kind` rename:**
The API uses the JSON field name `type` per signature. Rust deserializes it via `#[serde(rename = "type")] kind: String` so the field becomes `kind` everywhere downstream (Rust struct, IPC payload, frontend). When extending, keep the rename. Don't propagate `type` past the API boundary, since it shadows the keyword in TS.

Known `kind` values today: `reference`, `string`, `heuristic`, `bytecode`, `structure`, `structural`, `file`, `deobfuscation`. New values must be added to `SignatureKind` in `types.ts` so TS narrowing keeps working.

**Signature match shape:**
A match has four optional fields. Any combination can appear, all four can be null.

```ts
{
  className?:    string | null   // e.g. "net/fabricmc/.../EventFactoryImpl"
  member?:       string | null   // method signature with descriptor
  path?:         string | null   // archive path, may contain "!/" for nested JARs
  matchedValue?: string | null   // the literal that matched (snippet, descriptor, note)
}
```

`SignatureCard.tsx` filters out matches where all four are null, then renders each remaining field row by row. When the API adds another field, extend the filter and the renderer; do not silently drop it.

## Design rules

- **Tauri commands.** Defined in `src-tauri/src/api.rs`, registered in
  `src-tauri/src/lib.rs` (`invoke_handler` block). Today they cover
  scanning (`scan_jar`, `cancel_scan`), service status (`check_status`,
  `check_for_update`, `app_version`), URL opening (`open_url`), log
  management (`open_log_dir`, `clear_logs`, `log_dir_size`), and local
  history (`history_list`, `history_clear`, `history_delete`). Add new
  commands sparingly; prefer extending an existing flow.
- **Outbound HTTP must send `x-jlab-client: desktop`.** Both `scan_jar` and `check_status` set it. Any future request to `jlab.threat.rip` must do the same.
- **Errors are typed, not strings.** Always extend `AppError` (with a new `#[serde(rename_all = "snake_case")]` variant) and the matching union in `src/lib/types.ts`. Never return raw `String` errors to the frontend. The `ErrorBanner` component switches on `kind`.
- **The frontend doesn't talk HTTP.** All network traffic goes through Rust. CSP is restrictive (`connect-src ipc:` only). Adding `fetch()` calls in the React code will be blocked.
- **React functional components with hooks only.** No class components. Use `useState`, `useReducer`, `useMemo`, `useEffect`, `useRef`, `useCallback`. The `react-jsx` runtime is on, so no `import React` is needed in `.tsx` files. Do not enable `<StrictMode>` in `main.tsx` (the Tauri drag-drop listener and the `RemoteStatus` polling are designed for single-registration; StrictMode's dev double-mount would duplicate them).
- **State machine is the source of truth.** `App.tsx`'s `ScanState` discriminated union drives everything via `useReducer`. Don't add side-state for "scanning AND error simultaneously". Encode it as a new variant if needed.
- **Tailwind v4, tokens in `src/index.css` `@theme`.** No `tailwind.config.js`, no `postcss.config.js`. Compose utility classes; use `var(--token)` only when bracket syntax preserves an exact value (animations, exact radii). Do not write per-component `<style>` blocks: React has no scoped CSS, and one-offs should land in `src/index.css` with a clearly-named class.
- **Drag-drop must use the Tauri webview event.** `getCurrentWebview().onDragDropEvent()` is the only path that delivers native file paths on macOS, Windows, and Linux (webkit2gtk). JSX `onDragOver`/`onDrop` will not work for native drops. Do not "simplify" the listener pattern in `DropZone.tsx`.

## Performance

Always optimize the frontend AND the Rust backend for a fast and smooth user experience. The desktop app should feel instant, never janky.

**Frontend (React / CSS):**
- Animate only `transform` and `opacity`. Never animate `width`, `height`, `top`, or `left`.
- Use the easing tokens from `index.css` (`--ease-out`, `--ease-in-out`, `--duration-fast`, `--duration-base`, `--duration-slow`) and the named animations (`animate-fade-in`, `animate-slide-in`, `animate-spin-fast`, `animate-indeterminate`, `animate-pulse-soft`, `animate-status-pulse`). Don't hand-write durations or `ease` curves in components.
- Add `content-visibility: auto` with `contain-intrinsic-size` to repeated cards in long lists (see `SignatureCard.tsx`).
- Use `will-change` only on elements that animate on hover or open, not persistently.
- Honor `@media (prefers-reduced-motion: reduce)`. The global override is in `index.css`. Don't add component-level animations that bypass it.
- Use stable `key={item.id}` on every `.map(...)`. Avoid index keys when items reorder.
- Keep `useMemo` cheap, and use it only when the derivation is non-trivial. If a derivation iterates the full list, do it once at the top of the component, not per child.
- Don't ship debug logs, polling timers, or `setInterval` work in idle states. Tear them down in the `useEffect` cleanup function.

**Rust backend (Tauri commands):**
- Stream and read files in chunks. Don't `std::fs::read` an entire 50 MB blob into memory if it can be avoided.
- Run blocking work on `tokio::task::spawn_blocking`. The Tauri command should never block the IPC thread.
- Reuse the `reqwest::Client`. Build it once in `lib.rs` and store it in app state. Never construct a fresh client per request.
- Set tight timeouts on every outbound request. No request should hang the UI forever.
- Return early on validation (file size, extension) before any network call.
- Errors must be typed (`AppError`) so the frontend renders without parsing strings.

## Writing style

When you write text that lands in the codebase (UI copy, comments, docs, commit messages, PR descriptions, README, CLAUDE.md), and when you reply to the user:

- **No em dashes.** Never use `—` or `–`. Use a period, a comma, a colon, or parentheses instead. Rewrite the sentence if needed.
- **Easy language.** Prefer short, plain words and short sentences. Avoid jargon when a normal word works. Don't pile clauses; split into two sentences.
- Write for someone scanning the screen, not reading a paragraph.
- One idea per sentence. Cut hedge words ("just", "simply", "basically", "actually").
- Active voice, present tense, second person where it fits.

## Things to deliberately NOT add

- Auth / login (API is public).
- Telemetry of any kind.

## Local history

Past scans are persisted on the user's device, no network involved.

- File: `history.json` in the Tauri app data dir (`AppHandle::path().app_data_dir()`,
  resolved once at startup and stored in app state as `HistoryStore`).
- Schema: `{ version: 1, entries: HistoryEntry[] }`. An entry holds `id`,
  `scannedAt` (ISO 8601 UTC), `fileName`, `fileSizeBytes`, `sha256`,
  `severityCounts`, `topSeverity`, and `signatureCount`. Mirrored in
  `src/lib/types.ts`.
- Cap: `HISTORY_CAP = 100` (in `src-tauri/src/history.rs`). On overflow the
  oldest entries are dropped during `append`.
- Writes are atomic (write to `history.json.tmp`, then rename). All file IO
  runs on `tokio::task::spawn_blocking`.
- No raw signature payload, no file bytes, and no API response body is
  stored. Only the small summary above.
- Append happens after a successful 200 from the scan endpoint. If history
  IO fails the scan still succeeds; the failure is logged.

## CI

- `.github/workflows/ci.yml` runs on every PR and on push to `dev`. Matrix
  on macOS, Windows, and `ubuntu-24.04`: `npm run check`, `cargo fmt
  --check`, `cargo clippy -- -D warnings`, `cargo check`, plus a `tauri
  build --debug` smoke job and a `gitleaks` scan. The Ubuntu jobs install
  Tauri's apt prereqs (`libwebkit2gtk-4.1-dev`, `libssl-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `file`,
  `libfuse2t64`).
- `.github/workflows/release.yml` triggers on push to `main` and on
  `workflow_dispatch`. The version-gate job reads
  `src-tauri/tauri.conf.json`. If the version is new (no matching `v*`
  tag), it builds macOS (`--target universal-apple-darwin`), Windows, and
  Linux (`ubuntu-24.04`), attaches `.dmg`, `.msi`, `.exe`, `.deb`, `.rpm`,
  and `.AppImage` to a GitHub Release, and tags `v<version>`. There is no
  signed updater manifest today (`bundle.createUpdaterArtifacts` is
  `false`); updates are manual via the Releases page.

## TODOs

Tracked under `TODO/` (see `TODO/README.md`). Use the `/todo` skill to add,
update, or implement TODOs. `/todo <id>` runs the autonomous fix flow.

## Git / GitHub

- Default remote: `origin → https://github.com/NeikiDev/jlab-desktop.git`.
- `gh repo set-default` is configured for this directory.
- Branch model: feature work on `dev` (or feature branches into `dev`),
  PRs target `main`, every merge to `main` ships a release.

## When in doubt

The API has no test endpoint. For offline iteration, mock by stubbing
`scan_jar` to return a fixture `ScanResult`.
