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

Latest local proof, **2026-09-15**, on the v0.26 governance tree:

```bash
yarn install
anchor build
anchor test          # spins its own validator, deploys, runs tests/turf_vault.ts
```

Result: **`38 passing`, 0 failing** (was `27` at the 2026-09-06 stamp; +11 for
the v0.26 governance surface). This is a RUN RESULT, not an `it()` count.

**This stamp is the first one taken AFTER turf-vault PR #18**, which is what the
qualification below was waiting for. #18 (merged 2026-09-07) repaired the suite's
`expectRejected` helper — inert until then at all 45 of its call sites — and
corrected the lock-gate margin. Every rejection assertion in this suite has now
been observed to run against a repaired helper, so the "no helper-mediated
rejection has yet been OBSERVED to bite" caveat below is discharged as of this
run. Re-run and re-stamp before the next Squads upgrade.

Two further lanes now certify this repo, and unlike `anchor test` they run in
CI on every push and PR:

```bash
bin/release-check          # the four CI lanes plus, new in v0.26, `cargo test`
```

`cargo test` matters more than its name suggests here. `cargo check` COMPILES
`#[cfg(test)]` code without running it, so before this lane existed a unit test
could report green having never executed. What it runs includes
`programs/turf_vault/src/governance_tests.rs`, which asserts every `VaultState`
field BYTE OFFSET — the guard against a widen-in-place edit that would compile,
deploy, and silently misread both live vaults. It was control-checked on
2026-09-15 by swapping two same-typed neighbouring fields (a mutation that
compiles cleanly) and confirming the guard failed with `left: 131, right: 99`.

