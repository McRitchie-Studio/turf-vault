# TurfVault Docs

Use this index before following any operational instruction in this directory.

## Live References

| Need | File |
|------|------|
| Current program IDs, signer set, upgrade authority, IDL hash | [`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md) |
| Current instruction proof checklist | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |
| What CI verifies, and what no lane verifies | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |

`CURRENT_DEPLOYMENT.md` is the source of truth for live program identity. Do not infer live devnet/mainnet facts from historical specs, audits, generated reports, or old Claude context.

## Historical References

| File | Status |
|------|--------|
| [`MAINNET_LAUNCH.md`](MAINNET_LAUNCH.md) | Historical first-deploy runbook. Do not use as live deployment identity. |
| [`KEY_ROTATION.md`](KEY_ROTATION.md) | Historical superseded redeploy/key-rotation plan for the retired Alex Bot key. Do not execute as current signer-rotation procedure. |
| [`v0.16-spec.md`](v0.16-spec.md) | Historical architecture/spec baseline for the self-custody rewrite. |
| [`SECURITY_AUDIT_2026_05_31.md`](SECURITY_AUDIT_2026_05_31.md) | Historical companion audit. Some findings are fixed in current code; verify against source and `CURRENT_DEPLOYMENT.md`. |
| [`turf-vault-deploy-cost.html`](turf-vault-deploy-cost.html) | Historical generated deployment-cost map. Use for cost intuition, not live instruction names or current authority facts. |

## Agent Rules

- Keep new live deployment facts in `CURRENT_DEPLOYMENT.md`.
- Keep cross-repo setup, credentials, ports, and agent workflows in `mcritchie-studio/docs/agents/`.
- Add date/status banners to historical docs that could otherwise be mistaken for current runbooks.
- Do not read a `VERIFICATION_MATRIX.md` row as machine-verified. No lane runs `tests/turf_vault.ts`, so every row rests on source review, or on a dated hand-run stamp that may predate the tree — and the current stamp does predate it (it was taken before turf-vault PR #18, and no run has followed). Before authorizing a Squads upgrade, read [What the Suite Evidences](VERIFICATION_MATRIX.md#what-the-suite-evidences): it names the three refusals the stamp actually evidences, and leaves every other row resting on source review.
