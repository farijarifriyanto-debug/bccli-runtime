// The runtime modules every BCCLI package must ship.
//
// Both packers copy the same engine-facing source out of candidate/, so the
// list lives in one place: a module added to the CLI but forgotten here ships a
// package that cannot start. candidate/test/release-manifest.test.mjs walks the
// imports from cli.mjs and fails if this list ever falls behind.
//
// apply-patch-tool.mjs, atomic-patch.mjs and web-search-tool.mjs are listed
// explicitly because the branded engine loads them by name at runtime, so no
// static import reaches them.
export const RUNTIME_FILES = Object.freeze([
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'cli.mjs',
  'session-settings.mjs',
  'core.mjs',
  'proxy.mjs',
  'openai-responses.mjs',
  'gateway.mjs',
  'branding.mjs',
  'credentials.mjs',
  'dialog-models.mjs',
  'model-dialog.mjs',
  'providers.mjs',
  'provider-cli.mjs',
  'startup-menu.mjs',
  'legacy-compat.mjs',
  'provider-command.mjs',
  'native-key-dialog.mjs',
  'provider-dialog.mjs',
  'atomic-patch.mjs',
  'apply-patch-tool.mjs',
  'web-search-backend.mjs',
  'web-search-tool.mjs',
])
