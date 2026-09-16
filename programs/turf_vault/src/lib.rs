//! TurfVault — Solana escrow program for Turf Monster contests.
//!
//! v0.16 server-signed self-custody model (NOT custodial-balance):
//!   - **VaultState** is the singleton holding signers, payout mint pin,
//!     treasury authority pin, the on-chain currency registry, and a pause flag.
//!   - **UserAccount** is per-wallet — holds on-chain stat counters
//!     (entries, wins, cashes, total_won), loyalty seeds, and username.
//!     Funds live in user ATAs, NOT in the vault.
//!   - **Contest** holds the per-currency entry-fee schedule, a USDC
//!     prize pool (held in a per-contest [b"prize_pool", contest_id] ATA),
//!     payout tiers, and is bound to one **Season** (seed schedule).
//!   - **ContestEntry** is per (contest × wallet × entry_num).
//!   - **EntryTokenAccount** is a pre-purchased free-entry voucher.
//!
//!   - **GovernanceConfig** holds the per-action signature thresholds.
//!   - **MintWindow** counts entry-token mints inside one cap window.
//!   - **UsernameRecord** is the lock on one name. Its EXISTENCE is
//!     uniqueness; an `owner` of the vault PDA is a RESERVATION, so the
//!     blocked list and the uniqueness index are one mechanism.
//!
//! Auth model (v0.26 — five signers, thresholds stored as DATA):
//!
//! Up to FIVE signer slots live on `VaultState` (`signers` ++ `signers_ext`),
//! and the number of signatures each action needs is looked up per-action in
//! `GovernanceConfig` rather than baked into the instruction shape. Every
//! vault-authorized instruction routes through ONE function,
//! `instructions::governance::authorize`; nothing else reads the signer set
//! for authorization.
//!
//! | action                                    | default |
//! |-------------------------------------------|---------|
//! | settle / cancel / sweep                   |    3    |
//! | register_currency / deactivate_currency   |    3    |
//! | create_season                             |    3    |
//! | update_signers                            |    3 (floor 3) |
//! | unpause                                   |    3 (floor 3) |
//! | set_action_threshold / mint window policy |    3 (floor 3) |
//! | burn_entry_token                          |    3    |
//! | mint_entry_token — above the window cap   |    3    |
//! | pause                                     |    2    |
//! | close_contest                             |    2    |
//! | set_contest_lock_time / conclusion_time   |    2 (3 to re-open / amend) |
//! | mint_entry_token — within the cap         |    1    |
//! | grant_seeds                               |    1    |
//! | overwrite / reserve / release username    |    3 (floor 3) |
//! | create_contest / enter_contest            |    1 + the user's own signature |
//!
//! THE SHAPE OF THE FIX. The agent system is reachable by two of the five
//! slots and no more, so it can pull the brake (pause, 2) but cannot lift it
//! (unpause, 3), cannot move money (3), and cannot rotate the signer set (3,
//! on a floor that three signatures cannot lower). The operator alone reaches
//! three personal wallets, so he can govern — and evict a captured system —
//! without anyone's cooperation.
//!
//!   - **User signature**: enter_contest{,_with_token}, set_username,
//!     create_contest (as creator funding the prize pool).
//!   - **INIT_AUTHORITY constant** (Alex Phantom key): one-time `initialize` call.
//!
//! For each instruction's full contract, see its file under `instructions/`.

use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod instructions;

#[cfg(test)]
mod governance_tests;

#[cfg(test)]
mod username_registry_tests;

#[cfg(test)]
mod auth_header_tests;

use instructions::*;
use state::MAX_SIGNERS;

// Cluster-gated declare_id!. Devnet/localnet builds compile-time bind to the
// current devnet program. Mainnet builds (--features mainnet) bind to the
// current mainnet program ID. See docs/CURRENT_DEPLOYMENT.md for live identity;
// KEY_ROTATION.md and MAINNET_LAUNCH.md are historical artifacts only.
//
// Anchor.toml's [programs.*] entries are advisory (CLI tooling) and MUST
// agree with whichever declare_id! the active feature set selects.
#[cfg(not(feature = "mainnet"))]
declare_id!("EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ");

#[cfg(feature = "mainnet")]
declare_id!("DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM");

#[program]
pub mod turf_vault {
    use super::*;

