//! The username registry — uniqueness and the blocked list as ONE mechanism.
//!
//! ── THE IDEA ──────────────────────────────────────────────────────────────
//!
//! A small PDA per name, keyed on the lowercased form, holding the owner:
//!
//!   absent                 the name is free
//!   owned by a wallet      that player holds it
//!   owned by the VAULT     reserved — nobody can take it
//!
//! So the blocked list is not a second structure. It is the set of names the
//! vault claimed first. Adding a block is `reserve_username`; lifting one is
//! `release_reserved_username`. There is no list to walk, nothing to resize,
//! and growth is unbounded because each name pays its own rent — the three
//! problems an on-chain array of blocked names would have had.
//!
//! ── WHAT LIVES HERE AND WHAT LIVES NEXT DOOR ──────────────────────────────
//!
//! This file holds the two VAULT-AUTHORIZED registry instructions plus the
//! permissionless migration one. The claim itself is exercised from four
//! places, so the two rules every caller must obey — claim-or-confirm, and
//! what to do with the record for the name being left behind — are functions
//! here rather than four copies:
//!
//!   `claim_or_confirm`        create the record, or prove the claimant
//!                             already holds it
//!   `settle_previous_record`  decide whether the OLD name's record is
//!                             required, and refuse the shapes that are not
//!
//! `overwrite_username` (the 3-of-N, no-consent rename) is its own file.
//! `set_username` and `create_user_account` call in from theirs.
//!
//! ── THE RESERVED-PREFIX LIST IS STILL THERE, ON PURPOSE ───────────────────
//!
//! A registry is exact-match: it stops a second "admin" and says nothing about
//! "admin123". The eleven prefixes in `set_username.rs` (twelve now, with
//! `xan`) keep catching the lookalikes. Two mechanisms, clean division —
//! prefix list = patterns, registry = uniqueness and reservations.
//!
//! The quorum-authorized instructions here and in `overwrite_username.rs`
//! WAIVE the prefix branch and keep charset + length, which is where the
//! deleted `admin_*_username` pair's only real job now lives: at three
//! signatures instead of one.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::governance::{authorize, named_signers};
use crate::instructions::set_username::{
    canonical_username_key, require_canonical_form, require_canonical_key,
    validate_username_charset_len,
};
use crate::state::{gov_action, GovernanceConfig, UserAccount, UsernameRecord, VaultState};

// ──────────────────────────────────────────────────────────────────────────
// EVENTS — the audit trail, and it is very nearly free
// ──────────────────────────────────────────────────────────────────────────
//
// An Anchor event is a base64 line in the transaction log. It costs no rent
// and occupies no account, so recording who did what and when is close to
// free — which is the whole answer to "a trail, depending on how expensive".
//
// They are also what makes an off-chain reconciler possible without scanning
// every PDA the program owns: Rails can follow the log forward from a slot
// instead of enumerating names. Every write path in the registry emits one.

/// A name was claimed by, or confirmed for, a player.
#[event]
pub struct UsernameClaimed {
    pub owner: Pubkey,
    /// Canonical (lowercased) name — the registry key.
    pub name: [u8; 32],
    /// The display form written to the `UserAccount`, case preserved.
    pub display_name: [u8; 32],
    /// The name given up, or zeros when there was none.
    pub previous_name: [u8; 32],
    pub timestamp: i64,
}

/// The vault took a name off the market.
#[event]
pub struct UsernameReservationCreated {
    pub name: [u8; 32],
    /// The NAMED vault signer on the transaction. The other authorizing
    /// signatures are in the transaction itself; this is the one the
    /// instruction can point at.
    pub authorized_by: Pubkey,
    /// How many distinct vault signatures the stored table demanded.
    pub signatures_required: u8,
    pub timestamp: i64,
}

/// The vault put a name back in the pool. It is claimable by anyone from the
/// next transaction onward — that is what releasing means.
#[event]
pub struct UsernameReservationReleased {
    pub name: [u8; 32],
    pub authorized_by: Pubkey,
    pub signatures_required: u8,
    pub timestamp: i64,
}

// ──────────────────────────────────────────────────────────────────────────
// THE TWO SHARED RULES
// ──────────────────────────────────────────────────────────────────────────

