# BCCLI 0.5.8 — audit hardening: legacy environment scrub, complete notices

Changes since 0.5.7:

- The 0.4.17 compatibility CLI no longer inherits environment-based code
  injection or endpoint redirection: `NODE_OPTIONS`/`NODE_PATH` and
  `*_BASE_URL` / `API_BASE` / `*_ENDPOINT` variables are stripped from the
  delegated child environment. Provider API keys still flow through, because
  the 0.4.17 CLI authenticates from its own credential store and those
  variables; removing them would break headless use without improving
  security (the key is the user's own, talking to the same gateway).
- `THIRD_PARTY_NOTICES.md` now enumerates the vendored components: ripgrep
  (Unlicense OR MIT), tree-sitter and web-tree-sitter (MIT), OpenTUI core and
  native libraries (MIT), qwen-landlock-run (Apache-2.0, source shipped),
  KaTeX fonts (SIL OFL-1.1), and the legacy BCCLI 0.4.17 SDK (MIT). The
  stale "Candidate" title is gone.
- The offline smoke test now expects the Windows Node crash guard message on
  win32 Node 24.0–24.22.0 (the guard fires before the TTY check by design),
  so the suite is green on hosts running an affected Node.
- Release engineering: the stable artifact is now built by CI
  (`.github/workflows/bccli-release-artifact.yml`) — gated on the full
  candidate suites, built twice with identical sha256 required, clean-install
  smoke-tested, and attached to a draft GitHub release with the reference
  hash. Manual laptop builds are no longer part of the release path.

Test and release gates:
- Candidate suite on the change branch: 184 pass / 0 fail (includes the new
  legacyChildEnv scrub tests and the guard-aware offline smoke test).
- PR #42 CI: verify matrix 6/6 (3 OS x Node 22/24), windows-candidate 2/2,
  TUI parity snapshots and OpenTUI no-flicker gates pass.
- This is the first release whose artifact comes from the CI double-build
  workflow; the bccli repo publish job pins this commit and the CI sha256.