    // ── Vault setup ───────────────────────────────────────────────────────

    /// One-time setup of the singleton vault. Pins payout mint to USDC,
    /// registers slot 0 (USDC) + slot 1 (USDT) in the currency registry,
    /// stores the Squads vault PDA as treasury authority, and locks in the
    /// multisig signer set + threshold. Only callable by INIT_AUTHORITY
    /// on a mainnet build.
    pub fn initialize(
        ctx: Context<Initialize>,
        signers: [Pubkey; 3],
        threshold: u8,
        treasury_authority: Pubkey,
    ) -> Result<()> {
        handle_initialize(ctx, signers, threshold, treasury_authority)
    }

    /// Rotate the multisig signer set IN PLACE (no redeploy). Up to FIVE
    /// slots since v0.26, left-packed, `Pubkey::default()` meaning empty.
    ///
    /// Auth: `gov_action::UPDATE_SIGNERS` (default 3, IMMOVABLE FLOOR 3 — the
    /// floor is what stops three signatures lowering the bar to two and
    /// handing the vault back to the two agent-reachable keys).
    ///
    /// Enforces: no gaps, no duplicates (`DuplicateSigner` 6014), a set large
    /// enough for every live threshold (`SignerSetTooSmall` 6052), and
    /// continuity — at least `threshold` of the keys that AUTHORIZED the
    /// rotation must survive it (`SignerContinuityRequired` 6017), the N-of-M
    /// generalization of v0.20's both-cosigners rule.
    pub fn update_signers(
        ctx: Context<UpdateSigners>,
        new_signers: [Pubkey; MAX_SIGNERS],
    ) -> Result<()> {
        handle_update_signers(ctx, new_signers)
    }

    // ── Governance configuration ──────────────────────────────────────────

    /// Create the per-action threshold table with the program's shipped
    /// defaults. Takes NO arguments, which is what makes a 2-signature
    /// bootstrap safe — it cannot install weak numbers, only the safe ones.
    ///
    /// MUST BE CALLED IMMEDIATELY AFTER THE v0.26 UPGRADE: every
    /// vault-authorized instruction requires this account to exist.
    pub fn init_governance(ctx: Context<InitGovernance>) -> Result<()> {
        handle_init_governance(ctx)
    }

    /// Retune one action's required signature count. 3-of-N, floored per
    /// action. This is what makes every shipped default reversible by
    /// transaction instead of by redeploy.
    pub fn set_action_threshold(
        ctx: Context<SetActionThreshold>,
        action: u8,
        value: u8,
    ) -> Result<()> {
        handle_set_action_threshold(ctx, action, value)
    }

    /// Retune the entry-token mint cap (window length + per-window ceiling).
    /// 3-of-N.
    pub fn set_mint_window_policy(
        ctx: Context<SetMintWindowPolicy>,
        window_seconds: i64,
        cap: u32,
    ) -> Result<()> {
        handle_set_mint_window_policy(ctx, window_seconds, cap)
    }

    // ── Currency registry ─────────────────────────────────────────────────

    /// Add a currency to `accepted_currencies` at the first empty slot.
    /// Creates the per-currency operator-revenue ATA. `REGISTER_CURRENCY` (3).
    pub fn register_currency(ctx: Context<RegisterCurrency>, kind: u8) -> Result<()> {
        handle_register_currency(ctx, kind)
    }

    /// Flip `accepted_currencies[idx].active = 0`. The slot is never
    /// reclaimed — preserves currency_idx stability. `DEACTIVATE_CURRENCY` (3).
    pub fn deactivate_currency(
        ctx: Context<DeactivateCurrency>,
        currency_idx: u8,
    ) -> Result<()> {
        handle_deactivate_currency(ctx, currency_idx)
    }

    // ── Pause control ─────────────────────────────────────────────────────

    /// Emergency stop: blocks enter_contest{,_with_token}. `PAUSE` (2). `reason`
    /// is logged on-chain (UTF-8 zero-padded to 64 bytes).
    pub fn pause(ctx: Context<PauseVault>, reason: [u8; 64]) -> Result<()> {
        handle_pause(ctx, reason)
    }

