# BCCLI — Third-party attribution

BCCLI (launcher, Gateway adapter, and branding overlay) is maintained for BotConnector by BICO Inovasi Digital.

This package bundles the following third-party components:

## Qwen Code (`@qwen-code/qwen-code@0.26.3`)

The upstream coding-agent engine, vendored **unmodified** in `engine/` under the **Apache License, Version 2.0** (see `engine/LICENSE`). Upstream source and notices: https://github.com/QwenLM/qwen-code.

At runtime BCCLI creates an isolated, pinned, SHA-256-verified copy of selected upstream compiled files to apply BotConnector terminal branding. This is a modified UI/runtime copy, not a claim of original authorship of the upstream engine. Keep relevant upstream copyright notices, the supplied LICENSE, and the dependency's own license/notice files when redistributing.

## Bundled with the upstream engine (`engine/`)

- **ripgrep** (`engine/vendor/ripgrep/`) — dual-licensed **Unlicense OR MIT**; see `engine/vendor/ripgrep/COPYING`. Upstream: https://github.com/BurntSushi/ripgrep.
- **tree-sitter** runtime and **web-tree-sitter** (`engine/vendor/tree-sitter/`, `engine/opentui-assets/web-tree-sitter/`) — **MIT**. Upstream: https://github.com/tree-sitter/tree-sitter.
- **tree-sitter language grammars** (bash, javascript, typescript, markdown, and others, shipped as `.wasm`) — each grammar carries its upstream license (MIT for the grammars listed); see the respective repositories under https://github.com/tree-sitter.
- **OpenTUI** core and native libraries (`engine/opentui-assets/@opentui/`) — **MIT**. Upstream: https://github.com/sst/opentui.
- **qwen-landlock-run** (`engine/vendor/landlock-run/`) — **Apache-2.0**, Copyright Qwen Team; source included at `engine/vendor/landlock-run/src/`.
- **KaTeX fonts** (`engine/web-shell/assets/`) — **SIL Open Font License 1.1**. Upstream: https://katex.org.

## BCCLI legacy SDK (`legacy/`)

The original BCCLI 0.4.17 CLI/SDK, Copyright (c) 2026 BotConnector, licensed under the **MIT License** (see `legacy/LICENSE`). Source: https://github.com/farijarifriyanto-debug/bccli.

---

The model producing an answer is the actual model selected via BotConnector Gateway; BCCLI is the client application, not the AI model. Vendor/source attribution is available under `/about credits` rather than forced into the AI's self-description.
