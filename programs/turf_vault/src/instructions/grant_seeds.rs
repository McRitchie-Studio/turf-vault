use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::governance::authorize;
use crate::state::{
    gov_action, seed_grant_kind, GovernanceConfig, SeedGrant, UserAccount, VaultState,
    MAX_GRANT_SEEDS,
};

/// Admin-signed standalone seed grant (Rails "quest" bonuses).
/// Auth: `gov_action::GRANT_SEEDS` (default 1 — unchanged from v0.25).
///
/// Credits a fixed `amount` of loyalty seeds into a user's UserAccount PDA
/// OUTSIDE the normal enter_contest flow — used for: first manual username
/// change, newsletter join, and a friend-invite-entered reward.
///
/// Idempotency is on-chain: the `[b"seed_grant", user_wallet, kind, invitee]`
/// guard PDA is `init`-once, so a repeat grant of the same (user, kind[, invitee])
/// collides on init and the TX fails — true double-grant protection, safe for
/// Sidekiq retries (mirrors the entry_token init-as-guard, v0.19 #9).
///   - USERNAME_FIRST_CHANGE / NEWSLETTER_JOIN: invitee = Pubkey::default()
///     → one grant per (user, kind) EVER.
///   - INVITE_FRIEND: invitee = the friend's wallet → one grant per
///     (inviter, invitee) — fires once per distinct invited friend.
///
/// The admin credits the user WITHOUT the user signing — consistent with
/// settle_contest mutating arbitrary UserAccounts under admin authority.
/// `amount` is bounded by MAX_GRANT_SEEDS so a leaked 1-of-3 key can't mint
/// unbounded seeds in a single call.
#[derive(Accounts)]
#[instruction(amount: u64, kind: u8, invitee: Pubkey)]
pub struct GrantSeeds<'info> {
    /// Vault signer (1-of-3). Pays SOL rent for the SeedGrant guard PDA.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table. Required by every vault-authorized
    /// instruction since v0.26 — see `instructions::governance::authorize`.
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    /// CHECK: recipient wallet. Not a signer — the admin credits seeds on the
    /// user's behalf (like settle_contest). Used to derive + bind the
    /// UserAccount PDA and to seed the guard PDA.
    pub user_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"user", user_wallet.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.wallet == user_wallet.key() @ VaultError::Unauthorized,
    )]
    pub user_account: Account<'info, UserAccount>,

    /// THE INVITEE'S OWN UserAccount — required for INVITE_FRIEND, forbidden
    /// otherwise (v0.26).
    ///
    /// ── WHY THIS ACCOUNT EXISTS ───────────────────────────────────────────
    ///
    /// The once-only guard below is seeded on `invitee`, a CALLER-CHOSEN
    /// Pubkey argument. Nothing required that pubkey to correspond to anything
    /// — so for INVITE_FRIEND, every distinct 32-byte value opened a fresh
    /// guard PDA and a fresh grant. `invitee = [1u8; 32]`, `[2u8; 32]`, and so
    /// on: the "once per invited friend" lock was once per NUMBER, and the
    /// supply of numbers is 2^256. A single 1-of-N signature could mint seeds
    /// without bound, one cheap transaction at a time, and each grant looked
    /// individually legitimate on chain.
    ///
    /// Binding the guard to a REAL ACCOUNT closes the farm. The invitee must
    /// now be a wallet that actually has a `UserAccount` PDA, and the account
    /// is bound by BOTH its PDA seeds and its stored `wallet` field, so it
    /// cannot be some other user's record renamed.
    ///
    /// ── AND IT MUST HAVE ENTERED A CONTEST ────────────────────────────────
    ///
    /// Existence alone would only raise the price of a fake invitee to one
    /// rent-exempt account. The quest this instruction pays out for is "a
    /// friend you invited ENTERED a contest", so the check is the business
    /// rule itself: `entries > 0`. Manufacturing a fake invitee now costs a
    /// real contest entry, which is more than the grant is worth — the farm is
    /// not merely gated, it is unprofitable.
    #[account(
        seeds = [b"user", invitee.as_ref()],
        bump = invitee_user_account.bump,
        constraint = invitee_user_account.wallet == invitee
            @ VaultError::SeedGrantInviteeNotRegistered,
        constraint = invitee_user_account.entries > 0
            @ VaultError::SeedGrantInviteeNotRegistered,
    )]
    pub invitee_user_account: Option<Account<'info, UserAccount>>,

    /// Idempotency guard — `init`-once per (user, kind[, invitee]).
    #[account(
        init,
        payer = admin,
        space = 8 + SeedGrant::INIT_SPACE,
        seeds = [b"seed_grant".as_ref(), user_wallet.key().as_ref(), &[kind], invitee.as_ref()],
        bump,
    )]
    pub seed_grant: Account<'info, SeedGrant>,

    pub system_program: Program<'info, System>,
}

pub fn handle_grant_seeds(
    ctx: Context<GrantSeeds>,
    amount: u64,
    kind: u8,
    invitee: Pubkey,
) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26).
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::GRANT_SEEDS,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    // Flexible kinds (v0.23): any 0..=MAX_SEED_GRANT_KIND is a valid quest, so a
    // new quest needs only a Rails kind constant — never another redeploy. The
    // per-kind guard PDA keeps each quest's once-ever lock distinct; the bound
    // still rejects a typo'd kind from opening a shadow namespace.
    require!(
        kind <= seed_grant_kind::MAX_SEED_GRANT_KIND,
        VaultError::InvalidSeedGrantKind
    );

    // INVITE_FRIEND carries a real invitee (per-friend guard); the once-ever
    // kinds must NOT, so they can't be farmed by varying the invitee.
    if kind == seed_grant_kind::INVITE_FRIEND {
        require!(
            invitee != Pubkey::default(),
            VaultError::InvalidSeedGrantInvitee
        );
        // v0.26: and that invitee must be a REAL contest-entering user. The
        // account's own constraints prove `wallet == invitee` and
        // `entries > 0`; this require is what makes PASSING it mandatory,
        // since an `Option` account that is simply omitted skips them all.
        require!(
            ctx.accounts.invitee_user_account.is_some(),
            VaultError::SeedGrantInviteeNotRegistered
        );
    } else {
        require!(
            invitee == Pubkey::default(),
            VaultError::InvalidSeedGrantInvitee
        );
        // Symmetrically: a non-invite grant must not smuggle one in, or the
        // account list would differ between kinds for no stated reason.
        require!(
            ctx.accounts.invitee_user_account.is_none(),
            VaultError::InvalidSeedGrantInvitee
        );
    }

    // Bound the per-call magnitude (leaked-key blast radius + overflow hygiene).
    require!(
        amount > 0 && amount <= MAX_GRANT_SEEDS,
        VaultError::SeedGrantAmountInvalid
    );

    let user_account = &mut ctx.accounts.user_account;
    user_account.seeds = user_account
        .seeds
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;

    let grant = &mut ctx.accounts.seed_grant;
    grant.user = ctx.accounts.user_wallet.key();
    grant.kind = kind;
    grant.invitee = invitee;
    grant.amount = amount;
    grant.granted_at = Clock::get()?.unix_timestamp;
    grant.bump = ctx.bumps.seed_grant;

    msg!(
        "grant_seeds: +{} seeds to {} (kind {}, invitee {}) -> total {}",
        amount,
        grant.user,
        kind,
        invitee,
        user_account.seeds
    );

    Ok(())
}