    /// Lift the emergency stop. `UNPAUSE` (3, floored) — deliberately HARDER
    /// than pausing, so a captured system can pull the brake but never release it.
    pub fn unpause(ctx: Context<UnpauseVault>) -> Result<()> {
        handle_unpause(ctx)
    }

    // ── User accounts ─────────────────────────────────────────────────────

    /// Create a new per-wallet UserAccount PDA AND claim its username in the
    /// registry. Permissionless payer. Fails with `UsernameAlreadyClaimed`
    /// (6060) if the name is held by another account or reserved by the vault.
    pub fn create_user_account(
        ctx: Context<CreateUserAccount>,
        wallet: Pubkey,
        username: [u8; 32],
        name_key: [u8; 32],
    ) -> Result<()> {
        handle_create_user_account(ctx, wallet, username, name_key)
    }

    /// Set / overwrite the username on a UserAccount. Owner signs.
    ///
    /// Claims `name_key` in the registry, and CLOSES the record for the name
    /// given up (refunding its rent to the wallet) when the canonical key
    /// really changes. `name_key` is the username lowercased and zero-padded
    /// to 32 bytes — it is the `UsernameRecord` PDA seed, so it has to be an
    /// argument; the handler re-derives it and refuses a mismatch
    /// (`UsernameKeyMismatch`, 6061), the same shape `mint_entry_token` uses
    /// for `source_ref_hash`.
    pub fn set_username(
        ctx: Context<SetUsername>,
        username: [u8; 32],
        name_key: [u8; 32],
    ) -> Result<()> {
        handle_set_username(ctx, username, name_key)
    }

    // ── Username registry ─────────────────────────────────────────────────

    /// Rename any user WITHOUT that user's signature.
    /// `OVERWRITE_USERNAME` (3, FLOOR 3) and an `UsernameOverwritten` event on
    /// every use.
    ///
    /// Replaces `admin_set_username`, which required the account owner to
    /// co-sign and was therefore useless against the only two things it was
    /// ever wanted for — a squatter and a slur, neither of whom will consent.
    /// Dropping consent is safe at three-of-five because no agent can reach
    /// three, and the FLOOR is what keeps that true against a retune.
    pub fn overwrite_username(
        ctx: Context<OverwriteUsername>,
        username: [u8; 32],
        name_key: [u8; 32],
    ) -> Result<()> {
        handle_overwrite_username(ctx, username, name_key)
    }

    /// Take a free name off the market — the blocked list, as a claim the
    /// vault makes rather than a list anyone walks. `RESERVE_USERNAME`
    /// (3, FLOOR 3). Idempotent; refuses a name a player already holds.
    pub fn reserve_username(ctx: Context<ReserveUsername>, name_key: [u8; 32]) -> Result<()> {
        handle_reserve_username(ctx, name_key)
    }

    /// Put a reserved name back in the pool. `RELEASE_USERNAME` (3, FLOOR 3) —
    /// a reservation is a brake, and nothing an agent reaches alone lifts a
    /// brake. Rent goes to the pinned treasury, not to the caller.
    pub fn release_reserved_username(
        ctx: Context<ReleaseReservedUsername>,
        name_key: [u8; 32],
    ) -> Result<()> {
        handle_release_reserved_username(ctx, name_key)
    }

    /// MIGRATION ONLY: lock the name a `UserAccount` already displays.
    /// Permissionless — it has no discretion, taking both the name and the
    /// owner from the account's own fields, so it can only assert what the
    /// chain already says. 47 production users, zero case-insensitive
    /// duplicates (measured 2026-09-15), so this reconciles nothing.
    pub fn backfill_username_record(
        ctx: Context<BackfillUsernameRecord>,
        name_key: [u8; 32],
    ) -> Result<()> {
        handle_backfill_username_record(ctx, name_key)
    }

    // ── Seasons ───────────────────────────────────────────────────────────

    /// Create a Season with an immutable per-entry seed-award schedule.
    /// `CREATE_SEASON` (3) — it sets the per-entry seed schedule with no
    /// upper bound checked, so a single key must not write it.
    pub fn create_season(
        ctx: Context<CreateSeason>,
        season_id: u32,
        name: [u8; 32],
        seed_schedule: [u64; 5],
        quest_seeds: [u64; 16],
        start_at: i64,
    ) -> Result<()> {
        handle_create_season(ctx, season_id, name, seed_schedule, quest_seeds, start_at)
    }

