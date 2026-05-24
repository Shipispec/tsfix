# Security policy

## Supported versions

Active development is on the `0.6.x` line. We patch security issues on the latest minor.

| Version | Supported |
|---|---|
| 0.6.x (latest minor) | ✅ |
| 0.5.x and earlier | ❌ — upgrade to 0.6.x |

There is no LTS branch.

## Reporting a vulnerability

Please use **GitHub's private security-advisory flow**: <https://github.com/owgreen-dev/tsfix/security/advisories/new>

That gives us a private channel to triage and patch before disclosure. **Do not open a public issue or PR with a vulnerability report** — public disclosure before a fix is shipped puts every user at risk.

If GitHub advisories are unreachable for you, email the maintainer (see the `author` field in `package.json`) with `[tsfix-security]` in the subject. We'll respond within 5 business days.

## What's in scope

- A bug in tsfix that causes incorrect or unsafe code to be written to a workspace tsfix has been pointed at — including the Layer-2 LLM mend silencing a tsc error in a way that introduces a runtime security regression. (We invest in prompt-level anti-patterns precisely to make this class of bug rare; if you have a reproducer, that's exactly what this channel is for.)
- A bug that allows an attacker-controlled workspace to escape tsfix's documented trust boundary — e.g., executing code outside the workspace, exfiltrating environment variables that aren't the configured LLM provider's API key, or writing to paths outside `--workspace`.
- A supply-chain issue in tsfix's own bundle or in how it integrates the Vercel AI SDK / provider packages.

## What's NOT in scope

- **The trust boundary is the workspace.** tsfix loads `typescript` from the workspace's `node_modules` and runs it. If you point tsfix at an attacker-controlled workspace, you have already lost — this is equivalent to running `node_modules/.bin/tsc` against that workspace. Don't do that. See the [README's Trust model section](README.md#trust-model).
- **Layer 2 sends source files to the LLM provider you chose.** That is the documented behavior, not a vulnerability. If your code is sensitive, do not enable Layer 2.
- **Provider-side issues** (Anthropic / OpenAI / Google's API security, their data handling, etc.) — report those to the providers directly. tsfix passes prompts through; we don't operate the model.

## Coordinated disclosure

After we ship a fix:

1. We publish a GitHub Security Advisory describing the issue, affected versions, and the fix.
2. We credit the reporter (unless you prefer anonymity).
3. We publish a patched npm release.

Typical timeline from triage to fix: **1–7 days** for a clear reproducer; longer for ambiguous cases.

## Past advisories

None to date. (We'll list them here once any exist.)
