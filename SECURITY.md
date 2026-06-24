# Security

## API tokens

This plugin reads `process.env.ANTHROPIC_AUTH_TOKEN` to authenticate against the MiniMax `/v1/token_plan/remains` endpoint.

- The token is **only** used as a `Bearer` header for that single GET.
- The token is **never** logged, **never** written to stdout, **never** echoed in error messages, and **never** persisted to disk by this plugin.
- The bundled `dist/index.js` does not embed the token in any way.
- Plugin crash handlers (`uncaughtException`) emit upstream claude-hud output, never the token.

## Files that may contain secrets

- `.claude/settings.json` — contains your live `ANTHROPIC_AUTH_TOKEN`. **Excluded from git** via `.gitignore`. Do not commit.
- `~/.claude/settings.json` — your user-global Claude Code config. Not in this repo; edit it yourself or follow the README to install.
- `settings.example.json` — checked-in **template only**. Replace `<set-your-minimax-api-key>` before use.

## Reporting a vulnerability

Please open a GitHub issue with the `security` label, or contact the maintainer directly. Do not include your real token in bug reports.