    // ── Contest lifecycle ─────────────────────────────────────────────────

    /// Create a new contest with a per-currency entry-fee schedule and a
    /// USDC prize pool. Dual-signer: payer (admin bot, pays SOL rent) +
    /// creator (Phantom wallet, signs prize-pool USDC transfer).
    pub fn create_contest(
        ctx: Context<CreateContest>,
        contest_id: [u8; 32],
        season_id: u32,
        entry_fee_by_currency: [u64; 16],
        max_entries: u32,
        payout_amounts: Vec<u64>,
        prize_pool: u64,
        lock_timestamp: i64,
    ) -> Result<()> {
        handle_create_contest(
            ctx,
            contest_id,
            season_id,
            entry_fee_by_currency,
            max_entries,
            payout_amounts,
            prize_pool,
            lock_timestamp,
        )
    }

    /// Set (or clear) a contest's derived lock timestamp.
    /// `SET_CONTEST_LOCK_TIME` (2), escalating to
    /// `SET_CONTEST_LOCK_TIME_REOPEN` (3) once the lock has already passed.
    /// `new_lock_timestamp == 0` clears the lock (enterable indefinitely); any
    /// non-zero Unix-seconds value locks entries once chain time passes it.
    /// "Lock now" = pass the current chain time. Rejected once the contest is
    /// concluded (interim guard: Settled/Cancelled).
    pub fn set_contest_lock_time(
        ctx: Context<SetContestLockTime>,
        new_lock_timestamp: i64,
    ) -> Result<()> {
        handle_set_contest_lock_time(ctx, new_lock_timestamp)
    }

    /// Set (or clear) a contest's conclusion timestamp (v0.18).
    /// `SET_CONTEST_CONCLUSION_TIME` (2), escalating to `..._AMEND` (3) to
    /// change one already set. Once
    /// chain time passes it the contest has concluded — set_contest_lock_time
    /// then rejects. `new_conclusion_timestamp == 0` clears it. Rejected once
    /// the contest has already concluded or is settled/cancelled.
    pub fn set_contest_conclusion_time(
        ctx: Context<SetContestConclusionTime>,
        new_conclusion_timestamp: i64,
    ) -> Result<()> {
        handle_set_contest_conclusion_time(ctx, new_conclusion_timestamp)
    }

