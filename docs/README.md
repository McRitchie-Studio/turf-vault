# TurfVault Docs

Use this index before following any operational instruction in this directory.

## Live References

| Need | File |
|------|------|
| Current program IDs, signer set, upgrade authority, IDL hash | [`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md) |
| Rotating the vault signer set (v0.26, five slots) | [`SIGNER_ROTATION.md`](SIGNER_ROTATION.md) |
| Current instruction proof checklist | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |
| What CI verifies, and what no lane verifies | [`VERIFICATION_MATRIX.md`](VERIFICATION_MATRIX.md) |

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
- Do not read a `VERIFICATION_MATRIX.md` row as machine-verified. No lane runs `tests/turf_vault.ts`, so every row rests on source review or on a dated hand-run stamp that may predate the tree. The current stamp (`38 passing`, 2026-09-15) is the first taken since turf-vault PR #18 repaired the suite's rejection helper, but it PREDATES the username registry and is not evidence for it (those rows read UNPROVEN) — and a stamp records a TREE, not `HEAD`, with nothing to re-check it. A `cargo test` lane was added in v0.26 and DOES run on every push, but it reaches only the Rust assertions in `programs/`, never the TypeScript suite. Before authorizing a Squads upgrade, read [What the Suite Evidences](VERIFICATION_MATRIX.md#what-the-suite-evidences).
