# TurfVault Verification Matrix

This is the current proof checklist for the active self-custody instruction
surface. It is not a replacement for source review, and it is not deployment
identity. Live program IDs, signer set, IDL hash, and upgrade authority live in
[`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md).

The TypeScript suite at `tests/turf_vault.ts` is organized around this matrix
and no longer includes retired v0.15 `deposit`, `withdraw`, or daily-withdraw-cap
cases.

## Baseline Commands

```bash
anchor build
anchor test
```

If `anchor test` cannot inherit Node/Yarn, use the direct test path from
[`../RUNBOOK.md`](../RUNBOOK.md). After any source change, regenerate the IDL and
re-pin Turf Monster from the freshly built file, not from `anchor idl fetch`.

Latest local proof, 2026-09-06 — **stale as of turf-vault PR #18; see the
qualification below before citing it**:

```bash
anchor build
solana-test-validator --reset --rpc-port 8898 --faucet-port 9901
anchor deploy --provider.cluster http://127.0.0.1:8898
ANCHOR_PROVIDER_URL=http://127.0.0.1:8898 \
  ANCHOR_WALLET=/Users/alex/.config/solana/id.json \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
```

Result of that run: `27 passing` (was `23`; +4 for `burn_entry_token`), against
an isolated local validator on `127.0.0.1:8898`.

**That number stamps the tree BEFORE turf-vault PR #18, and no run has been made
since.** #18 (merged 2026-09-07) repaired the suite's rejection helper and its
lock-gate margin and added three cases exercising the helper itself, so this tree
carries **30** `it()` blocks — a count read from `tests/turf_vault.ts`, not a run
result. Re-run the command above and re-stamp both numbers before the next Squads
upgrade.

> **A passing count is not evidence for every row below.** Until turf-vault
> PR #18, the suite's `expectRejected` helper was INERT at all 45 of its call
> sites: `expect.fail` sat inside the `try`, its AssertionError fell into the
> `catch` one line below, and the failure message interpolates the pattern
> verbatim — so the error's own text contained the literal the regex was hunting
> for, and self-matched. A call the program ACCEPTED was recorded as a passing
> refusal, with the blindness exactly one failure mode wide: "the guard did not
> refuse at all." Accept-path results are unaffected, but no REJECTION assertion
> predating that repair is evidence of anything — and because no run has followed
> the repair, no rejection assertion in this suite has yet been OBSERVED to bite.
> #18 also corrected the **lock-gate** and **post-lock-amend** drift (those tests
> set a lock one second in the on-chain past against a chain clock running one to
> two seconds behind wall clock, so the gate they assert was never engaged); the
> `27 passing` above predates that fix and does not cover it. The
> `burn_entry_token` row's refusal clauses below rest on SOURCE REVIEW rather
> than on the suite — only its double-burn refusal carries even a PARTIAL
> independent check, because the assertion that follows it re-reads `consumed_at`
> and requires the original stamp to be unmoved. Partial, not conclusive:
> `consumed_at` is a `Clock` unix timestamp in SECONDS, so a re-burn landing
> inside the same second would leave the stamp unmoved and that assertion would
> pass anyway.

## Instruction Matrix

| Area | Instruction | Required proof |
|------|-------------|----------------|
| Vault setup | `initialize` | Creates singleton `VaultState`; pins payout mint, treasury authority, signers, threshold, USDC slot 0, USDT slot 1; mainnet build rejects non-`INIT_AUTHORITY`. |
| Governance | `update_signers` | Requires two distinct current signers; rejects duplicates, zero/default slots, and rotations that drop either authorizing signer. |
| Currency registry | `register_currency` | Requires 2-of-3; rejects duplicate mint and full registry; initializes stable `op_rev` ATA for the new slot. |
| Currency registry | `deactivate_currency` | Requires 2-of-3; flips `active=false`; preserves slot and historical tallies. |
| Pause control | `pause` | Requires 2-of-3; records reason; blocks `enter_contest` and `enter_contest_with_token` only. |
| Pause control | `unpause` | Requires 2-of-3; clears pause; paid and token entries work again. |
| User account | `create_user_account` | Permissionless payer can create a wallet account; username charset, length, and reserved-prefix checks hold. |
| User account | `set_username` | Requires owner signature; rejects non-owner, invalid charset, short names, and reserved prefixes. |
| User account | `admin_create_user_account` | Requires payer plus 1-of-3 vault signer; waives only reserved-prefix branch; still enforces charset and length. |
| User account | `admin_set_username` | Requires owner signature plus 1-of-3 vault signer; waives only reserved-prefix branch; rejects non-owner and non-signer admin. |
| Season | `create_season` | Requires 1-of-3; creates immutable entry seed schedule and quest seed schedule; rejects duplicate season ID. |
| Contest | `create_contest` | Requires 1-of-3 payer plus creator; funds prize-pool ATA; validates payout tiers sum to prize pool; stores per-currency fees and lock timestamp. |
| Contest | `set_contest_lock_time` | Requires 1-of-3 before lock; rejects invalid timestamp/order and post-finality changes without required cosign path. |
| Contest | `set_contest_conclusion_time` | Requires 1-of-3 for first set; rejects invalid timestamp/order and post-finality changes without required cosign path. |
| Entry | `enter_contest` | Requires user signature plus 1-of-3 payer; validates active currency slot, user ATA funds, max entries, lock/conclusion gate, and season schedule seed award. |
| Entry | `enter_contest_with_token` | Requires user signature plus 1-of-3 payer; consumes matching `EntryTokenAccount`; awards seeds; charges no currency and cannot be reused. |
| Free entry | `mint_entry_token` | Requires 1-of-3; PDA is keyed by `sha256(source_ref)`; remint of the same source reference fails. |
| Free entry | `burn_entry_token` | Requires 1-of-3 and the holder does **not** sign; not pause-gated. TOMBSTONES rather than closing: the account survives, so the on-chain token COUNT that Rails reads as owed is unchanged and nothing re-mints it. Sets `consumed = true` (reusing the constraint `enter_contest_with_token` already carried) and raises `BURNED_FLAG` (`0x80`) in the spare high bit of `source`, inside the EXISTING 124-byte `EntryTokenAccount` layout — so tokens minted before the upgrade still deserialize. Rejects a double burn, with the flag checked FIRST so `EntryTokenAlreadyBurned` is reachable rather than masked by `EntryTokenAlreadyConsumed`; rejects a token already spent. `source_ref_hash` seed-binds the target as a **fat-finger guard**, not as a targeting control: the caller must name the token twice, so naming the wrong account WITHOUT its matching hash fails the seeds check instead of burning it. A self-consistent pair is a different matter — supply `(some other token, that token's own hash)` and BOTH the seeds check and the handler's re-derivation hold, and that token burns. The handler's `require!` adds nothing here: `mint_entry_token` already asserts `sha256(source_ref) == source_ref_hash` and seeds the PDA with it, so every real account satisfies the re-derivation by construction. **A 1-of-3 signer can therefore burn any unspent voucher on the platform** — see [`KEY_ROTATION.md`](KEY_ROTATION.md) R1b. |
| Seeds | `grant_seeds` | Requires 1-of-3; applies bounded quest/referral seed amount; idempotent per `(wallet, kind, invitee)` guard PDA. |
| Settlement | `settle_contest` | Requires 2-of-3; requires contest locked/concluded; validates user/entry PDAs and winner ATA owner/mint; pays only from prize pool; rejects duplicate settlement pairs and over-cap payouts. |
| Cancellation | `cancel_contest` | Requires 2-of-3; refunds live prize-pool balance to creator ATA; status moves to Cancelled; operator revenue remains separate. |
| Closeout | `close_contest` | Requires 1-of-3; only settled/cancelled contests; dust-sweeps prize pool to USDC `op_rev`; closes contest PDAs. |
| Treasury | `sweep_operator_revenue` | Requires 2-of-3; drains selected currency `op_rev` to treasury ATA; enforces treasury owner equals `vault_state.treasury_authority`. |

## Cross-Repo Proof

| Consumer | Proof |
|----------|-------|
| Turf Monster IDL | `config/turf_vault.idl.json` / `config/turf_vault.mainnet.idl.json` hashes match the intended deployment target and configured `EXPECTED_IDL_HASH`. |
| Turf Monster Rails flows | Magic-link/managed-wallet and Phantom paths build transactions against current instruction names and account lists. |
| Public contract page | `/contract` instruction list, byte/caller metadata, and version labels match the newly pinned IDL. |
| Operator docs | `turf-monster/docs/SOLANA.md`, `turf-vault/README.md`, `RUNBOOK.md`, and `CURRENT_DEPLOYMENT.md` agree on program IDs, signer set, and upgrade rule. |

## Known Gaps

- Local TypeScript tests run the default localnet/devnet build. The
  mainnet-only `INIT_AUTHORITY`, canonical USDC, and canonical USDT checks are
  feature-gated and should be proven as part of mainnet build/deploy review.
- Devnet and mainnet verification are distinct: devnet may run v0.25 while
  mainnet remains v0.24 until the next upgrade window.
- Any signer or upgrade-authority change must update `CURRENT_DEPLOYMENT.md` in
  the same change that updates deployment configuration.
