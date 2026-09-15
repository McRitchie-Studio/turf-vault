# TurfVault Docs

Use this index before following any operational instruction in this directory.

## Live References

| Need | File |
|------|------|
| Current program IDs, signer set, upgrade authority, IDL hash | [`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md) |
| Rotating the vault signer set (v0.26, five slots) | [`SIGNER_ROTATION.md`](SIGNER_ROTATION.md) |
| Current instruction proof checklist | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |
| What each CI lane verifies, and what none of them does | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |

`CURRENT_DEPLOYMENT.md` is the source of truth for live program identity. Do not infer live devnet/mainnet facts from historical specs, audits, generated reports, or old Claude context.

## Historical References

| File | Status |
|------|--------|
| [`MAINNET_LAUNCH.md`](MAINNET_LAUNCH.md) | Historical first-deploy runbook. Do not use as live deployment identity. |
| [`KEY_ROTATION.md`](KEY_ROTATION.md) | Historical superseded redeploy/key-rotation plan for the retired Alex Bot key. Do not execute as current signer-rotation procedure — that is [`SIGNER_ROTATION.md`](SIGNER_ROTATION.md). |
| [`v0.16-spec.md`](v0.16-spec.md) | Historical architecture/spec baseline for the self-custody rewrite. |
| [`SECURITY_AUDIT_2026_05_31.md`](SECURITY_AUDIT_2026_05_31.md) | Historical companion audit. Some findings are fixed in current code; verify against source and `CURRENT_DEPLOYMENT.md`. |
| [`turf-vault-deploy-cost.html`](turf-vault-deploy-cost.html) | Historical generated deployment-cost map. Use for cost intuition, not live instruction names or current authority facts. |

## Agent Rules

- Keep new live deployment facts in `CURRENT_DEPLOYMENT.md`.
- Keep cross-repo setup, credentials, ports, and agent workflows in `mcritchie-studio/docs/agents/`.
- Add date/status banners to historical docs that could otherwise be mistaken for current runbooks.
- A `VERIFICATION_MATRIX.md` row is machine-verified only where a RUN reached it. Since 2026-09-15 the **Anchor Suite** workflow (`.github/workflows/anchor-suite.yml`) executes `tests/turf_vault.ts` against a validator — on program/suite PRs, on pushes to `accepted`/`release`/`main`, daily on `main`, and on demand — so prefer that run for the head you are holding over the dated stamp in the matrix, which records a TREE and not `HEAD`. The lane is PATH-FILTERED and builds the DEFAULT feature set, so it says nothing about a change outside `programs/**`/`tests/**` and nothing about the mainnet-featured binary. Current stamp: `45 passing`, 2026-09-15. Before authorizing a Squads upgrade, read [What the Suite Evidences](VERIFICATION_MATRIX.md#what-the-suite-evidences).