/// Create the record for `name_key` owned by `owner`, or — when it already
/// exists — prove that `owner` is the one who holds it.
///
/// ── HOW "FRESHLY CREATED" IS DETECTED, AND WHY IT IS EXACT ────────────────
///
/// Every caller declares the account `init_if_needed`, which does not report
/// whether it allocated. A newly allocated account is all zeros after its
/// discriminator, so `owner == Pubkey::default()` means "just created" — and
/// that reading is exact rather than probabilistic, because NO path in this
/// program ever stores a default owner: a player record is written from a
/// `Signer`'s key and a reservation from the `[b"vault"]` PDA.
///
/// ── WHY `init_if_needed` AND NOT PLAIN `init` ─────────────────────────────
///
/// Plain `init` would make the collision a SYSTEM-PROGRAM failure — "account
/// already in use", carrying no program error code. That is a poor thing to
/// hand Rails, which decodes integer codes to messages, and a worse thing to
/// hand a user: the single most common refusal in this whole feature is "that
/// name is taken". Loading the existing account instead lets the refusal be
/// `UsernameAlreadyClaimed` (6060), and it makes a re-run idempotent rather
/// than fatal, which matters for a retried Sidekiq job.
///
/// The reinitialization attack `init_if_needed` is normally warned about does
/// not apply: when the account exists Anchor loads it and this function writes
/// NOTHING before the ownership check, so an attacker cannot use it to wipe a
/// record they do not own.
/// `now` is passed in rather than read here so this function stays a PURE
/// function of its arguments — `Clock::get()` is a syscall and returns
/// `UnsupportedSysvar` off the BPF target, which would make every assertion
/// about the claim rule unreachable from a host unit test. Its callers read
/// the clock once and hand it down.
pub fn claim_or_confirm(
    record: &mut UsernameRecord,
    owner: Pubkey,
    name_key: [u8; 32],
    bump: u8,
    now: i64,
) -> Result<()> {
    // A caller must never be able to claim a name FOR the zero key, or the
    // "freshly created" reading above would stop being exact.
    require!(owner != Pubkey::default(), VaultError::Unauthorized);

    if record.owner == Pubkey::default() {
        record.owner = owner;
        record.name = name_key;
        record.claimed_at = now;
        record.bump = bump;
        return Ok(());
    }

    // THE REFUSAL THIS WHOLE FEATURE EXISTS FOR. Held by a wallet that is not
    // the claimant, or held by the vault as a reservation — one message covers
    // both, and an off-chain reader that wants to tell them apart reads
    // `owner` off the record it can already fetch.
    require!(
        record.owner == owner,
        VaultError::UsernameAlreadyClaimed
    );
    // Belt and braces against a corrupt record: the seeds constraint already
    // proves this PDA was derived from `name_key`.
    require!(
        record.name == name_key,
        VaultError::UsernameRecordNameMismatch
    );
    Ok(())
}

/// Decide what must happen to the record for the name being GIVEN UP, and
/// refuse every shape that is not one of the two legal ones.
///
/// Returns `true` when this is a real rename (the canonical key changes).
///
/// ── THE ACCUMULATION BUG THIS CLOSES ──────────────────────────────────────
///
/// A rename has to close the old name's record, or the holder keeps it: claim
/// "alice", rename to "bob" while leaving the old record out of the account
/// list, and now hold two names for about 0.0015 SOL — repeatable. So the old
/// record is a REQUIRED account on the rename path.
///
/// But a program cannot distinguish an account deliberately omitted from one
/// that does not exist. That is what `UserAccount.username_registered` is for:
/// it turns "this user has no record yet" from a claim the caller makes into a
/// fact the chain stores. Registered and renaming ⇒ the record must be passed,
/// must be owned by the holder, and must be the CURRENT name's.
///
/// ── AND THE TWO CASES THAT ARE NOT RENAMES ────────────────────────────────
///
/// A CASE-ONLY change ("alice" → "Alice") keeps the same canonical key, so the
/// record is already the holder's and there is nothing to close. Passing one
/// anyway is refused rather than ignored — it could only be some OTHER record,
/// and closing it would be a silent loss.
///
/// A PRE-REGISTRY user (`username_registered == 0`, which is every one of the
/// 47 accounts that predate this upgrade) has no record to give up. Their old
/// name simply returns to the pool, which is the accepted semantic: renaming
/// does not lock the name you left.
pub fn settle_previous_record(
    user: &UserAccount,
    holder: &Pubkey,
    new_key: &[u8; 32],
    previous: Option<&UsernameRecord>,
) -> Result<bool> {
    let current_key = canonical_username_key(&user.username);
    let renaming = *new_key != current_key;

    if renaming && user.username_registered == 1 {
        let prev = previous.ok_or(error!(VaultError::UsernameRecordMissing))?;
        require!(
            prev.owner == *holder,
            VaultError::UsernameRecordOwnerMismatch
        );
        // Pins it to exactly one account without a seeds constraint: only one
        // record can carry this name (the PDA is derived from it), and only
        // one holder can own that record.
        require!(
            prev.name == current_key,
            VaultError::UsernameRecordNameMismatch
        );
    } else {
        require!(
            previous.is_none(),
            VaultError::UsernameRecordNotExpected
        );
    }

    Ok(renaming)
}

