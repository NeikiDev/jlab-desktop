# Security Policy

Thanks for taking the time to look at this carefully. This document explains how to report a security issue and what to expect after you do.

## Supported versions

Only the latest published release receives security fixes. Older versions are not patched. Please update before reporting.

| Version       | Supported |
| ------------- | --------- |
| Latest stable | Yes       |
| Older stable  | No        |
| Pre-release   | No        |

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public GitHub issue.

You have two options. Either is fine.

1. **GitHub Security Advisory (preferred).** Open a private advisory at
   <https://github.com/NeikiDev/jlab-desktop/security/advisories/new>.
   GitHub keeps it private until we publish.
2. **Email.** Send a report to `neikianalytics@gmail.com`. Use a clear
   subject line, for example `JLab Desktop security report`. PGP is not
   currently set up.

Please include:

- A short description of the issue and its impact.
- Steps to reproduce, or a proof of concept if you have one.
- The affected version (from the title bar or `package.json`).
- Your operating system and version.
- Whether you would like to be credited, and if so, how.

## What to expect

- Acknowledgement within 72 hours.
- A first assessment within 7 days.
- A fix or a clear plan within 30 days for high or critical issues. Lower
  severity issues may take longer.
- Coordinated disclosure. The advisory and the fix release land together
  unless you ask for something different.

## Scope

In scope:

- The desktop client in this repository (`src/`, `src-tauri/`).
- The build pipeline (`.github/workflows/`).
- The auto-updater feed served from GitHub Releases.

Out of scope:

- The public JLab API itself (`https://jlab.threat.rip`). Report API
  issues to the JLab project, not here.
- Issues that require physical access to a machine the attacker already
  controls.
- Social-engineering, phishing, or denial-of-service against shared
  infrastructure.
- Findings that depend on a user installing a modified build from an
  untrusted source.

## Bounty

There is no bug bounty program. We can credit you in the release notes if
you want.

## Signing keys

Builds are not yet signed with platform code-signing certificates.
Updates are manual today: the app links to the latest GitHub release
page and the user runs the installer themselves. There is no in-app
auto-updater and no Tauri updater signing keypair in use.

When the in-app updater is wired up, the public key will be checked
into `src-tauri/tauri.conf.json` and the private key will live in the
GitHub Actions secret store. Rotations will be announced in the release
notes for the affected version.

## Hardening already in place

For context, here is what the client does to limit blast radius:

- The HTTP upload runs in Rust. The webview cannot make network calls
  (`connect-src ipc:` in the CSP).
- File size and zip-magic are validated before any network call.
- Inner-jar size is checked against 50 MB before extraction, which guards
  against zip bombs.
- The client only opens URLs on a small allowlist of `threat.rip` hosts.
- The Tauri capability set grants only what the UI uses (dialog, log,
  window, internal devtools toggle).