    /// Grade a contest. Per-winner SPL transfer from the contest's USDC
    /// prize-pool PDA → winner's USDC ATA. `SETTLE_CONTEST` (3). Extra
    /// cosigners LEAD `remaining_accounts`, ahead of the winner triples.
    pub fn settle_contest<'info>(
        ctx: Context<'_, '_, '_, 'info, SettleContest<'info>>,
        settlements: Vec<Settlement>,
    ) -> Result<()> {
        handle_settle_contest(ctx, settlements)
    }

    /// Refund the prize pool to the creator. Open / Locked → Cancelled.
    /// `CANCEL_CONTEST` (3).
    pub fn cancel_contest(ctx: Context<CancelContest>) -> Result<()> {
        handle_cancel_contest(ctx)
    }

    /// Close a settled or cancelled contest's PDA + prize_pool ATA,
    /// reclaiming rent to the admin. Sweeps residual prize_pool dust to
    /// the operator-revenue USDC ATA first (decided 2026-05-27, §11 Q8).
    /// `CLOSE_CONTEST` (2). v0.26: reclaimed rent is paid to the pinned
    /// TREASURY, not to whichever signer happened to call it.
    pub fn close_contest(ctx: Context<CloseContest>) -> Result<()> {
        handle_close_contest(ctx)
    }

    // ── Entries ───────────────────────────────────────────────────────────

    /// Generic single-canonical entry handler. User signs an SPL transfer
    /// from their ATA → the chosen currency's operator-revenue ATA. Creates
    /// a ContestEntry PDA, awards seeds, increments stat counters.
    /// Blocked when vault is paused.
    pub fn enter_contest(
        ctx: Context<EnterContest>,
        entry_num: u32,
        currency_idx: u8,
    ) -> Result<()> {
        handle_enter_contest(ctx, entry_num, currency_idx)
    }

    /// Entry funded by consuming an EntryTokenAccount instead of paying
    /// any currency. Wallet co-signs (OPSEC-004). Blocked when vault is paused.
    pub fn enter_contest_with_token(
        ctx: Context<EnterContestWithToken>,
        entry_num: u32,
    ) -> Result<()> {
        handle_enter_contest_with_token(ctx, entry_num)
    }

    // ── Free entries ──────────────────────────────────────────────────────

    /// Mint a new EntryTokenAccount for a user. `MINT_ENTRY_TOKEN` (1)
    /// within the per-window cap, `MINT_ENTRY_TOKEN_OVER_CAP` (3) above it —
    /// v0.26 closed the uncapped 1-of-N value-creation hole.
    /// PDA is derived from sha256(source_ref) (v0.19, audit #9) — re-minting the
    /// same source_ref collides on init for true on-chain idempotency.
    pub fn mint_entry_token(
        ctx: Context<MintEntryToken>,
        source: u8,
        source_ref: [u8; 64],
        source_ref_hash: [u8; 32],
        window_index: i64,
    ) -> Result<()> {
        handle_mint_entry_token(ctx, source, source_ref, source_ref_hash, window_index)
    }

    /// Void an unspent EntryTokenAccount — the operator claw-back counterpart to
    /// mint_entry_token. `BURN_ENTRY_TOKEN` (3); the owner does NOT sign.
    /// Three because it destroys user property at no cost to the destroyer and
    /// pause does not stop it. It was written but NEVER DEPLOYED at 1-of-N, so
    /// shipping at 3 regresses nothing — and it is retunable downward.
    ///
    /// TOMBSTONE, not close: Rails reads what a user is owed off the on-chain
    /// token COUNT, so closing the PDA would make the burn re-read as owed and
    /// re-mint itself. The account survives with `consumed = true` (blocks the
    /// spend, reusing enter_contest_with_token's existing constraint) and
    /// `source |= BURNED_FLAG` (tells a burn apart from a real redemption). No
    /// new field, so accounts minted before this upgrade still deserialize.
    ///
    /// `source_ref_hash` seed-binds the target as a FAT-FINGER GUARD, not a
    /// targeting control: a burn must name its token twice, so an INCONSISTENT
    /// pair fails the seeds check. A SELF-CONSISTENT one does not — pass another
    /// token together with that token's own hash and both the seeds check and the
    /// handler's re-derivation hold, and that token burns. Nothing restricts WHICH
    /// voucher a signer may burn, so an authorized quorum can burn any unspent voucher
    /// on the platform (see `docs/KEY_ROTATION.md` R1b).
    pub fn burn_entry_token(
        ctx: Context<BurnEntryToken>,
        source_ref_hash: [u8; 32],
    ) -> Result<()> {
        handle_burn_entry_token(ctx, source_ref_hash)
    }

    // ── Seed grants ───────────────────────────────────────────────────────

    /// Credit a fixed `amount` of loyalty seeds into a user's UserAccount,
    /// OUTSIDE the entry flow (Rails "quest" bonuses: first username change,
    /// newsletter join, friend-invite-entered). `GRANT_SEEDS` (1); the user
    /// does not sign. Idempotent per (user, kind[, invitee]) via the SeedGrant
    /// init-guard PDA. `kind` ∈ seed_grant_kind::*; `invitee` is the friend's
    /// wallet for INVITE_FRIEND and Pubkey::default() otherwise. v0.26: an
    /// INVITE_FRIEND grant must also name the invitee's own UserAccount, which
    /// must have entered a contest — the guard binds to a real account instead
    /// of a caller-chosen number.
    pub fn grant_seeds(
        ctx: Context<GrantSeeds>,
        amount: u64,
        kind: u8,
        invitee: Pubkey,
    ) -> Result<()> {
        handle_grant_seeds(ctx, amount, kind, invitee)
    }

    // ── Treasury ──────────────────────────────────────────────────────────

    /// Drain a per-currency operator-revenue ATA to the pinned treasury
    /// wallet's ATA. `amount = 0` sweeps all. `SWEEP_OPERATOR_REVENUE` (3).
    pub fn sweep_operator_revenue(
        ctx: Context<SweepOperatorRevenue>,
        amount: u64,
    ) -> Result<()> {
        handle_sweep_operator_revenue(ctx, amount)
    }
}