> **A passing count is not evidence for every row below.** Until turf-vault
> PR #18, the suite's `expectRejected` helper was INERT at all 45 of its call
> sites: `expect.fail` sat inside the `try`, its AssertionError fell into the
> `catch` one line below, and the failure message interpolates the pattern
> verbatim — so the error's own text contained the literal the regex was hunting
> for, and self-matched. A call the program ACCEPTED was recorded as a passing
> refusal, with the blindness exactly one failure mode wide: "the guard did not
> refuse at all." Accept-path results are unaffected, but no rejection assertion
> ROUTED THROUGH THE HELPER, before the repair, is evidence of anything. Three
> refusals escape that, because their evidence never went through the helper.
> #18 also corrected the **lock-gate** and **post-lock-amend** drift (those tests
> set a lock one second in the on-chain past against a chain clock running one to
> two seconds behind wall clock, so the gate they assert was never engaged).
>
> **DISCHARGED 2026-09-15.** This paragraph used to end "because no run has
> followed the repair, no helper-mediated rejection assertion in this suite has
> yet been OBSERVED to bite". The `38 passing` run at the top of this file is
> that run — the first since #18 — so every rejection in the suite has now
> executed against a helper that bites, and the lock-gate correction is covered
> too. What remains true is the narrower claim: nothing recorded BEFORE #18 is
> evidence. Which refusals carry evidence on their own anyway is swept row by
> row in [What the Suite Evidences](#what-the-suite-evidences).

## No Lane Runs This Suite

Nothing automatic executes `tests/turf_vault.ts`. The commands above run when a
person types them, and at no other time.

Measured 2026-09-08 from `.github/workflows/ci.yml` and from the step list of CI
run `34146086293` (the `accepted`-rung push for PR #27). The steps below are
read off the RUN, not off the workflow's comments — the comments are the claim
under test:

| Lane | Steps it actually ran | Reaches `tests/turf_vault.ts`? |
|------|-----------------------|--------------------------------|
| CI job `program` (20s) | `rustup show active-toolchain`, `cargo check --workspace --all-targets --locked`, `cargo clippy … -D clippy::correctness`, `cargo test --workspace --locked` | no |
| CI job `guards` (9s) | `npm run check:doc-op-refs`, `npm run test:scripts` | no |

Those are the workflow's only two jobs, and the steps above are the only ones
in them that run anything under test. Each job also does an `actions/checkout`;
`program` additionally prints its toolchain and restores a cargo cache, and
`guards` additionally does an `actions/setup-node`. None of those four reach the
suite either, so the conclusion is unchanged. `anchor`, `ts-mocha` and `tests/`
appear nowhere else in `.github/workflows/` except inside comments explaining
their absence.

The studio certification path DOES reach this repo — as of 2026-09-14 — and what
it runs is the four lanes above, never the suite.
`mcritchie-studio/config/release_repos.yml` names `bin/release-check` on the
`turf-vault` row, so both `bin/fast-check` and `bin/full-suite-check` run THAT
SCRIPT as the whole gate and never reach the Rails lanes this repo has no runner
for (the test-DB reset does not apply to a repo that declares its own gate, and
the rubocop lane is declared absent with `lint_lane: none` — this tree ships no
Ruby). A local cert here is therefore real evidence of a `cargo check`, a clippy
`correctness` pass, `cargo test` (19 Rust assertions, v0.26), the
`check:doc-op-refs` guard and 68 `node:test` cases. It is still NOT evidence
that the PROGRAM ran against a chain: `bin/release-check` runs exactly what CI
runs, and neither runs `tests/turf_vault.ts`. Read the rest of this section
before treating a green cert as execution evidence.

Until 2026-09-14 neither door opened at all, which is why older notes and task
records describe a bypass. `bin/full-suite-check` opened with `bin/rails
db:test:purge db:test:prepare` and REFUSED rather than skipping, because a
skipped prepare lane would hand back a green cert for a repo whose tests never
ran. `bin/fast-check` never got that far: it decided first that no LOCAL lane
could certify this CHECKOUT and recorded a fingerprint-bound
`[cert-deferred@<fp>]` receipt, which `bin/dor-check` credits ONLY alongside a
green GitHub CI, never provisionally (measured on this repo 2026-09-08:
`[cert-deferred@<tree-hash>:turf-vault]` on every push). The blocker was never
"this repo has no tests" — it was that the cert's whole-gate branch keyed on the
`gems` SECTION, so an `apps` row could not reach it however completely it
declared a lane. Either receipt's fingerprint hashes the TREE, so each push
retires the previous one — read the task's `checks_run` for the receipt that
binds the head you are looking at, rather than trusting a fingerprint copied into
prose.

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
- `cargo test --workspace --locked` is a real executing suite, new in v0.26: 19
  assertions in `programs/turf_vault/src/governance_tests.rs`, covering the
  `VaultState` field offsets, the migration-safety case, the N-of-M threshold,
  the floors, and the 6046-6059 error boundary. It is the lane `cargo check`
  cannot substitute for, because `--all-targets` compiles test code without
  running it.
- `npm run test:scripts` is a real executing suite: 68 `node:test` cases across
  seven files, measured 2026-09-15 (61 across six before v0.26 added the
  vault-layout parity guard, which parses `state.rs` and recomputes every offset
  so the scripts' copy of the layout cannot drift from the Rust one) (the count below was written when the suite was
  32 across two, and the four files added since are named at the end of this
  bullet). 26 of them are `scripts/tests/mainnet-config.test.js` — 24
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
  The remaining 6 are `scripts/tests/anchor-suite-lane.test.js`, which pins the
  two facts the `## No Lane Runs This Suite` heading and the first two bullets
  of [What it does not cover](#what-it-does-not-cover) rest on — see
  [Re-arming it](#re-arming-it). They read `.github/workflows/` and assert no
  step runs the Anchor suite and none subjects it to a TypeScript reader; the
  other 4 are controls that fail if the guard's comment stripper, its step
  extractor, its Prettier premise or its own doc citations stop working, so it
  cannot pass by reading nothing.
  The last 29 are the four files added since that split was measured, counted
  2026-09-14 but not otherwise re-analysed here: 14 in
  `scripts/tests/squad-roles.test.js` (who may sign each upgrade step, graded
  against the planner), 5 in `scripts/tests/squad-upgrade-flow.test.js` (the real
  `scripts/squad-upgrade.js` executed end to end against stubs), 5 in
  `scripts/tests/squad-upgrade-signers.test.js` (which member each call in that
  script names), and 5 in `scripts/tests/release-check-covers-ci.test.js`, which
  holds `bin/release-check` — the local gate the studio's cert now runs for this
  repo — identical to the lanes this workflow runs.
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
- **A Rust test lane exists as of v0.26, and it was needed.** This bullet
  previously read "a Rust test lane would add nothing today — `programs/`
  carries zero `#[test]` functions", which was true when written and stopped
  being true in the same change that added `cargo test` to `ci.yml` and
  `bin/release-check`. `programs/turf_vault/src/governance_tests.rs` now holds
  19 assertions, and `lib.rs` declares the module.

  **`cargo check` was never enough for them.** `--all-targets` COMPILES test
  targets; it runs none. So a repo with unit tests and no `cargo test` lane
  reports green over assertions that never execute — the same "a lane that
  cannot fail is worth nothing" failure the `guards` lane was added for. What
  the lane protects is the `VaultState` field OFFSETS: the account is
  `zero_copy(unsafe)` + `repr(C)`, so an edit that inserts or widens a field
  rather than appending one shifts every field after it and makes the live
  devnet and mainnet vaults decode as something else, while compiling,
  deploying and running without complaint. The guard was control-checked on
  2026-09-15 by swapping two same-typed neighbouring fields — a mutation that
  compiles cleanly — and confirming it failed with `left: 131, right: 99`.

  What it still does NOT reach is `tests/turf_vault.ts`: that needs a validator,
  and no lane starts one.
- **The script that performs the upgrade is exercised now, but never against a
  chain.** `scripts/squad-upgrade.js` is leg 3 of this very control — the 219
  lines that propose, approve and execute the buffer upgrade against the Squads
  2-of-3 vault. Until 2026-09-13 no test ran a line of it (measured 2026-09-08:
  the only occurrence of `squad-upgrade` under `scripts/tests/` was a COMMENT at
  `mainnet-config.test.js:114`). /tasks/narrow-bot-squads-permissions added
  three suites: the signer planner's refusals, a text scan of who each call
  names, and an END-TO-END run of the real script with `@solana/web3.js` and
  `@sqds/multisig` replaced in the module loader. **What that still is not:** no transaction is
  built against a validator and none is sent, so the upgrade's on-chain
  behaviour — whether the vault PDA can actually authorise the BPF `upgrade` —
  remains proved only by having been run by hand on devnet. The rent-payer file
  self-skips wherever `node_modules` is absent, which is CI's `guards` lane.
- **The stamp ages, and nothing notices.** The local proof records a TREE, not
  `HEAD`. Between stamps no run re-checks it, and this file cannot tell you
  whether the tree it stamped is the tree you are about to upgrade from. The
  `27 passing` stamp is the worked example: it sat here for nine days across
  PR #18, which repaired the very helper it was being cited as evidence from,
  and nothing in this file noticed. It was replaced on 2026-09-15 only because
  a person ran the suite. **The `cargo test` lane added in v0.26 does not age
  this way** — it runs on every push and PR — but it reaches only the Rust
  assertions, never `tests/turf_vault.ts`.
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
  receipt instead. Since 2026-09-14 that receipt can be a REAL local cert
  (`[full-suite@<fp>:turf-vault]`, written by `bin/full-suite-check` running
  `bin/release-check`); before that it could only be a fingerprint-bound
  `[cert-deferred@<fp>]` alongside a green CI, or an author-written
  `[full-suite-bypass] <reason>`, which still works and is flagged loudly. The
  upgrade is real and it does not touch this gap: the cert runs CI's four lanes,
  so NO receipt any gate reads is evidence that this program ran. The
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

You will be told rather than trusted to remember.
`scripts/tests/anchor-suite-lane.test.js` runs in CI's `guards` lane and fails
the moment a workflow step runs the suite OR merely reads it, printing the
workflow file, the line, the resolved command chain, and this list of sections.
It pins BOTH facts because the second is the fragile one: `npm run lint`
(Prettier) already exists in `package.json`, is listed in
[`../README.md`](../README.md) as deliberately deferred, and globs
`tests/turf_vault.ts` — so wiring that ONE line would falsify "no lane even
reads the suite" while leaving `## No Lane Runs This Suite` literally true.

## What the Suite Evidences

A blanket warning is not a map, so all 45 rejection call sites in the matrix
suite were read block by block on 2026-09-07, looking for the one thing that
survives an inert helper: an assertion AFTER a refusal that re-reads state a
wrongly-ACCEPTED call would have changed. Three exist, all in the
`burn_entry_token` block. They are ordinary `expect`s that do not route
through the helper, and both blocks holding them are among the four
`burn_entry_token` cases the old `27 passing` stamp counted — so these three
were, at that stamp, the only refusals in the file it actually evidenced.

**That qualification is now historical.** The 2026-09-15 run at the top of this
file (`38 passing`) is the first taken AFTER turf-vault PR #18 repaired the
helper, so every refusal in the suite has now been observed to run against a
helper that bites. The table below is kept because it records which three
refusals stood on their own evidence even while the helper was inert:

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
- The two cases in `enforces set_contest_lock_time and
  set_contest_conclusion_time rules` are NOT. Both call as `admin` — a real
  vault signer — with `cosigner: null`, and both are followed by the identical
  call succeeding once further signers cosign. They are the post-finality
  RE-OPEN gate (v0.26: escalating from 2 to **3**): an amend after a conclusion
  time is set, and an amend after the lock has passed. Under v0.26 they now
  assert `InsufficientSigners` (6046) rather than `Unauthorized` (6000), which
  is the distinction exactly — the caller's SEAT is valid and the COUNT is
  short. Reading either as non-signer coverage would credit seat checks that
  nothing here exercises.

## Instruction Matrix

**THE AUTH CLAUSES BELOW DESCRIBE v0.26 (Unreleased), NOT WHAT IS DEPLOYED.**
The deployed v0.25 program is structurally 2-of-3 / 1-of-3 and cannot express
anything else — `validate_multisig` took exactly two signers and never read the
`threshold` field. v0.26 replaces that with per-action thresholds stored in a
`GovernanceConfig` PDA, and the numbers below are its SHIPPED DEFAULTS, every
one of which is retunable by transaction. Live truth for the chain is
[`CURRENT_DEPLOYMENT.md`](CURRENT_DEPLOYMENT.md); the live numbers, once
deployed, are in the PDA at seeds `[b"governance"]`.

| Area | Instruction | Required proof |
|------|-------------|----------------|
| Vault setup | `initialize` | Creates singleton `VaultState`; pins payout mint, treasury authority, signers, threshold, USDC slot 0, USDT slot 1; mainnet build rejects non-`INIT_AUTHORITY`. |
| Governance | `update_signers` | Requires **3** (floor 3 — no quorum can lower it); up to FIVE left-packed slots; rejects duplicates, gaps, a set too small for any live threshold, and rotations that keep fewer than `threshold` of the AUTHORIZING signers. |
| Currency registry | `register_currency` | Requires **3**; rejects duplicate mint and full registry; initializes stable `op_rev` ATA for the new slot. |
| Currency registry | `deactivate_currency` | Requires **3**; flips `active=false`; preserves slot and historical tallies. |
| Pause control | `pause` | Requires **2** (floor 1 — `cosigner` is `Option<Signer>` so the account struct cannot out-vote the table, and a retune to 1 really reaches one signature); records reason; blocks `enter_contest` and `enter_contest_with_token` only. |
| Pause control | `unpause` | Requires **3** (floor 3 — deliberately harder than pausing, so a captured system can brake and never release); clears pause; paid and token entries work again. |
| User account | `create_user_account` | Permissionless payer can create a wallet account; username charset, length, and reserved-prefix checks hold. |
| User account | `set_username` | Requires owner signature; rejects non-owner, invalid charset, short names, and reserved prefixes. |
| User account | `admin_create_user_account` | Requires payer plus **1** vault signer; waives only reserved-prefix branch; still enforces charset and length. |
| User account | `admin_set_username` | Requires owner signature plus **1** vault signer; waives only reserved-prefix branch; rejects non-owner and non-signer admin. |
| Season | `create_season` | Requires **3** (it sets the per-entry seed schedule with no ceiling checked); creates immutable entry seed schedule and quest seed schedule; rejects duplicate season ID. |
| Contest | `create_contest` | Requires **1** payer plus creator; funds prize-pool ATA; validates payout tiers sum to prize pool; stores per-currency fees and lock timestamp. |
| Contest | `set_contest_lock_time` | Requires **2** before lock and **3** to RE-OPEN a lock that has passed (the results-known vector); rejects invalid timestamp/order and post-finality changes without required cosign path. |
| Contest | `set_contest_conclusion_time` | Requires **2** for the first set and **3** to AMEND one already set; rejects invalid timestamp/order and post-finality changes without required cosign path. |
| Entry | `enter_contest` | Requires user signature plus **1** payer; validates active currency slot, user ATA funds, max entries, lock/conclusion gate, and season schedule seed award. |
| Entry | `enter_contest_with_token` | Requires user signature plus **1** payer; consumes matching `EntryTokenAccount`; awards seeds; charges no currency and cannot be reused. |
| Free entry | `mint_entry_token` | Requires **1** within the per-window cap and **3** above it — v0.26 closed an uncapped 1-of-N value-creation hole with a `MintWindow` counter PDA; `window_index` is an instruction arg (it is a PDA seed) and the handler pins it to the chain clock, so a caller cannot name an empty window. PDA is keyed by `sha256(source_ref)`; remint of the same source reference fails. |
| Free entry | `burn_entry_token` | Requires **3** and the holder does **not** sign; not pause-gated. TOMBSTONES rather than closing: the account survives, so the on-chain token COUNT that Rails reads as owed is unchanged and nothing re-mints it. Sets `consumed = true` (reusing the constraint `enter_contest_with_token` already carried) and raises `BURNED_FLAG` (`0x80`) in the spare high bit of `source`, inside the EXISTING 124-byte `EntryTokenAccount` layout — so tokens minted before the upgrade still deserialize. Rejects a double burn, with the flag checked FIRST so `EntryTokenAlreadyBurned` is reachable rather than masked by `EntryTokenAlreadyConsumed`; rejects a token already spent. `source_ref_hash` seed-binds the target as a **fat-finger guard**, not as a targeting control: the caller must name the token twice, so naming the wrong account WITHOUT its matching hash fails the seeds check instead of burning it. A self-consistent pair is a different matter — supply `(some other token, that token's own hash)` and BOTH the seeds check and the handler's re-derivation hold, and that token burns. The handler's `require!` adds nothing here: `mint_entry_token` already asserts `sha256(source_ref) == source_ref_hash` and seeds the PDA with it, so every real account satisfies the re-derivation by construction. Nothing restricts WHICH voucher an authorized quorum may burn, and v0.26 does not change that — it raises WHO HAS TO AGREE, from one signature to three. That is why this instruction, written but never deployed, ships at 3 rather than at the 1 it was drafted with: at one signature a single agent-reachable key could have destroyed every outstanding voucher. |
| Seeds | `grant_seeds` | Requires **1**; applies bounded quest/referral seed amount; idempotent per `(wallet, kind, invitee)` guard PDA. v0.26: an `INVITE_FRIEND` grant must also pass the invitee's own `UserAccount`, PDA-bound and with `entries > 0` — the guard used to be seeded on a caller-chosen `Pubkey`, so "once per invited friend" was really "once per 32-byte NUMBER" and one signature could mint seeds without bound. |
| Settlement | `settle_contest` | Requires **3**, with extra cosigners LEADING `remaining_accounts` ahead of the winner triples; requires contest locked/concluded; validates user/entry PDAs and winner ATA owner/mint; pays only from prize pool; rejects duplicate settlement pairs and over-cap payouts. |
| Cancellation | `cancel_contest` | Requires **3**; refunds live prize-pool balance to creator ATA; status moves to Cancelled; operator revenue remains separate. |
| Closeout | `close_contest` | Requires **2**; only settled/cancelled contests; dust-sweeps prize pool to USDC `op_rev`; closes contest PDAs. v0.26: BOTH rent refunds (the Contest PDA's and the prize_pool ATA's) are pinned to `vault_state.treasury_authority` rather than paid to whichever signer called it — `InvalidRentDestination` (6056) otherwise. |
| Treasury | `sweep_operator_revenue` | Requires **3**; drains selected currency `op_rev` to treasury ATA; enforces treasury owner equals `vault_state.treasury_authority`. |

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