// ──────────────────────────────────────────────────────────────────────────
// reserve_username — "add to the blocked list"
// ──────────────────────────────────────────────────────────────────────────

/// `reserve_username` — the vault claims a free name so no player can.
///
/// Auth: `RESERVE_USERNAME` (3, FLOORED at 3 — see `THRESHOLD_FLOORS` for why
/// the brake side is floored too, which is a migration argument rather than a
/// security one).
///
/// It claims a name that is FREE. A name a player already holds cannot be
/// reserved out from under them in one step — `claim_or_confirm` refuses with
/// `UsernameAlreadyClaimed` — because taking a name away is a different act
/// with a different audit trail: run `overwrite_username` to move that player
/// off it, then reserve the vacated name.
///
/// Re-reserving a name the vault already holds is a no-op that succeeds, so a
/// retried job is safe.
///
/// The reserved-PREFIX rule is waived here (this is a quorum, and reserving
/// "turfmonster" is exactly the kind of thing it is for); charset and the
/// 3-byte length floor are not waivable on any path.
#[derive(Accounts)]
#[instruction(name_key: [u8; 32])]
pub struct ReserveUsername<'info> {
    /// Vault signer; pays rent for the record.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// OPTIONAL by design. A mandatory second `Signer` is a threshold the
    /// account struct enforces on its own, which the stored table can then
    /// never lower — the bug fixed across six instructions in the governance
    /// change. See `governance::named_signers`.
    pub cosigner: Option<Signer<'info>>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = UsernameRecord::LEN,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: leading extra cosigners.
}

pub fn handle_reserve_username(ctx: Context<ReserveUsername>, name_key: [u8; 32]) -> Result<()> {
    let required = ctx
        .accounts
        .governance
        .threshold_for(gov_action::RESERVE_USERNAME);

    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::RESERVE_USERNAME,
            &named_signers(
                ctx.accounts.admin.key(),
                ctx.accounts.cosigner.as_ref().map(|s| s.key()),
            ),
            ctx.remaining_accounts,
        )?;
    }

    // A reservation has no display form — the vault is blocking a string, not
    // naming an account — so the key IS the name, and it must already be in
    // canonical (lowercase) form or it would block a spelling nobody can type.
    require_canonical_form(&name_key)?;
    validate_username_charset_len(&name_key)?;

    let vault_key = ctx.accounts.vault_state.key();
    let bump = ctx.bumps.username_record;
    let timestamp = Clock::get()?.unix_timestamp;
    claim_or_confirm(
        &mut ctx.accounts.username_record,
        vault_key,
        name_key,
        bump,
        timestamp,
    )?;

    emit!(UsernameReservationCreated {
        name: name_key,
        authorized_by: ctx.accounts.admin.key(),
        signatures_required: required,
        timestamp,
    });

    msg!(
        "reserve_username: vault now holds a name ({} signatures, named {})",
        required,
        ctx.accounts.admin.key()
    );
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// release_reserved_username — "lift a block"
// ──────────────────────────────────────────────────────────────────────────

/// `release_reserved_username` — the vault gives a name back to the pool.
///
/// Auth: `RELEASE_USERNAME` (3, FLOORED at 3). A reservation is a brake on a
/// name, and this program's asymmetry is that nothing an agent reaches alone
/// may lift a brake — the same argument that makes `unpause` cost more than
/// `pause`. Reserving can never be more expensive than releasing; the guard
/// test `reserving_a_name_is_never_costlier_than_releasing_one` asserts that as
/// a relationship, so it survives a retune of either side.
///
/// RENT GOES TO THE TREASURY, not to whichever signer called it — the rule
/// `close_contest` established in the same upgrade window, reusing its error
/// (`InvalidRentDestination`, 6056). The vault paid for the reservation; the
/// vault gets it back.
///
/// Refuses a record the vault does not hold (`UsernameNotReserved`) — a
/// player's name can never be closed through this path, which is the property
/// that keeps the two kinds of record genuinely separate.
#[derive(Accounts)]
#[instruction(name_key: [u8; 32])]
pub struct ReleaseReservedUsername<'info> {
    pub admin: Signer<'info>,

    pub cosigner: Option<Signer<'info>>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    /// CHECK: rent destination. Pinned to `vault_state.treasury_authority` in
    /// the handler; holds no data this program reads.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        close = treasury,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump = username_record.bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,
    // remaining_accounts: leading extra cosigners.
}

