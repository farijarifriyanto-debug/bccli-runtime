# BCCLI 0.5.7 - OpenAI model compatibility, provider diagnostics, quota fast-fail

Changes since 0.5.6:
- Requests routed to OpenAI's own inference endpoint now carry the modern
  output-limit parameter instead of the legacy one, so the 18 current OpenAI
  models that reject the legacy name with a 400 work again. Scoped by
  destination endpoint: the BotConnector gateway, Kimi's route, and every
  other OpenAI-compatible provider keep exactly the parameter they receive
  today. The output ceiling policy is unchanged (bounded, never increased,
  never invented, caller object never mutated).
- Tools + reasoning rejection ("Function tools with reasoning_effort are not
  supported ... in /v1/chat/completions") is retried once with an explicit
  reasoning_effort 'none'; 10 of the 12 affected models recover. If the retry
  fails for an unrelated reason the original error is forwarded unchanged.
- Responses-only models (gpt-5.x/6.x pro, gpt-5.3-codex, gpt-6-astra,
  gpt-6.1-sol) are bridged: on the captured upstream refusal texts the proxy
  translates chat.completions <-> /v1/responses (SSE and non-stream), with
  store:false and a per-proxy-instance route cache so later turns skip the
  refused chat round trip. Bridge translation covers text, tool calls and the
  full tool-result loop.
- Model-unavailable errors now name the active provider (previously always
  "BotConnector", even when e.g. gmicloud was active).
- Hard weekly/monthly usage-limit 429s (e.g. Ollama Cloud's "reached your
  weekly usage limit") now fast-fail with the engine's quota-exhausted
  guidance instead of retrying 10x60s for 10+ minutes. Implemented through
  the hash-pinned branding patch; transient per-minute rate limits keep the
  normal retry behavior.
- Packaging: the Responses bridge module is enumerated in both the preview
  and production packaging manifests; the published tarball imports cleanly
  (the bundled-artifact verify job enforces this on 3 OS x Node 22/24).

Test and release gates:
- Candidate suite: 180 tests / 178 pass / 1 skipped / 1 pre-existing
  environment failure (cli-offline-smoke, Windows Node 24.18.0 guard on the
  test machine; present before these changes).
- New tests: 11 Responses-translation unit tests (fixtures are verbatim live
  captures), 7 bridge wire tests including a full tool loop, the branding
  quota-classifier test, and provider-named selectModel assertions.
- Real-provider E2E on a Windows install patched byte-identical to the
  branch: OpenAI gpt-6-luna / gpt-5-mini / gpt-6-astra (incl. bridged tool
  loop) / gpt-5.2-pro / gpt-5.3-codex / gpt-6.1-sol; botconnector gateway
  agnes-3.0-flash; gmicloud Qwen3.8-Max; deepseek deepseek-flash; mistral
  codestral-latest; openrouter particle-ai/particle-1. groq free-tier TPM
  and nvidia shared-catalog 404/410 are provider/account limits, proven by
  direct probes that bypass BCCLI.
- Quota fast-fail E2E: the ollama-cloud weekly-limit run exits in ~55s with
  "Quota exhausted: ... weekly usage limit ..." (before: still retrying when
  killed at 600s).
- Engine unchanged: @qwen-code/qwen-code@0.26.3, BRAND_REVISION bumped to v20
  so a previously branded cache is rebuilt.
- New version 0.5.7 is distinct from immutable 0.5.6. GitHub release and npm
  publication remain separate manual steps.
