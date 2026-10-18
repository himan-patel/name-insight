# Contributing to NameInsight

Thanks for helping out! This guide covers the workflow and the few rules we're strict about.

## Getting set up

```bash
git clone https://github.com/himan-patel/name-insight.git
cd name-insight
npm install            # also installs the git hooks
npm run start-watch:tsnode
```

Optional but recommended: `brew install gitleaks` so the pre-commit hook can also scan staged changes with
gitleaks.

## Workflow

`main` is protected: every change goes through a pull request.

1. Branch from an up-to-date `main` using this naming format:

   ```text
   <feature|fix|chore|doc>/<super-short-description>
   ```

   | Type | Use for | Example |
   |---|---|---|
   | `feature` | new capability | `feature/rdap-lookup` |
   | `fix` | bug fix | `fix/whois-timeout` |
   | `chore` | tooling, dependencies, config, refactors | `chore/upgrade-deps` |
   | `doc` | documentation only | `doc/readme-mcp` |

2. Make your change, with tests for new behavior.
3. Run the checks locally:

   ```bash
   npm run lint && npm run typecheck && npm test && npm run secrets
   ```

4. Push and open a pull request against `main`. PRs are squash-merged, so write a clear PR title.

## Rules

- **Never commit secrets.** No API keys, tokens, passwords or private keys anywhere: code, tests, fixtures,
  docs, commit messages or PR descriptions. Configuration comes from environment variables; document new
  variables (names only, no values) in `.env.example`. The pre-commit hook and CI scan for secrets and will
  block the change. If a secret is ever committed, revoke it immediately: removing it from history is not
  enough.
- **Validate all external input** at the boundary, and never pass user input to a shell or subprocess
  argument without strict validation.
- **Don't probe private networks.** Any new outbound request must go through the existing public-address
  checks (see `app/core/validation.ts`).
- Keep the OpenAPI spec and README in sync with behavior changes.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please don't open public issues for vulnerabilities.
