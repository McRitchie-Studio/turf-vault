use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::governance::{authorize, named_signers};
use crate::instructions::set_username::{require_canonical_key, validate_username_charset_len};
use crate::instructions::username_registry::{claim_or_confirm, settle_previous_record};
use crate::state::{gov_action, GovernanceConfig, UserAccount, UsernameRecord, VaultState};

/// `overwrite_username` — rename any user, WITHOUT that user's consent.
///
/// Auth: `OVERWRITE_USERNAME` (3, FLOORED at 3).
///
/// ── WHY CONSENT IS GONE, AND WHY THAT IS THE SAFE DIRECTION ───────────────
///
/// This replaces `admin_set_username`, which required the account OWNER to
/// sign — "no admin can rename a user unilaterally". That reads like a
/// protection and worked like a dead end: the two cases anyone ever wanted the
/// instruction for are a SQUATTER and a SLUR, and the holder of either has no
/// reason to co-sign their own eviction. So the old instruction could not do
/// the one job it existed for.
///
/// Removing the user's signature is safe only because of what replaced it.
/// Three of five is a number no agent can reach: the agent system holds two
/// slots and no more, so this instruction is unreachable without the operator.
/// The floor is what keeps that true — a quorum cannot retune this to one and
/// hand a single leaked key the power to rename anybody on the platform.
///
/// ── THE EVENT IS THE POINT, AND IT IS ALMOST FREE ─────────────────────────
///
/// An instruction that renames people without asking them needs a trail. An
/// Anchor event is a transaction log line: no rent, no account, no storage. So
/// every use records who was renamed, from what to what, which vault signer
/// was named, how many signatures the table demanded, and when.
///
/// ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
///
/// It does NOT lock the vacated name. Move a squatter off "slur" and "slur" is
/// free again from the next transaction. That is Mr. McRitchie's own accepted
/// behaviour — "if someone renames back he can claim the name with a user or
/// add it to the blocked list" — and the follow-up is one more transaction at
/// the same quorum: `reserve_username`.
///
/// It also cannot hand over a name the VAULT holds: the target record already
/// exists, so `claim_or_confirm` refuses with `UsernameAlreadyClaimed`. Release
/// it first. The only hand-over ever actually wanted — the operator's house
/// account taking "turf" — is prefix-protected, so the gap between the two
/// transactions is not reachable by an ordinary `set_username`.
///
/// ── THE PREFIX WAIVER LIVES HERE NOW ──────────────────────────────────────
///
/// Charset and the 3-byte length floor are enforced; the reserved-PREFIX
/// branch is waived. That was `admin_set_username`'s only real job, and this
/// is it at three signatures instead of one.
#[derive(Accounts)]
#[instruction(username: [u8; 32], name_key: [u8; 32])]
pub struct OverwriteUsername<'info> {
    /// Vault signer; pays rent for the new record.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// OPTIONAL by design — see `governance::named_signers`. A mandatory
    /// second `Signer` would be a floor the account struct imposes, which the
    /// stored table could then never lower.
    pub cosigner: Option<Signer<'info>>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    /// CHECK: the user being renamed. Does NOT sign — that is the entire
    /// point of this instruction. Bound by the `user_account` PDA seeds and
    /// its stored `wallet` field, and `mut` because the rent from their closed
    /// record is refunded to them rather than pocketed by the caller.
    #[account(mut)]
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
        payer = admin,
        space = UsernameRecord::LEN,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,

    /// The record for the name being given up. Required when the target is
    /// registered and the canonical key really changes; refused otherwise.
    /// See `username_registry::settle_previous_record`.
    ///
    /// Closed to the USER, not to the admin — they paid its rent.
    #[account(mut, close = user_wallet)]
    pub previous_username_record: Option<Account<'info, UsernameRecord>>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: leading extra cosigners.
}

pub fn handle_overwrite_username(
    ctx: Context<OverwriteUsername>,
    username: [u8; 32],
    name_key: [u8; 32],
) -> Result<()> {
    let required = ctx
        .accounts
        .governance
        .threshold_for(gov_action::OVERWRITE_USERNAME);

    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::OVERWRITE_USERNAME,
            &named_signers(
                ctx.accounts.admin.key(),
                ctx.accounts.cosigner.as_ref().map(|s| s.key()),
            ),
            ctx.remaining_accounts,
        )?;
    }

    // Reserved-prefix check waived (three signatures); charset + min-length
    // are not waivable on any path.
    validate_username_charset_len(&username)?;
    require_canonical_key(&username, &name_key)?;

    let user_wallet = ctx.accounts.user_account.wallet;
    let previous_name = ctx.accounts.user_account.username;

    settle_previous_record(
        &ctx.accounts.user_account,
        &user_wallet,
        &name_key,
        ctx.accounts.previous_username_record.as_deref(),
    )?;

    let bump = ctx.bumps.username_record;
    let timestamp = Clock::get()?.unix_timestamp;
    claim_or_confirm(
        &mut ctx.accounts.username_record,
        user_wallet,
        name_key,
        bump,
        timestamp,
    )?;

    let user = &mut ctx.accounts.user_account;
    user.username = username;
    user.username_registered = 1;

    emit!(UsernameOverwritten {
        user_wallet,
        previous_name,
        new_name: username,
        name_key,
        authorized_by: ctx.accounts.admin.key(),
        signatures_required: required,
        timestamp,
    });

    msg!(
        "overwrite_username: {} renamed WITHOUT consent ({} signatures, named {})",
        user_wallet,
        required,
        ctx.accounts.admin.key()
    );
    Ok(())
}

/// A user was renamed by the vault without signing for it.
///
/// The whole audit record, and it costs a log line: who was renamed, the
/// display name before and after, the registry key now held, which vault
/// signer was named on the transaction, how many distinct signatures the
/// stored table demanded at the time, and when.
#[event]
pub struct UsernameOverwritten {
    pub user_wallet: Pubkey,
    /// Display name before the rename.
    pub previous_name: [u8; 32],
    /// Display name after it, case preserved.
    pub new_name: [u8; 32],
    /// Canonical (lowercased) form — the registry key now held.
    pub name_key: [u8; 32],
    pub authorized_by: Pubkey,
    pub signatures_required: u8,
    pub timestamp: i64,
}
