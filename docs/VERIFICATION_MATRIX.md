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

**The suite is no longer hand-run only.** `.github/workflows/anchor-suite.yml`
runs it on every program/suite pull request, on every such push to `accepted`,
`release` and `main`, on a daily schedule, and on demand — see
[The Lane That Runs This Suite](#the-lane-that-runs-this-suite). The stamp below
is still recorded, because a stamp names a TREE and a lane names a run, but it is
no longer the only execution evidence this repo has.

Latest local proof, **2026-09-15**, on the username-registry tree — taken through
the LANE'S recipe (`yarn install`, `anchor build`, a validator started with the
built `.so` loaded at the declared program ID, then `anchor test --skip-build
--skip-deploy --skip-local-validator`), copy-pasteable under
[Keeping it armed](#keeping-it-armed):

Result: **`45 passing`, 0 failing** (was `38` earlier the same day, and `27` at
the 2026-09-06 stamp). This is a RUN RESULT, not an `it()` count — though on this
tree the two happen to agree, because every `it()` in the file ran.

Why the recipe rather than a plain `anchor test`, which DEPLOYS: a machine
without `target/deploy/turf_vault-keypair.json` (a secret, gitignored, and absent
from any fresh checkout) gets a RANDOM program keypair from `anchor build`, and
every test then fails `DeclaredProgramIdMismatch`. The keypair-free path is what
CI runs, so it is what a stamp should be taken through. On a machine that holds
the keypair, the two Baseline Commands above still work and prove the same
thing.

> **THE REGISTRY ROWS ARE PROVEN AS OF THIS STAMP — and the first run that
> reached them found two tests that had never bitten.** The stamp this replaced
> predated the username registry and said so; its rows carried **UNPROVEN**
> marks that are now cleared, because every registry `it()` has executed against
> a chain on this tree.
>
> Two of them FAILED on that first run, and the failure was in the tests, not in
> the program. `username_record` is declared
> `seeds = [b"username", name_key.as_ref()]`, and Anchor validates account
> constraints BEFORE the handler body — so a case that passed a bad `name_key`
> alongside a record derived from the GOOD one was refused by `ConstraintSeeds`
> and never reached the guard it named. Both read
> `AnchorError caused by account: username_record` where they expected
> `UsernameInvalidChars` (6021) and `UsernameKeyMismatch` (6061). They now derive
> the record from the key actually being passed, so the seeds constraint is
> satisfied and the handler's own refusal is what the assertion sees. The program
> refused in both cases either way; what was missing was proof of WHICH guard
> refused, which is the whole content of those two rows.
>
> This is the argument for the lane in one paragraph: two assertions sat green-by-
> absence for as long as nothing ran them.
>
> The unit lanes ARE current and did run on this tree — see `bin/release-check`
> below, now **48 `cargo test` cases** (was 19) and **79 `node:test` cases**.
> They carry the registry's uniqueness and threshold properties; what they
> cannot carry is whether the instructions reach them, which is what the
> unstamped Anchor cases exist to prove.
>
> **The UNPROVEN marks are cleared as of this stamp**, and keeping them cleared
> is no longer a matter of remembering: the Anchor Suite lane re-runs these cases
> on every program or suite change, on every push to `accepted`, and daily on
> `main`.

**Every rejection assertion in this suite has now been observed against the
repaired helper.** turf-vault PR #18 (merged 2026-09-07) fixed `expectRejected`,
which had been inert at all 45 of its call sites, and corrected the lock-gate
margin. The 13 call sites the username registry added afterwards were the last
ones no run had reached; this stamp reaches them, and two of the 13 were found to
be asserting the wrong error (above). The caveat is discharged for the whole
file — and, unlike every previous discharge, it stays discharged without anyone
remembering to re-run, because the lane runs on its own.

Two further lanes certify this repo in the `CI` workflow, and they are the fast,
always-run ones — they never start a validator, so they run on every push and PR
without a path filter:

```bash
bin/release-check          # the five `CI` lanes, cheapest first
```

Both Node lanes and both Rust lanes were run green on the username-registry
tree on **2026-09-15** (`cargo test`: 48 passed; `npm run test:scripts`: 79
passed).

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
> **DISCHARGED 2026-09-15, for the whole file.** This paragraph used to end
> "because no run has followed the repair, no helper-mediated rejection assertion
> in this suite has yet been OBSERVED to bite". The `45 passing` run at the top of
> this file has now reached every call site, the 13 the username registry added
> included — and two of those 13 were found to be refusing at the wrong guard,
> which is what an observed assertion buys you over an unobserved one. Nothing
> recorded BEFORE #18 is evidence. Which refusals carry evidence on their own is
> swept row by row in [What the Suite Evidences](#what-the-suite-evidences).

## The Lane That Runs This Suite

`tests/turf_vault.ts` is executed automatically, by
[`.github/workflows/anchor-suite.yml`](../.github/workflows/anchor-suite.yml)
(workflow name **Anchor Suite**). Until 2026-09-15 nothing but a person typing
`anchor test` ever ran it, and this heading said so.

**What the lane does**, in order: installs a pinned Agave CLI and a pinned
prebuilt `anchor-cli`, `yarn install --frozen-lockfile`, `anchor build`, starts
`solana-test-validator` with the freshly built `.so` loaded at the DECLARED
program ID, then `anchor test --skip-build --skip-deploy --skip-local-validator`
against it. It is the only automated thing in this repo that RUNS THE PROGRAM.

**When it runs, and what each trigger is for:**

| Trigger | Why |
|---------|-----|
| `pull_request`, filtered to `programs/**`, `tests/**`, `Anchor.toml`, `Cargo.*`, `rust-toolchain.toml`, `package.json`, `yarn.lock`, `tsconfig.json`, and the workflow itself | The suite observes program behaviour, so those are the only paths whose change it can catch. A docs or scripts PR gets no run — deliberately. |
| `push` to `accepted`, `release`, `main`, same filter | `accepted` carries a COMBINATION of individually-green changes that no PR run ever executed, and it is the rung `bin/release prepare` promotes. |
| `schedule`, daily | The belt. Every other trigger is change-driven, so a quiet week would leave the eviction test unrun. The cron holds `main` — the tip closest to what mainnet is upgraded from — unconditionally. |
| `workflow_dispatch` | Leg 3 of the control below: the clean-machine run before a Squads upgrade, with a kept log. |

**It is deliberately NOT part of the `CI` workflow**, for two reasons that are
not taste. `Release::AcceptedCertification` resolves an app repo's suite workflow
by the literal workflow NAME `CI` and refuses to promote `accepted` when it is
not green — so a flaky validator lane inside `CI` would block the release sweep
for the whole ecosystem. And `PATH_FILTER_KEYS` refuses a `CI` workflow carrying
`paths:`, which is exactly the filter this lane needs. `CI` stays the fast,
never-filtered gate the release guard reads; **Anchor Suite** is the slow, deep,
filtered one, and nothing on the release path reads it.

**The lane holds no keypair and reaches no real cluster.** `anchor test` normally
DEPLOYS using `target/deploy/turf_vault-keypair.json` — the identity key of the
live devnet program, gitignored, and a secret that must never reach a runner. On
a fresh checkout `anchor build` silently generates a random one instead, and
every test then fails `DeclaredProgramIdMismatch`. So the lane never deploys: it
hands the `.so` to the validator at genesis, at the declared address, with
`--upgradeable-program` (the same BPFUpgradeableLoader shape the live clusters
run). The wallet is generated in the job, is the genesis mint — which is how the
suite's accounts get funded, since `tests/turf_vault.ts` contains zero
airdrops — and exists for one job on one loopback validator.

**Measured 2026-09-15 on the tree that introduced the lane: `45 passing`, 0
failing.** The first automated run found two tests asserting the wrong error; see
the note under [Baseline Commands](#baseline-commands).

**What still does not run it.** The studio certification path reaches this repo —
`mcritchie-studio/config/release_repos.yml` names `bin/release-check` on the
`turf-vault` row, so both `bin/fast-check` and `bin/full-suite-check` run THAT
SCRIPT as the whole gate — and that script runs the `CI` workflow's five lanes and
NOT this one. That carve-out is deliberate and pinned by
`scripts/tests/release-check-covers-ci.test.js`: a local cert that demanded a
validator would fail `COULD NOT RUN` on every machine with no Solana toolchain,
which is most of them. So a green local cert is evidence of a `cargo check`, a
clippy `correctness` pass, `cargo test`, the `check:doc-op-refs` guard and the
`node:test` cases — and is still NOT evidence that the program ran. The CI run for
the head is.

Until 2026-09-14 neither cert door opened at all, which is why older notes and
task records describe a bypass. `bin/full-suite-check` opened with `bin/rails
db:test:purge db:test:prepare` and REFUSED rather than skipping, because a
skipped prepare lane would hand back a green cert for a repo whose tests never
ran. `bin/fast-check` never got that far: it decided first that no LOCAL lane
could certify this CHECKOUT and recorded a fingerprint-bound
`[cert-deferred@<fp>]` receipt, which `bin/dor-check` credits ONLY alongside a
green GitHub CI, never provisionally. The blocker was never "this repo has no
tests" — it was that the cert's whole-gate branch keyed on the `gems` SECTION, so
an `apps` row could not reach it however completely it declared a lane. Either
receipt's fingerprint hashes the TREE, so each push retires the previous one —
read the task's `checks_run` for the receipt that binds the head you are looking
at, rather than trusting a fingerprint copied into prose.

## The Compensating Control, and What It Does Not Cover

This section is older than the suite lane, and most of it survives the lane
unchanged: the lane closes the largest gap it described and leaves the rest
exactly where they were. A control named without its gaps buys confidence it has
not earned, so the gaps below are kept even where they shrank.

### What the control is

1. **The static `CI` lanes above**, on every pull request and on every push to
   `main`, `release` and `accepted` — never filtered, never validator-backed.
2. **The Anchor Suite lane** — `tests/turf_vault.ts` against a real validator, on
   the triggers tabled in
   [The Lane That Runs This Suite](#the-lane-that-runs-this-suite). This leg used
   to read "a hand-run local-validator proof, stamped with its date": that stamp
   still exists under [Baseline Commands](#baseline-commands) and is still worth
   taking before an upgrade, but it is no longer the only thing standing between
   an edit here and `main`.
3. **The rollout gate** — the program is upgraded by hand through
   `scripts/squad-upgrade.js` against a Squads multisig (3-of-5 on both clusters
   since 2026-09-15), and this matrix is the checklist that upgrade is read
   against. On mainnet that script cannot finish the upgrade: it holds two of the
   five seats, so it creates the transaction, casts what it can, and stops for
   Mr. McRitchie. **That pause is part of the gate, not an obstacle to it** — it
   is where a human reads this matrix.

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
- `npm run test:scripts` is a real executing suite: 170 `node:test` cases across
  twelve files, measured 2026-09-15 (61 across six before v0.26 added the
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
  The remaining 10 are `scripts/tests/anchor-suite-lane.test.js`, INVERTED on
  2026-09-15 from the guard that used to pin "no lane runs this suite" — see
  [Keeping it armed](#keeping-it-armed). They now assert that a lane DOES run the
  suite, that the lane is not the `CI` workflow the release guard reads, that the
  eviction case is still in the file that lane runs, that the workflow still
  declares all four triggers and that its two `paths:` lists agree, that the
  pinned `anchor-cli` matches the program's `anchor-lang`, and that NO workflow
  reaches a real cluster or reads a repository secret; the last three are controls
  that fail if the guard's comment stripper, its step extractor or its own doc
  citations stop working, so it cannot pass by reading nothing.
  The rest are the upgrade-path files, recounted 2026-09-15 after the Squads
  rewrite: 13 in `scripts/tests/squad-roles.test.js` (which of the two behaviours
  a run takes, graded against the planner, including the three cases that are
  still refusals), 15 in `scripts/tests/squad-upgrade-flow.test.js` (the real
  `scripts/squad-upgrade.js` executed end to end against stubs — and the only
  place the autonomous and handoff paths are proven to be two), 15 in
  `scripts/tests/squad-upgrade-signers.test.js` (which member each call in that
  script names, and that no retired identity has crept back in), 19 in
  `scripts/tests/upgrade-instruction.test.js` (the read-back that refuses to
  approve a transaction that is not the planned upgrade, graded field by field),
  16 in `scripts/tests/squad-clusters.test.js` (which chain, which addresses, and
  the two vocabularies inside `squad.json`), and 6 in
  `scripts/tests/release-check-covers-ci.test.js`, which holds `bin/release-check`
  — the local gate the studio's cert now runs for this repo — identical to the
  lanes the `CI` workflow runs, and refuses a validator-backed lane in it. `npm run test:scripts` reported **170 passing**
  on 2026-09-15 (155 top-level `test()` cases across 12 files, the rest
  subtests); re-derive rather than trust the number.
- `npm run check:doc-op-refs` fails on a stale 1Password vault reference in this
  repo's prose.
- **`anchor test` over `tests/turf_vault.ts`** — 45 cases, `45 passing` on
  2026-09-15, and the only ones that EXECUTE the program. What they reach is swept
  instruction by instruction in
  [What the Suite Evidences](#what-the-suite-evidences); the case the lane exists
  for is `THE EVICTION: three personal wallets remove the agent-reachable slots`,
  which rotates to a five-signer set, reads `VaultState` back off chain, and proves
  by NEGATIVE assertion that the two agent-reachable keys can no longer pause the
  vault. `scripts/tests/anchor-suite-lane.test.js` fails if that case is renamed or
  deleted out of the file the lane runs, so the lane cannot quietly end up guarding
  less than this bullet claims.

### What it does not cover

- **A lane executes the program now — on filtered triggers, and only against a
  loopback validator.** This bullet used to read "No lane executes the program",
  and the two things that replaced it are worth separating. (a) The Anchor Suite
  lane is PATH-FILTERED: a PR touching only `scripts/**`, `docs/**`,
  `migrations/**` or prose executes nothing, by design, because those paths cannot
  change what the suite asserts. (b) The validator is a fresh loopback ledger, so
  what is proved is the program's behaviour, never the state of the live devnet or
  mainnet vaults — no lane reads either, and none should.
- **The mainnet BINARY is still never executed.** `cargo build`/`anchor build`
  here is the default feature set; the mainnet program is built
  `--features mainnet`, which selects different USDC/USDT mint constants and a
  different `declare_id!`. The suite runs the DEVNET-flavoured binary. Nothing
  automatic has ever executed the artifact that mainnet actually receives, and the
  Squads rollout gate is still where that is checked.
- **The suite is now READ as well as run**, which retires a separate bullet this
  section used to carry. `ts-mocha` type-checks `tests/turf_vault.ts` on the way
  to executing it, so a syntax error in that file now reddens the Anchor Suite
  lane instead of reaching `accepted` green — but only on the paths that trigger
  the lane. `npm run lint` (Prettier) is still not wired, for the reason
  [`../README.md`](../README.md) records: 22 files are unformatted.
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
  chain.** `scripts/squad-upgrade.js` is leg 3 of this very control — the script
  that proposes, approves and (on devnet) executes the buffer upgrade against the
  Squads vault. Until 2026-09-13 no test ran a line of it (measured 2026-09-08:
  the only occurrence of `squad-upgrade` under `scripts/tests/` was a COMMENT at
  `mainnet-config.test.js:114`). /tasks/narrow-bot-squads-permissions added three
  suites; /tasks/upgrade-script-names-retired-keys rewrote them for the two-mode
  script and added two more — the read-back comparison and the cluster table.
  **What that still is not:** no transaction is built against a validator and
  none is sent, so the upgrade's on-chain behaviour — whether the vault PDA can
  actually authorise the BPF `upgrade` — remains proved only by having been run
  by hand on devnet. Two files self-skip wherever `node_modules` is absent, which
  is CI's `guards` lane: the rent-payer file, and the discriminator cross-check
  in `squad-clusters.test.js`.

  **What IS proved against the real chain, read-only.** On 2026-09-15 the
  rewritten script's read-back was run against devnet Squads transaction index
  13 — a genuine past upgrade — and matched the reconstructed plan exactly; run
  against the same index with a different buffer it refused, naming the field;
  and run against index 11, a config transaction, it refused as "a config
  transaction changes the multisig's MEMBERSHIP or THRESHOLD". Those are dry
  runs: nothing was signed or sent. Re-derive with
  `node scripts/squad-upgrade.js --cluster=devnet <BUFFER> --index=13`.
- **The stamp still ages; the LANE is what does not.** The local proof records a
  TREE, not `HEAD`, and this file cannot tell you whether the tree it stamped is
  the tree you are about to upgrade from. The `27 passing` stamp is the worked
  example: it sat here for nine days across PR #18, which repaired the very helper
  it was being cited as evidence from, and nothing in this file noticed. Prefer
  the Anchor Suite run for the head you are looking at over any stamp in this
  file — the run is SHA-addressed and the stamp is not. Where a stamp is still the
  only evidence, it is because the lane's path filter did not fire, or because the
  question is about the mainnet-featured binary the lane never builds.
- **A rotted suite still prints green, measured rather than imagined.**
  `expectRejected` — the suite's only negative-assertion primitive, 45 call
  sites — was inert for the suite's entire life, repaired only in PR #18. While
  it was inert a harness bug redeployed a stale `.so` with the lock gate
  DELETED, and the suite still reported the lock-gate entries as passing: a
  deleted money-path guard, and a green suite over it. The helper is fixed, and
  the thing that let it stay broken unnoticed for so long — that no lane ran the
  suite — is fixed too. What the lane cannot fix is an assertion that runs and
  proves the wrong thing: the two registry cases repaired on 2026-09-15 were
  refusing at `ConstraintSeeds` rather than at the guard they named, and only a
  reader noticing the error TEXT caught that. A green count is evidence that the
  assertions ran, never that they assert what their titles claim.
- **No merge or release gate reads any of it.** `bin/dor-check` waives the suite
  gate for a `docs`-shaped diff, and for every other shape accepts a recorded
  receipt instead. Since 2026-09-14 that receipt can be a REAL local cert
  (`[full-suite@<fp>:turf-vault]`, written by `bin/full-suite-check` running
  `bin/release-check`); before that it could only be a fingerprint-bound
  `[cert-deferred@<fp>]` alongside a green CI, or an author-written
  `[full-suite-bypass] <reason>`, which still works and is flagged loudly. The
  upgrade is real and it does not touch this gap: the cert runs `CI`'s five lanes,
  so NO LOCAL receipt is evidence that this program ran. What IS such evidence is
  the Anchor Suite run on the PR or on `accepted`, read from GitHub — and because
  it is a separate workflow, a reader checking only the `CI` workflow's conclusion
  will not see it. The pre-QA (G3) and ship (G4) gates skip this repo, which
  registers no `test_cmd` and no `qa_test_cmd`, and the release records no QA
  evidence for it at all (`qa_evidence: exempt`). Each of those is correct on its
  own — an Anchor program has no dyno to boot and no URL to smoke — and together
  they mean nothing between an edit here and `main` runs the program.

### Keeping it armed

**Reproducing the lane by hand.** The vault PDA is a SINGLETON, so every run needs
a FRESH ledger (`solana-test-validator --reset`); a re-used ledger fails
`initialize` with `Account already in use`. On a machine that holds
`target/deploy/turf_vault-keypair.json`, a plain `anchor test` still works and is
the shortest path. On one that does not — any fresh checkout, and every CI
runner — use the lane's recipe, because `anchor build` will otherwise mint a
random program keypair and every test will fail `DeclaredProgramIdMismatch`:

```bash
anchor build
solana-keygen new --no-bip39-passphrase --force -o ci-wallet.json
W=$(solana-keygen pubkey ci-wallet.json)
solana-test-validator --reset --quiet --mint "$W" \
  --upgradeable-program "$(node -e 'process.stdout.write(require("./target/idl/turf_vault.json").address)')" \
  target/deploy/turf_vault.so "$W" &
anchor test --skip-build --skip-deploy --skip-local-validator \
  --provider.cluster http://127.0.0.1:8899 --provider.wallet "$PWD/ci-wallet.json"
```

**If the lane is ever retired or narrowed**, the heading that stops being true is
`## The Lane That Runs This Suite` — rewrite THAT section, not merely this
sub-subsection, along with the bullets under
[What it does not cover](#what-it-does-not-cover) that now rest on the lane
existing. A stale heading above an instruction matrix is read by an operator
before a mainnet upgrade, which is the whole reason this file is written the way
it is.

**You will be told rather than trusted to remember.**
`scripts/tests/anchor-suite-lane.test.js` runs in `CI`'s `guards` lane — the fast
workflow, so this guard reports on every PR even when the suite lane itself is
filtered out — and fails if: no workflow runs the suite; the `CI` workflow starts
running it (which would put a validator in the release guard's path); the
`THE EVICTION: …` case leaves the suite file; the workflow drops a trigger or its
two `paths:` lists drift apart; the pinned `anchor-cli` stops matching
`anchor-lang`; or any workflow reaches a real cluster or reads a repository
secret. Each failure names the file, the line and the sections to rewrite.

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
file (`45 passing`) is taken AFTER turf-vault PR #18 repaired the helper, and it
reaches every refusal in the file — the 13 the username registry added included.
The table below is kept because it records which three
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

**The username registry's refusals are a separate case, and a stronger one.**
They rest neither on the helper nor on source review alone: the uniqueness
rule, the claim rule, the rename rule and the thresholds are asserted directly
in `programs/turf_vault/src/username_registry_tests.rs`, which CI runs on every
push. Those 29 cases were control-checked on 2026-09-15 by mutation — removing
the already-claimed refusal, letting a rename keep its old name, and lowering
`overwrite_username`'s floor to 1 — and each mutation was caught by exactly the
test written for it. What they do NOT evidence is that the instructions reach
those functions with the right arguments, which is the unstamped Anchor tier's
job.

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
| User account | `create_user_account` | Permissionless payer can create a wallet account; username charset, length, and reserved-prefix checks hold. It also CLAIMS the name in the same transaction, so a signup for a taken or reserved name fails with `UsernameAlreadyClaimed` (6060) rather than creating an account that displays a name it does not hold. Takes `name_key` (the lowercased, zero-padded form — the record's PDA seed). |
| User account | `set_username` | Requires owner signature; rejects non-owner, invalid charset, short names, and reserved prefixes — now including `xan`. Claims `name_key` in the registry and CLOSES the record for the name given up, refunding its rent to the wallet. A rename that omits the old record is refused (`UsernameRecordMissing`, 6062) — without that, a holder keeps every name they ever had at ~0.0015 SOL each. A case-only change keeps the same key and closes nothing. |
| Username registry | `overwrite_username` | Requires **3** (floor 3) and the renamed user does **NOT** sign — the point of the instruction. Replaces `admin_set_username`, which required the owner's consent and was therefore useless against the only two things it was wanted for: a squatter and a slur. Emits `UsernameOverwritten` (who, before, after, which vault signer was named, how many signatures the table demanded, when) — a log line, so no rent and no storage. Waives the reserved-prefix branch and nothing else. Does NOT lock the vacated name; `reserve_username` is the follow-up. |
| Username registry | `reserve_username` | Requires **3** (floor 3). The blocked list, as a claim rather than a list: the vault takes a free name, and every claim path then refuses it through the SAME check that stops a second player. Idempotent; refuses a name a player already holds. |
| Username registry | `release_reserved_username` | Requires **3** (floor 3) — a reservation is a brake, and nothing an agent reaches alone lifts a brake, the same asymmetry as `pause`/`unpause`. Rent goes to the pinned treasury (`InvalidRentDestination`, 6056, otherwise). Refuses a record the vault does not hold (`UsernameNotReserved`, 6066), so a player's name can never be closed through this path. |
| Username registry | `backfill_username_record` | MIGRATION ONLY, and permissionless BY DESIGN: it takes both the name and the owner from the `UserAccount`'s own fields, so it has no discretion and can only assert what the chain already says. Refuses a `name_key` that is not that account's own name, and refuses a blank name (every blank account would collide on one record). Idempotent. 47 production users, 47 with usernames, zero case-insensitive duplicates (measured 2026-09-15) — so this reconciles nothing. |
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

- **The largest gap used to be that no lane ran this suite at all.** It is
  closed as of 2026-09-15 — see
  [The Lane That Runs This Suite](#the-lane-that-runs-this-suite) and
  [The Compensating Control, and What It Does Not Cover](#the-compensating-control-and-what-it-does-not-cover)
  above. What replaces it is narrower and worth stating in its place: **the lane
  is PATH-FILTERED and runs the DEFAULT feature build**, so a change outside
  `programs/**`, `tests/**` and the toolchain files executes nothing, and the
  mainnet-featured binary is still never executed by anything. The gaps below are
  the ones that remain even after a green lane.
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
