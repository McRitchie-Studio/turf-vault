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
> refuse at all." Accept-path results are unaffected, but no rejection assertion
> ROUTED THROUGH THE HELPER, before the repair, is evidence of anything — and
> because no run has followed the repair, no helper-mediated rejection assertion
> in this suite has yet been OBSERVED to bite. Three refusals escape that,
> because their evidence never went through the helper.
> #18 also corrected the **lock-gate** and **post-lock-amend** drift (those tests
> set a lock one second in the on-chain past against a chain clock running one to
> two seconds behind wall clock, so the gate they assert was never engaged); the
> `27 passing` above predates that fix and does not cover it. Which refusals
> below carry evidence anyway, and which do not, is swept row by row in
> [What the Suite Evidences](#what-the-suite-evidences).

## No Lane Runs This Suite

Nothing automatic executes `tests/turf_vault.ts`. The commands above run when a
person types them, and at no other time.

Measured 2026-09-08 from `.github/workflows/ci.yml` and from the step list of CI
run `34146086293` (the `accepted`-rung push for PR #27). The steps below are
read off the RUN, not off the workflow's comments — the comments are the claim
under test:

| Lane | Steps it actually ran | Reaches `tests/turf_vault.ts`? |
|------|-----------------------|--------------------------------|
| CI job `program` (20s) | `rustup show active-toolchain`, `cargo check --workspace --all-targets --locked`, `cargo clippy … -D clippy::correctness` | no |
| CI job `guards` (9s) | `npm run check:doc-op-refs`, `npm run test:scripts` | no |

Those are the workflow's only two jobs, and the steps above are the only ones
in them that run anything under test. Each job also does an `actions/checkout`;
`program` additionally prints its toolchain and restores a cargo cache, and
`guards` additionally does an `actions/setup-node`. None of those four reach the
suite either, so the conclusion is unchanged. `anchor`, `ts-mocha` and `tests/`
appear nowhere else in `.github/workflows/` except inside comments explaining
their absence.

The studio certification path does not reach it either, and cannot.
`bin/full-suite-check` opens with a Rails `bin/rails db:test:purge
db:test:prepare`, which this repo has no `bin/rails` for; it REFUSES rather than
skipping, because a skipped prepare lane would hand back a green cert for a repo
whose tests never ran. `bin/fast-check` does not get as far as that lane on a
diff like this one: it decides first that no LOCAL lane could certify this
CHECKOUT — the diff maps to no test file, and a satellite checkout resolves none
of the spine entries `mcritchie-studio/config/fast_cert_spine.yml` declares,
because that spine is anchored in the hub — and records a fingerprint-bound
`[cert-deferred@<fp>]` receipt, which `bin/dor-check` credits ONLY alongside a
green GitHub CI, never provisionally. Measured on this task 2026-09-08:
`bin/fast-check` recorded a `[cert-deferred@<tree-hash>:turf-vault]` receipt
instead of a cert, on every push. That fingerprint hashes the TREE, so each push
retires the previous receipt — read the task's `checks_run` for the one that
binds the head you are looking at, rather than trusting a fingerprint copied into
prose. By either door, no local lane executes anything in this repo.
`mcritchie-studio/config/release_repos.yml` declares that state under
`turf-vault` rather than leaving it to be discovered; its note there still names
the older `[full-suite-bypass]` receipt and is due the same correction.

## The Compensating Control, and What It Does Not Cover

Skipping a validator lane in CI is a reasoned trade, argued in
`.github/workflows/ci.yml` and in [`../README.md`](../README.md). A trade is only
honest while the control standing in for the suite is described with its gaps: a
control named without them buys confidence it has not earned.

### What the control is

1. **The static CI lanes above**, on every pull request and on every push to
   `main`, `release` and `accepted`.
2. **A hand-run local-validator proof**, stamped with its date and its passing
   count under [Baseline Commands](#baseline-commands) in this file.
3. **The rollout gate** — the program is upgraded by hand through
   `scripts/squad-upgrade.js` against a Squads 2-of-3 multisig, and this matrix
   is the checklist that upgrade is read against.

### What it covers

- `cargo check --workspace --all-targets --locked` type-checks every
  `#[derive(Accounts)]` expansion — account structs, constraint attributes,
  instruction signatures, PDA seed types — and refuses a `Cargo.lock` that has
  drifted from `Cargo.toml`.
- `cargo clippy … -D clippy::correctness` fails on code clippy classes as
  outright wrong.
- `npm run test:scripts` is a real executing suite: 26 `node:test` cases, 24
  calling `scripts/lib/mainnet-config.js` directly and 2 over
  `scripts/initialize-mainnet.js` (`scripts/tests/mainnet-config.test.js:281`
  reads its source, `:296` spawns it; `:296` is the one that self-skips in CI,
  which installs no `node_modules`). **Five of the 26 drive the REAL checked-in
  `scripts/squad.json`** — `:85`, `:97`, `:103`, `:113` and `:296`. The other 21
  never read that file: 20 are `flatFixture()` mutations or inline literals,
  including the whole 15-entry refusal table at `:155`, and `:281` reads
  `initialize-mainnet.js`'s source text. Split measured 2026-09-08 by moving
  `scripts/squad.json` aside in a scratch copy of this tree and re-running:
  exactly those 5 failed and the other 21 passed unchanged, and 26/26 passed
  again once the file was restored. A fixture written from the code under test
  certifies the code, not the artifact — which is why the 5 are named and the
  21 are not counted as if they were. "No lane runs the Anchor suite" and
  "nothing is tested" are different sentences; only the first is true.
- `npm run check:doc-op-refs` fails on a stale 1Password vault reference in this
  repo's prose.

### What it does not cover

- **No lane executes the program.** Nothing automatic contacts a Solana cluster,
  so no `require!`, no `#[account]` constraint, no seed derivation and no
  arithmetic in this program is ever RUN before it reaches `main`. Every
  behavioural claim in the [Instruction Matrix](#instruction-matrix) below rests
  on the hand-run stamp, or on source review.
- **No lane even reads the suite.** `tests/turf_vault.ts` is TypeScript:
  `cargo check` cannot see it, `node --test scripts/tests/` does not glob it, and
  neither `tsc` nor `npm run lint` (Prettier) is wired into a workflow. A syntax
  error in this file reaches `accepted` green.
- **A Rust test lane would add nothing today.** `programs/` carries zero `#[test]`
  functions and no `#[cfg(test)]` module, so `cargo test` would execute no
  assertions. `--all-targets` compiles test targets; there are none to run.
- **The script that performs the upgrade is itself unexercised.**
  `scripts/squad-upgrade.js` is leg 3 of this very control — the 198 lines that
  propose, cosign and execute the buffer upgrade against the Squads 2-of-3
  vault — and no test runs a line of it. The executing suite named under
  [What it covers](#what-it-covers) reaches `scripts/lib/mainnet-config.js` and
  `scripts/initialize-mainnet.js` and stops there. Measured 2026-09-08: the only
  occurrence of `squad-upgrade` anywhere under `scripts/tests/` or `tests/` is a
  COMMENT at `scripts/tests/mainnet-config.test.js:114`, observing that the
  upgrade path reads `cfg.vaultPda` for the same purpose the config guard does.
  A comment is not a lane. So the reassurance that the deploy scripts have a
  real suite must be read with this exception attached: the leg that moves the
  program is not in it.
- **The stamp ages, and nothing notices.** The local proof records a TREE, not
  `HEAD`. Between stamps no run re-checks it, and this file cannot tell you
  whether the tree it stamped is the tree you are about to upgrade from. The
  qualification under Baseline Commands is the current example: the `27 passing`
  count predates PR #18, and no run has followed it.
- **A rotted suite still prints green, measured rather than imagined.**
  `expectRejected` — the suite's only negative-assertion primitive, 45 call
  sites — was inert for the suite's entire life, repaired only in PR #18. While
  it was inert a harness bug redeployed a stale `.so` with the lock gate
  DELETED, and the suite still reported the lock-gate entries as passing: a
  deleted money-path guard, and a green suite over it. The helper is fixed; the
  thing that let it stay broken unnoticed for so long — that no lane runs the
  suite — is what this section is about. A green count from a suite nobody has
  re-run since is a weaker claim than it looks.
- **No merge or release gate reads any of it.** `bin/dor-check` waives the suite
  gate for a `docs`-shaped diff, and for every other shape accepts a recorded
  receipt instead: a fingerprint-bound `[cert-deferred@<fp>]` alongside a green
  CI, or an author-written `[full-suite-bypass] <reason>`, which still works and
  is flagged loudly. Neither receipt is evidence that this program ran. The
  pre-QA (G3) and ship (G4) gates skip this repo, which registers no `test_cmd`
  and no `qa_test_cmd`, and the release records no QA evidence for it at all
  (`qa_evidence: exempt`). Each of those is correct on its
  own — an Anchor program has no dyno to boot and no URL to smoke — and together
  they mean nothing between an edit here and `main` runs the program.

### Re-arming it

Re-run the Baseline Commands block and re-stamp BOTH numbers, the date and the
passing count, before the next Squads upgrade. The vault PDA is a SINGLETON, so
every run needs a FRESH ledger (`solana-test-validator --reset`); a re-used
ledger fails `initialize` with `Account already in use`.

If a lane is ever wired to run the suite, the heading that stops being true is
`## No Lane Runs This Suite` — delete THAT section, not merely this
`### Re-arming it` sub-subsection, and rewrite the bullets under
[What it does not cover](#what-it-does-not-cover) that rest on it. Deleting only
the sub-subsection you are reading leaves the false heading standing above a
matrix an operator reads before a mainnet upgrade.

## What the Suite Evidences

A blanket warning is not a map, so all 45 rejection call sites in the matrix
suite were read block by block on 2026-09-07, looking for the one thing that
survives an inert helper: an assertion AFTER a refusal that re-reads state a
wrongly-ACCEPTED call would have changed. Three exist, all in the
`burn_entry_token` block. They are ordinary `expect`s that do not route
through the helper, and both blocks holding them are among the four
`burn_entry_token` cases the `27 passing` stamp counts — so these three, alone
in the file, are refusals that stamp actually evidences:

| Refusal | The assertion that follows it | Strength |
|---|---|---|
| A stranger holding no vault seat cannot burn | the target's `consumed` re-read as `false` | **full** — a boolean the burn would have flipped |
| A burn naming an account its hash does not match | BOTH accounts' `consumed` re-read as `false` | **full**, same reason |
| A second burn of an already-burned token | `consumed_at` re-read equal to the pre-burn stamp | **partial** — `consumed_at` is a `Clock` timestamp in SECONDS, so a re-burn inside the same second leaves it unmoved and the assertion passes anyway |

Every other refusal clause in the matrix below rests on the helper alone, and
therefore on source review until the suite is re-run: `update_signers`
continuity, the `register_currency` duplicate and full-registry bars, the
`create_contest` payout-tier bar, the `create_season` duplicate, the
`enter_contest` currency / funds / max-entry / lock gates, the timestamp and
post-finality gates on `set_contest_lock_time` and
`set_contest_conclusion_time`, the `settle_contest` variants, `close_contest`,
the pause cosigner, `sweep_operator_revenue`'s treasury-owner check, the
username rules, the `mint_entry_token` remint bar, and the burn row's
"rejects a token already spent".

`sweep_operator_revenue` earns a second mention: its refusal is what stands
between operator revenue and an attacker-named treasury ATA, and the
assertions that follow it read a DIFFERENT currency's accounts, so the account
the refused call targeted is never re-read as a check. The block is not
entirely blind — a later sweep of 3 USDT from that same `op_rev` would fail if
the refused call had drained it — but that is an accident of ordering, not an
assertion, and reordering the test would remove it silently.

**Two different properties share one error spelling.** `Unauthorized` (6000)
is raised both by "this key holds no vault seat" and by "this signer holds a
seat, but a second one was required", and the suite asserts both with the same
`/Unauthorized/i`. They are not interchangeable evidence.

- `tests/turf_vault.ts:1551`, in `only a vault signer may burn, and the hash
  must name the token`, IS a genuine non-signer check: `burnEntryToken(token,
  stranger)` is called by a key with no seat at all.
- `tests/turf_vault.ts:1325` and `:1355`, in `enforces set_contest_lock_time
  and set_contest_conclusion_time rules`, are NOT. Both call as `admin` — a
  real vault signer — with `cosigner: null`, and both are followed by the
  identical call succeeding once `signer2` cosigns. They are the
  post-finality 2-of-3 RE-OPEN gate: an amend after a conclusion time is set,
  and an amend after the lock has passed. Reading them as non-signer coverage
  would credit seat checks that nothing here exercises.

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

- **The largest gap is that no lane runs this suite at all** — see
  [No Lane Runs This Suite](#no-lane-runs-this-suite) and
  [The Compensating Control, and What It Does Not Cover](#the-compensating-control-and-what-it-does-not-cover)
  above. The gaps below are the ones that remain even after a successful
  hand-run.
- Local TypeScript tests run the default localnet/devnet build. The
  mainnet-only `INIT_AUTHORITY`, canonical USDC, and canonical USDT checks are
  feature-gated and should be proven as part of mainnet build/deploy review.
- Devnet and mainnet verification are distinct. The two clusters are built
  from different feature gates and are different sizes on chain, and nothing in
  the program ties their releases together, so they CAN diverge. They do not
  today: both ran v0.25.0 when [`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md)
  was re-derived on 2026-09-07. Read that file for each cluster's label and for
  how the label was established; do not carry an example from this line.
- Any signer or upgrade-authority change must update `CURRENT_DEPLOYMENT.md` in
  the same change that updates deployment configuration.