pub fn handle_release_reserved_username(
    ctx: Context<ReleaseReservedUsername>,
    name_key: [u8; 32],
) -> Result<()> {
    let required = ctx
        .accounts
        .governance
        .threshold_for(gov_action::RELEASE_USERNAME);

    let treasury_authority = {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::RELEASE_USERNAME,
            &named_signers(
                ctx.accounts.admin.key(),
                ctx.accounts.cosigner.as_ref().map(|s| s.key()),
            ),
            ctx.remaining_accounts,
        )?;
        vault.treasury_authority
    };

    require!(
        ctx.accounts.treasury.key() == treasury_authority,
        VaultError::InvalidRentDestination
    );

    // EXACT match on the vault key, not `is_reserved`. `is_reserved` folds in
    // the unreachable zero-owner case so that a corrupt record reads as
    // UNCLAIMABLE; folding it in HERE would do the opposite, making such a
    // record closable by this path. The release path should only ever act on a
    // reservation the vault provably holds.
    require!(
        ctx.accounts.username_record.owner == ctx.accounts.vault_state.key(),
        VaultError::UsernameNotReserved
    );
    require!(
        ctx.accounts.username_record.name == name_key,
        VaultError::UsernameRecordNameMismatch
    );

    let timestamp = Clock::get()?.unix_timestamp;
    emit!(UsernameReservationReleased {
        name: name_key,
        authorized_by: ctx.accounts.admin.key(),
        signatures_required: required,
        timestamp,
    });

    msg!(
        "release_reserved_username: name returned to the pool ({} signatures, named {})",
        required,
        ctx.accounts.admin.key()
    );
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// backfill_username_record — the migration, and it needs no signatures
// ──────────────────────────────────────────────────────────────────────────

/// `backfill_username_record` — lock the name a `UserAccount` ALREADY displays.
///
/// Auth: NONE beyond a payer, and that is a deliberate call rather than an
/// oversight. This instruction has no discretion: the name comes from the
/// account's own `username` field and the owner from its own `wallet` field,
/// so the only state it can produce is the one the chain already asserts. It
/// cannot take a name from anybody, cannot give one to anybody, and the worst
/// a hostile caller achieves is paying rent to ratify a name its rightful
/// holder already displays. Requiring a quorum to run it 47 times would have
/// bought nothing and cost three signatures per user.
///
/// ── WHY THE MIGRATION IS TRIVIAL ──────────────────────────────────────────
///
/// Measured on production 2026-09-15: 47 users, 47 with usernames, ZERO
/// case-insensitive duplicates. So uniqueness switches on retroactively with
/// no reconciliation — roughly 0.0015 SOL of rent each, about 0.07 SOL in
/// total, refunded to the user when they later rename.
///
/// If a duplicate DID exist, this instruction is where it would surface: the
/// first caller wins the name and the second gets `UsernameAlreadyClaimed`,
/// leaving that user displaying a name they do not hold until an operator
/// renames them. That is the correct failure — loud, on the migration, not
/// silent in the registry.
///
/// Idempotent: a second run on the same user confirms rather than re-creates.
#[derive(Accounts)]
#[instruction(name_key: [u8; 32])]
pub struct BackfillUsernameRecord<'info> {
    /// Pays rent. Any wallet — see the authorization note above.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the wallet whose account is being ratified. Not a signer; bound
    /// by the `user_account` PDA seeds and its stored `wallet` field.
    pub user_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"user", user_wallet.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.wallet == user_wallet.key() @ VaultError::Unauthorized,
    )]
    pub user_account: Account<'info, UserAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        space = UsernameRecord::LEN,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handle_backfill_username_record(
    ctx: Context<BackfillUsernameRecord>,
    name_key: [u8; 32],
) -> Result<()> {
    let user_wallet = ctx.accounts.user_account.wallet;
    let username = ctx.accounts.user_account.username;

    // THE CALLER CHOOSES NOTHING. `name_key` must be the canonical form of the
    // name this account already displays; anything else is refused.
    require_canonical_key(&username, &name_key)?;

    // A blank username must never be lockable: every account without one would
    // canonicalize to the same 32 zero bytes and collide on ONE record. The
    // full charset + length bar is applied rather than only the length floor —
    // every live account was created at v0.16 or later and so was already held
    // to it, and a name that cannot pass it should be renamed, not ratified.
    validate_username_charset_len(&username)?;

    let bump = ctx.bumps.username_record;
    let timestamp = Clock::get()?.unix_timestamp;
    claim_or_confirm(
        &mut ctx.accounts.username_record,
        user_wallet,
        name_key,
        bump,
        timestamp,
    )?;

    ctx.accounts.user_account.username_registered = 1;

    emit!(UsernameClaimed {
        owner: user_wallet,
        name: name_key,
        display_name: username,
        previous_name: [0u8; 32],
        timestamp,
    });

    msg!("backfill_username_record: registered existing name for {}", user_wallet);
    Ok(())
}
