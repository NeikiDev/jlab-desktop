# Linux builds (.deb, .rpm, AppImage)

**Priority:** Medium
**Category:** Other
**Effort:** M

## Goal
Ship Linux desktop bundles alongside macOS and Windows. Cover the most common GUI distros: Debian/Ubuntu (`.deb`), Fedora/RHEL/openSUSE (`.rpm`), and a universal `AppImage` for everyone else. Tauri 2 already supports all three; the work is mostly CI plus config.

## Tasks
- [ ] Add `linux` target to `tauri.conf.json` `bundle.targets` (`deb`, `rpm`, `appimage`)
- [ ] Verify Linux prereqs build locally in a container (webkit2gtk, libayatana-appindicator, librsvg, etc.)
- [ ] Extend `.github/workflows/ci.yml` matrix with `ubuntu-latest` for `tauri build --debug` smoke
- [ ] Extend `.github/workflows/release.yml` to build on `ubuntu-latest` and attach `.deb`, `.rpm`, `.AppImage` to the GitHub Release
- [ ] Confirm signed updater manifest covers Linux targets too (or document that it doesn't)
- [ ] Test install + launch on Ubuntu, Fedora, and via AppImage on a third distro
- [ ] Update README install section with Linux instructions
