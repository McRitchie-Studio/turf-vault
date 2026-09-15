use anchor_lang::prelude::*;
use crate::state::{
    UserAccount, VaultState, GovernanceConfig, gov_action,
};
use crate::errors::VaultError;
use crate::instructions::governance::authorize;
use crate::instructions::set_username::validate_username_charset_len;

/// `admin_set_username` — `set_username` with an admin-authorized
/// reserved-prefix waiver (v0.25).
///
/// Identical semantics to `set_username` (the account OWNER signs —
/// consenting; no admin can rename a user unilaterally) PLUS a required
/// `admin` co-signer that must be a 1-of-3 vault signer
/// (`vault_state.is_signer`, else `Unauthorized` 6000).
///
/// The admin co-signature waives ONLY the reserved-prefix branch of the
/// v0.15.1 username validity bar (audit C2) — charset (printable ASCII) and
/// the 3-char length floor are still enforced. Canonical use: renaming the
/// operator's house account to "turf", which the plain path rejects with
/// `UsernameReserved` 6020.
///
/// VaultState is zero-copy (v0.16) — load()? for the signer check. Read-only.
#[derive(Accounts)]
pub struct AdminSetUsername<'info> {
    pub wallet: Signer<'info>,

    /// Vault signer (1-of-3) authorizing the reserved-prefix waiver.
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault_state.load()?.bump,
    )]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table. Required by every vault-authorized
    /// instruction since v0.26 — see `instructions::governance::authorize`.
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    #[account(
        mut,
        seeds = [b"user", wallet.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.wallet == wallet.key() @ VaultError::Unauthorized,
    )]
    pub user_account: Account<'info, UserAccount>,
}

pub fn handle_admin_set_username(
    ctx: Context<AdminSetUsername>,
    username: [u8; 32],
) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26). `admin` is the instruction's
    // one NAMED vault signer; any further signatures the stored threshold
    // demands are taken from the leading `remaining_accounts`. At a threshold
    // of 1 that count is zero and the account list is unchanged from v0.25.
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::ADMIN_USERNAME,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    // Reserved-prefix check waived (admin co-signed); charset + min-length
    // are NOT waivable on any path.
    validate_username_charset_len(&username)?;

    let user = &mut ctx.accounts.user_account;
    user.username = username;

    msg!(
        "Username updated (admin-authorized) for: {} by admin: {}",
        user.wallet,
        ctx.accounts.admin.key()
    );
    Ok(())
}
