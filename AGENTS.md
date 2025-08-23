inherit: true
override:
  - "Workflow"
  - "Definition of Done"
  - "Automation"

# Agent Instructions (MistralOCR)

- Workflow: Follow org Discovery Gate and /plan → /impl (TDD) → /review → /bench → /docs → /ready.
- DoD: ≥80% coverage (goal 95%), CI green, ruff/black clean, Bandit + pip-audit pass, CodeQL/Semgrep/gitleaks scans pass, CycloneDX SBOM generated on PRs.
- Versioning: Conventional Commits; semantic-release or Changesets for Node repos; Python may use python-semantic-release or tag-based semver with release notes.
- Merge queue: Prefer GitHub native merge queue with automerge label.

## Notes

- Keep API keys in local config only; never commit secrets.
- Use `pytest -m "not integration"` by default to avoid network in CI.
- Consider adding simple CLI smoke tests in CI (no network).



---

## Model Rate Limits

Please be aware that all cloud-based models (including Codex, Claude, Gemini, etc.) are subject to rate limits. If a model becomes unresponsive, it is likely that it has hit a rate limit. These limits will reset after a certain period of time.

The only model not subject to rate limits is the locally-run Ollama.
