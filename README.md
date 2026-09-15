# TurfVault

Solana escrow program for contest entry fees and prize distribution. Built with [Anchor](https://www.anchor-lang.com/).

**Current deployment**: see [`docs/CURRENT_DEPLOYMENT.md`](docs/CURRENT_DEPLOYMENT.md) for live devnet/mainnet program IDs, signer set, and upgrade authority.

**Docs index**: see [`docs/README.md`](docs/README.md) before following historical specs, audits, or generated reports.

> **THE `Auth` COLUMN BELOW, THE `Architecture` BLOCK AND THE `Security`
> SECTION STILL DESCRIBE v0.25 — THE DEPLOYED PROGRAM, NOT THIS TREE.**
> v0.26 (Unreleased) replaces the fixed 2-of-3 / 1-of-3 model with five signer
> slots and a per-action threshold table stored in the `governance` PDA, so
> most thresholds written below are now wrong for the source in this repo —
> `burn_entry_token` and `update_signers` are 3, not the 1-of-3 / 2-of-3 shown.
> Authoritative for this tree: `DEFAULT_THRESHOLDS` in
> [`programs/turf_vault/src/state.rs`](programs/turf_vault/src/state.rs) and the
> instruction matrix in
> [`docs/VERIFICATION_MATRIX.md`](docs/VERIFICATION_MATRIX.md). Authoritative
> for the chain: [`docs/CURRENT_DEPLOYMENT.md`](docs/CURRENT_DEPLOYMENT.md).
>
> **The instruction LIST is v0.25's too.** Unreleased v0.26 DELETES
> `admin_create_user_account` and `admin_set_username` and adds four username
> registry instructions; the rows below still show the deployed pair. The
> "v0.26 — the username registry" subsection under
> [Instructions](#instructions) is authoritative for the difference.

![Anchor 0.32.1](https://img.shields.io/badge/Anchor-0.32.1-blue)
![Solana](https://img.shields.io/badge/Solana-Devnet-purple)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

## Overview

TurfVault is the on-chain backend for [Turf Monster](https://app.turfmonster.media), a sports pick'em app. It implements a "DeFi mullet" — a traditional Rails web app on top, Solana smart contract underneath.

> **Part of the McRitchie ecosystem** — see [`ECOSYSTEM.md`](https://github.com/amcritchie/mcritchie-studio/blob/main/docs/ECOSYSTEM.md) for the 5-repo map; [`house-burn-down.md`](https://github.com/amcritchie/mcritchie-studio/blob/main/docs/agents/system/house-burn-down.md) for fresh-Mac recovery.

TurfVault uses a server-facilitated self-custody model. User funds live in each user's own SPL token account (ATA), not in a pooled vault balance. Paid entries transfer the entry fee from the user ATA into a per-currency operator-revenue ATA; contest prizes are pre-funded into a per-contest prize-pool ATA and paid directly to winners on settlement. Rails handles UX and game logic, but the money-moving state transitions happen on-chain.

## Architecture

```
VaultState (PDA: "vault")
├── signers ([Pubkey; 3]) / threshold (u8)
├── payout_mint (USDC)
├── treasury_authority (Squads vault PDA)
├── accepted_currencies[16] (mint, op_rev_ata, kind, active)
├── paused
│
├── UserAccount (PDA: "user" + wallet)
│   ├── username ([u8; 32]), seeds
│   ├── entries, wins, cashes, total_won
│   └── wallet
│
├── UsernameRecord (PDA: "username" + lowercased name)   [v0.26, unreleased]
│   └── owner — a wallet holds the name; the ["vault"] PDA RESERVES it
│
├── Season (PDA: "season" + season_id)
│   └── name, seed_schedule ([u64; 5]), quest_seeds ([u64; 16]), start_at
│
├── EntryTokenAccount (PDA: "entry_token" + sha256(source_ref))
│   └── source, source_ref, consumed, consumed_at
│
└── Contest (PDA: "contest" + contest_id)
    ├── prize_pool, entry_fee_by_currency[16], entry_fees[16]
    ├── max_entries, current_entries, season_id
    ├── payout_amounts (Vec<u64>, max 10 ranks)
    ├── status: Open → Settled/Cancelled
    ├── lock_timestamp, conclusion_timestamp (lock is derived from time)
    │
    └── ContestEntry (PDA: "entry" + contest_id + wallet + entry_num)
        ├── status: Active → Won/Lost, currency_idx
        ├── rank, payout
        └── wallet, entry_num
```

### PDA Seeds

| Account | Seeds |
|---------|-------|
| VaultState | `["vault"]` |
| UserAccount | `["user", wallet]` |
| Contest | `["contest", contest_id]` |
| ContestEntry | `["entry", contest_id, wallet, entry_num (LE bytes)]` |
| Season | `["season", season_id (u32 LE bytes)]` |
| EntryTokenAccount | `["entry_token", sha256(source_ref)]` |
| GovernanceConfig *(v0.26, unreleased)* | `["governance"]` |
| MintWindow *(v0.26, unreleased)* | `["mint_window", window_index (i64 LE bytes)]` |
| UsernameRecord *(v0.26, unreleased)* | `["username", name lowercased + zero-padded to 32]` |

## Instructions

| Instruction | Params | Auth | Description |
|-------------|--------|------|-------------|
| `initialize` | `signers, threshold, treasury_authority` | `INIT_AUTHORITY` on mainnet | Create vault, pin payout mint + treasury authority, register USDC/USDT slots |
| `update_signers` | `new_signers` | 2-of-3 | Rotate signer pubkeys; threshold remains pinned at 2 |
| `register_currency` | `kind` | 2-of-3 | Add a mint to the currency registry and initialize its operator-revenue ATA |
| `deactivate_currency` | `currency_idx` | 2-of-3 | Disable a currency slot without reclaiming it |
| `pause` | `reason: [u8; 64]` | 2-of-3 | Block `enter_contest` and `enter_contest_with_token` |
| `unpause` | — | 2-of-3 | Clear the pause flag |
| `create_user_account` | `wallet, username` | Permissionless payer | Create per-wallet stat/username account |
| `set_username` | `username` | User signer | Update the wallet owner's username |
| `admin_create_user_account` | `wallet, username` | Payer + 1-of-3 | Create a user account with reserved-prefix waiver |
| `admin_set_username` | `username` | User signer + 1-of-3 | Set a reserved-prefix username with admin authorization |
| `create_season` | `season_id, name, seed_schedule, quest_seeds, start_at` | 1-of-3 | Create immutable seed schedule for a season |
| `create_contest` | `contest_id, season_id, entry_fee_by_currency, max_entries, payout_amounts, prize_pool, lock_timestamp` | 1-of-3 payer + creator | Initialize contest and fund its prize-pool ATA |
| `set_contest_lock_time` | `new_lock_timestamp` | 1-of-3 | Set or clear the derived entry lock time |
| `set_contest_conclusion_time` | `new_conclusion_timestamp` | 1-of-3 | Set or clear the contest conclusion timestamp |
| `enter_contest` | `entry_num, currency_idx` | User signer + 1-of-3 payer | Paid entry: transfer user ATA funds to operator-revenue ATA |
| `enter_contest_with_token` | `entry_num` | User signer + 1-of-3 payer | Entry funded by consuming an `EntryTokenAccount` |
| `mint_entry_token` | `source, source_ref, source_ref_hash` | 1-of-3 | Mint an idempotent pre-purchased entry voucher |
| `burn_entry_token` | `source_ref_hash` | 1-of-3 | Void an unspent entry voucher (operator claw-back); tombstones the account rather than closing it |
| `grant_seeds` | `amount, kind, invitee` | 1-of-3 | Grant quest/referral seeds outside the normal entry flow |
| `settle_contest` | `settlements: Vec<Settlement>` | 2-of-3 | Pay winners from the contest prize-pool ATA and update stats |
| `cancel_contest` | — | 2-of-3 | Refund the live prize-pool balance to the creator |
| `close_contest` | — | 1-of-3 | Close settled/cancelled contest accounts and reclaim rent |
| `sweep_operator_revenue` | `amount` | 2-of-3 | Move operator-revenue funds to the pinned treasury ATA |

### v0.26 (Unreleased) — the username registry

Not in the table above, which describes the deployed v0.25 program.

**One mechanism, not two.** A small PDA per name, keyed on the lowercased form,
holding the owner: absent means the name is free, a wallet owner means that
player holds it, and the `["vault"]` PDA as owner means the name is RESERVED.
So the blocked list is simply the set of names the vault claimed first — no
list to walk, nothing to resize, and each name pays its own rent. It is the
same init-as-a-lock technique `mint_entry_token` and `grant_seeds` have used
since v0.19, applied to names.

| Instruction | Params | Auth | Description |
|-------------|--------|------|-------------|
| `overwrite_username` | `username, name_key` | **3** (floor 3) | Rename any user, **without that user's signature**. Emits `UsernameOverwritten`. Waives the reserved-prefix branch; never the charset or length bar |
| `reserve_username` | `name_key` | **3** (floor 3) | Vault claims a free name — "add to the blocked list" |
| `release_reserved_username` | `name_key` | **3** (floor 3) | Vault returns a name to the pool — "lift a block". Rent goes to the pinned treasury |
| `backfill_username_record` | `name_key` | Permissionless payer | Migration only: lock the name a `UserAccount` already displays. No discretion — name and owner both come from the account's own fields |

**Changed:** `create_user_account` and `set_username` each take a `name_key`
(the username lowercased and zero-padded to 32 bytes — the record's PDA seed,
so it must be an argument; the handler re-derives it) and claim the record in
the same transaction. `set_username` additionally CLOSES the record for the
name given up, refunding its rent to the wallet.

**Deleted:** `admin_create_user_account` and `admin_set_username`. Both had
zero callers in Turf Monster, and `admin_set_username`'s one job — waiving the
reserved-prefix rule — now lives on `overwrite_username` at three signatures
instead of one. It required the renamed user to co-sign, which made it useless
against the only two things it was ever wanted for.

**Reserved prefixes stay.** A registry is exact-match, so it stops `admin` and
says nothing about `admin123`. The prefix list catches the lookalikes;
`xan` is added to it. Two mechanisms, clean division: prefix list = patterns,
registry = uniqueness and reservations. Homoglyph normalisation and rate
limiting remain Rails' concerns, deliberately.

**Off-chain derivation:** `scripts/lib/username-key.js`
(`canonicalKey`, `usernameRecordSeeds`), pinned against the program source by
`scripts/tests/username-key.test.js`.

### Settlement Struct

```rust
pub struct Settlement {
    pub wallet: Pubkey,
    pub entry_num: u32,
    pub rank: u32,
    pub payout: u64,
}
```

Settlement accounts are passed as `remaining_accounts` — triples of `[user_account, contest_entry, winner_usdc_ata]` per settlement, verified via PDA/ATA derivation.

## Account State

### VaultState
| Field | Type | Description |
|-------|------|-------------|
| `signers` | [Pubkey; 3] | The three multisig signers |
| `threshold` | u8 | Required sigs for treasury ops (2) |
| `payout_mint` | Pubkey | Pinned USDC payout mint |
| `treasury_authority` | Pubkey | Squads vault PDA that owns treasury sweep destination |
| `accepted_currencies` | [AcceptedCurrency; 16] | Registry of accepted entry currencies and operator-revenue ATAs |
| `bump` | u8 | PDA bump seed |
| `paused` | bool | Circuit breaker — when true, user-facing ops are blocked. Set via `pause` / cleared via `unpause` (both 2-of-3) |

### UserAccount
| Field | Type | Description |
|-------|------|-------------|
| `wallet` | Pubkey | Owner wallet |
| `username` | [u8; 32] | UTF-8 username, right-padded with `0x00`. Set on create or via `set_username` (user-signed) |
| `seeds` | u64 | Loyalty seeds earned through entries and explicit grants |
| `entries` | u32 | Lifetime successful entries |
| `wins` | u32 | Lifetime first-place finishes |
| `cashes` | u32 | Lifetime payout finishes |
| `total_won` | u64 | Lifetime USDC payouts received |
| `bump` | u8 | PDA bump seed |
| `username_registered` | u8 | *(v0.26, unreleased)* 1 once the username is locked by a `UsernameRecord`. Carved from the first byte of the reserved padding, so the account size is unchanged and every live account still deserializes |

### UsernameRecord *(v0.26, unreleased)*
| Field | Type | Description |
|-------|------|-------------|
| `owner` | Pubkey | A wallet holds the name; the `["vault"]` PDA means RESERVED. Never the zero key |
| `name` | [u8; 32] | The canonical (lowercased) name — the same bytes that seed the PDA |
| `claimed_at` | i64 | Chain time the record was created |
| `bump` | u8 | PDA bump seed |

97 bytes, about 0.0015 SOL of rent, refunded when the name is given up.

### Contest
| Field | Type | Description |
|-------|------|-------------|
| `contest_id` | [u8; 32] | SHA256 of Rails slug |
| `prize_pool` | u64 | USDC prize pool pre-funded by the creator |
| `entry_fee_by_currency` | [u64; 16] | Per-currency entry fee schedule |
| `entry_fees` | [u64; 16] | Per-currency operator-revenue tally |
| `max_entries` | u32 | Maximum entries allowed |
| `current_entries` | u32 | Current entry count |
| `status` | ContestStatus | Open / Settled / Cancelled. `Locked` remains in the enum only for discriminant compatibility; no current instruction sets it. |
| `payout_amounts` | Vec\<u64\> | USDC amount per rank (max 10, must sum to `prize_pool`) |
| `admin` | Pubkey | Payer pubkey (created the contest) |
| `creator` | Pubkey | Wallet that funded the `prize_pool` USDC |
| `season_id` | u32 | Season this contest is bound to (OPSEC-023) |
| `lock_timestamp` | i64 | Derived entry lock time; `0` means no scheduled lock |
| `conclusion_timestamp` | i64 | Derived conclusion time after which lock time cannot change |
| `bump` | u8 | PDA bump seed |

### ContestEntry
| Field | Type | Description |
|-------|------|-------------|
| `contest_id` | [u8; 32] | Parent contest |
| `wallet` | Pubkey | Entry owner |
| `entry_num` | u32 | Entry identifier (supports multiple per user) |
| `status` | EntryStatus | Active / Won / Lost |
| `rank` | u32 | Final placement |
| `payout` | u64 | Winnings (6 decimals) |
| `bump` | u8 | PDA bump seed |

## Contest Flow

```
Create → Enter → Settle → Close
  │        │        │        │
  │        │        │        └─ Reclaim rent (admin)
  │        │        └─ Assign ranks, credit winners (admin)
  │        └─ Transfer entry fee to operator revenue (user)
  └─ Set fee, max entries, payout tiers, pre-fund prize pool (admin/creator)
```

1. **Create**: Admin creates a contest with per-currency entry fees, max entries, payout amounts, the bound season, and a pre-funded USDC `prize_pool`
2. **Enter**: Users pay from their own ATA into operator revenue, or redeem an entry token. There is no vault balance debit
3. **Settle**: Admin submits a settlement array with rank + payout per entry. Winners receive direct USDC transfers from the prize-pool ATA. Total payouts are capped by `prize_pool`
4. **Close**: Admin closes the settled contest account, reclaiming rent to the admin wallet

## Token Support

- **USDC** and **USDT** — both 6 decimals (standard Solana SPL tokens)
- Slot 0 is the payout mint (USDC); slot 1 is USDT; slots 2-15 can be registered later
- Paid entries validate the selected currency slot before transferring from the user's ATA to operator revenue
- All amounts stored as `u64` with 6 decimal precision (1 USDC = 1,000,000)

## Development

See [`docs/CURRENT_DEPLOYMENT.md`](docs/CURRENT_DEPLOYMENT.md) for live deployment identity and [`docs/VERIFICATION_MATRIX.md`](docs/VERIFICATION_MATRIX.md) for the current instruction proof checklist.

### Prerequisites

- [Rust](https://rustup.rs/) 1.89+
- [Solana CLI](https://docs.solanalabs.com/cli/install) 2.x
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) 0.32.1
- [Node.js](https://nodejs.org/) + Yarn

### Build

```bash
anchor build
```

### Test

```bash
anchor test
```

Tests run against a local validator. The TypeScript suite is aligned to the
current self-custody instruction surface and no longer covers retired
deposit/withdraw balance flows.

Use [`docs/VERIFICATION_MATRIX.md`](docs/VERIFICATION_MATRIX.md) as the coverage
map and latest local proof record. If the default validator port is occupied,
use the alternate-port direct path in [`RUNBOOK.md`](RUNBOOK.md).

**CI runs this too, since 2026-09-15** — see
[The Anchor suite lane](#the-anchor-suite-lane) below. A plain `anchor test`
works only on a machine that already holds `target/deploy/turf_vault-keypair.json`
(gitignored, and a secret): without it `anchor build` mints a RANDOM program
keypair and every test fails `DeclaredProgramIdMismatch`. The keypair-free recipe
CI uses — load the built `.so` at the declared address at genesis — is in
[`docs/VERIFICATION_MATRIX.md`](docs/VERIFICATION_MATRIX.md) under
**Keeping it armed**, and is the one to use on a fresh checkout.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request
and on every push to `main`, `release` and `accepted`:

| Job | Runs | Catches |
|-----|------|---------|
| `program` | `cargo check --workspace --all-targets --locked` | the program (and every `#[derive(Accounts)]` expansion) no longer compiles, or `Cargo.lock` is out of sync |
| `program` | `cargo clippy -- -D clippy::correctness` | code clippy classes as outright wrong |
| `program` | `cargo test --workspace --locked` | a `VaultState` field offset moved, a governance threshold or floor changed, or the reserved error block stopped ending at 6059. Added 2026-09-15 — `cargo check` above COMPILES `#[cfg(test)]` code without running it, so these assertions could have reported green having never executed |
| `guards` | `npm run check:doc-op-refs` | a 1Password vault reference in this repo's prose has gone stale |
| `guards` | `npm run test:scripts` | a shape regression in the deploy scripts, the Anchor suite lane being removed or moved into this workflow, or the eviction test leaving the suite — `npm run test:scripts` reports **170 passing**, measured 2026-09-15 (155 top-level `test()` cases across 12 files; the rest are subtests). Re-derive rather than quote it. 26 cover `scripts/lib/mainnet-config.js` and `scripts/initialize-mainnet.js`; 5 of those 26 drive the real checked-in `scripts/squad.json` and the other 21 are fixture mutations or a source read — the split is measured in [What it covers](docs/VERIFICATION_MATRIX.md#what-it-covers). One case self-skips here, where no `node_modules` is installed. 24 more grade the Squads upgrade path (the signer planner, the script's text, and the script executed end to end against stubs), 10 are the Anchor-suite lane guard below, and 6 hold `bin/release-check` identical to this table and refuse a validator lane in it |

The `CI` workflow is **build-and-check only** — it never starts a validator,
holds a keypair, or spends SOL. The Anchor Suite lane below does start a
validator, on the loopback interface, and still holds no keypair and reaches no
real cluster; `scripts/tests/anchor-suite-lane.test.js` asserts that of every
workflow in this repo.

### The Anchor suite lane

[`.github/workflows/anchor-suite.yml`](.github/workflows/anchor-suite.yml)
(workflow name **Anchor Suite**) is the only automated thing in this repo that
RUNS THE PROGRAM. It installs a pinned Agave CLI and a pinned prebuilt
`anchor-cli`, runs `anchor build`, starts `solana-test-validator` with the built
`.so` loaded at the DECLARED program ID, and executes `tests/turf_vault.ts` —
45 `it()` blocks, the suite
[`docs/VERIFICATION_MATRIX.md`](docs/VERIFICATION_MATRIX.md) is organised
around. Measured 2026-09-15: **45 passing, 0 failing**.

| Trigger | Why |
|---------|-----|
| `pull_request`, path-filtered to `programs/**`, `tests/**`, `Anchor.toml`, `Cargo.*`, `rust-toolchain.toml`, `package.json`, `yarn.lock`, `tsconfig.json`, and the workflow itself | Those are the only paths whose change the suite can catch. A docs or scripts PR pays no validator time. |
| `push` to `main`, `release`, `accepted`, same filter | `accepted` carries a combination of individually-green changes no PR run ever executed. |
| `schedule`, daily | The belt: every other trigger is change-driven, so a quiet week would leave the suite unrun on `main`. |
| `workflow_dispatch` | The clean-machine run before a Squads upgrade. |

**It is a separate workflow from `CI` on purpose.** McRitchie Studio's release
guard resolves this repo's suite workflow by the literal name `CI` and refuses to
promote `accepted` when it is not green, and it also refuses a `CI` workflow that
carries a `paths:` filter. A validator lane inside `CI` would therefore block the
release sweep on a flaky runner, and could not be filtered. So `CI` stays fast,
unfiltered and always-run; **Anchor Suite** is slow, filtered and deep. The local
cert (`bin/release-check`, below) runs `CI`'s four lanes and NOT the suite — a
cert that demanded a validator would fail `COULD NOT RUN` on any machine without
the Solana toolchain.

**No keypair, no real cluster.** `target/deploy/turf_vault-keypair.json` is a
secret and is never given to a runner; on a fresh checkout `anchor build` mints a
random one, which would fail every test with `DeclaredProgramIdMismatch`. The
lane never deploys — it loads the `.so` at the declared address at genesis with
`--upgradeable-program`, and generates an ephemeral wallet that is the genesis
mint. Both facts, plus the trigger list and the eviction test's presence, are
pinned by
[`scripts/tests/anchor-suite-lane.test.js`](scripts/tests/anchor-suite-lane.test.js),
which runs in the fast `guards` lane so it reports even when the suite lane is
filtered out.

What the lane does NOT cover — the mainnet-featured binary, the paths outside the
filter, and anything about the live vaults — is written down under
[The Compensating Control](docs/VERIFICATION_MATRIX.md#the-compensating-control-and-what-it-does-not-cover).

Deliberately NOT in CI, each because making it green means changing the program
or the deploy scripts rather than adding a workflow:

- **`cargo fmt --check`** — the tree is not rustfmt-clean; making it so rewrites
  ~947 lines across all 25 program files and destroys `git blame` on a program
  that custodies real assets.
- **`cargo clippy -D warnings`** — 4 pre-existing `style`/`complexity` findings,
  two of which need real logic changes. They still print as warnings in the
  `program` job, so the debt stays visible.
- **`npm run lint`** (Prettier) — **22 files are unformatted** (measured
  2026-09-15; 20 of them on `accepted` before that day's upgrade-path work), so
  wiring this lane is a whole-tree reformat, not a tidy-up. The figure recorded
  here until 2026-09-15 said "two scripts", which had been wrong for long enough
  that nobody re-measured; the accompanying 219→326-line claim about
  `scripts/squad-upgrade.js` described a file the rewrite replaced. Re-measure
  with `npm run lint` rather than quoting either. Its glob covers
  `tests/turf_vault.ts`, which the Anchor Suite lane already type-checks on the
  way to running it — so wiring Prettier would buy formatting, not coverage.

### Running the gate locally

```bash
bin/release-check          # the four lanes above, cheapest first, ~1s warm
bin/release-check --list   # print the lane table without running it
```

[`bin/release-check`](bin/release-check) is this repo's own answer to "is this
tree certifiable?", and it is what the studio's cert runs: McRitchie Studio's
`config/release_repos.yml` names it on the `turf-vault` row
(`release_check: bin/release-check`), so `bin/fast-check` and
`bin/full-suite-check` execute this script as the whole gate for this repo
instead of the Rails lanes it has no runner for. Before 2026-09-14 that row
spelled the four lanes out as a hub-side `&&` chain — a copy of this file's CI,
kept in another repo.

The lanes are still written twice, here and in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), because CI runs `guards`
and `program` as parallel jobs with separate caches and a single job calling this
script would serialise the sub-second Node lanes behind a cold Rust compile. So
the two are held identical by
[`scripts/tests/release-check-covers-ci.test.js`](scripts/tests/release-check-covers-ci.test.js),
which runs `--list`, extracts every lane from the workflow, and fails in EITHER
direction — a lane CI runs and the script does not (the local cert would cover
less than the verdict it is credited against), or a lane only the script runs
(a gate `accepted` is never held to). It runs in the `guards` lane itself.

### Deploy

The program upgrade authority is a Squads V4 multisig (OPSEC-002, 2026-05-19), so **`anchor deploy` is not the upgrade path for an existing deployed program**. Upgrades go through the Squad via `scripts/squad-upgrade.js --cluster=<devnet|mainnet> <BUFFER>`, which is a dry run until `--send`.

Both multisigs are **3-of-5** as of 2026-09-15, and deliberately asymmetric: the agent holds three devnet seats and can upgrade devnet alone, but only two mainnet seats, so a mainnet run creates the transaction, casts what it can, and **stops for Mr. McRitchie's approval**. `node scripts/squad-inventory.js` reads both multisigs and says which path an upgrade would take. See [`docs/CURRENT_DEPLOYMENT.md`](docs/CURRENT_DEPLOYMENT.md) for the current authority and upgrade rule.

```bash
# Verify the deployed program
solana program show EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ --url devnet
```

## Versioning

This project uses semantic versioning with git tags and a [CHANGELOG](./CHANGELOG.md).

- **MAJOR**: Breaking account layout changes (requires migration)
- **MINOR**: New instructions or features
- **PATCH**: Bug fixes, validation improvements

Each deploy is tagged (e.g. `v0.1.0`) and documented in the changelog. See `Cargo.toml` for the current version.

## Security

- **2-of-3 multisig**: Treasury/governance ops (`settle_contest`, `cancel_contest`, `sweep_operator_revenue`, currency registry changes, pause/unpause, signer rotation) require two distinct signers; routine ops require any 1-of-3
- **Squads upgrade authority**: Program upgrades require a Squads V4 cosign (OPSEC-002) — no single-key code deployment. Both clusters are 3-of-5 since 2026-09-15; on mainnet the agent holds only two seats, so a mainnet upgrade cannot complete without Mr. McRitchie
- **PDA verification**: Settlement uses manual PDA derivation to verify all remaining accounts
- **Checked arithmetic**: All math uses `checked_add`/`checked_sub` with overflow errors
- **Payout cap**: Settlement validates total payouts ≤ `prize_pool`
- **Payout tier check**: `payout_amounts` must sum exactly to the contest's `prize_pool`
- **Mint validation**: Paid entries use registered active currency slots and canonical mint accounts

## Related

- [Turf Monster](https://app.turfmonster.media) — Rails pick'em app that integrates with this vault
- [Anchor Framework](https://www.anchor-lang.com/) — Solana development framework

## License

MIT
