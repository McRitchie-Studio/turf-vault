use anchor_lang::prelude::*;
use crate::state::{
    UserAccount, VaultState, GovernanceConfig, gov_action,
};
use crate::instructions::governance::authorize;
use crate::instructions::create_user_account::init_user_account;
use crate::instructions::set_username::validate_username_charset_len;

/// `admin_create_user_account` — `create_user_account` with an
/// admin-authorized reserved-prefix waiver (v0.25).
///
/// Identical semantics to `create_user_account` (permissionless payer pays
/// SOL rent, the target wallet gets the PDA, wallet itself does NOT sign)
/// PLUS a required `admin` co-signer that must be a 1-of-3 vault signer
/// (`vault_state.is_signer`, else `Unauthorized` 6000).
///
/// The admin co-signature waives ONLY the reserved-prefix branch of the
/// v0.15.1 username validity bar (audit C2) — charset (printable ASCII) and
/// the 3-char length floor are still enforced. Canonical use: the operator's
/// own "Turf Monster" house account needs username "turf", which the plain
/// path rejects with `UsernameReserved` 6020.
///
/// Privilege is the vault-signer co-signature, NOT membership of the target
/// wallet — the house wallet is a 4th admin that is not (and will not be) a
/// vault signer.
///
/// VaultState is zero-copy (v0.16) — load()? for the signer check. Read-only
/// here; the plain `create_user_account` doesn't reference it at all.
#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AdminCreateUserAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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
        init,
        payer = payer,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user", wallet.as_ref()],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handle_admin_create_user_account(
    ctx: Context<AdminCreateUserAccount>,
    wallet: Pubkey,
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

    init_user_account(&mut ctx.accounts.user_account, wallet, username, ctx.bumps.user_account);

    msg!(
        "User account created (admin-authorized) for: {} by admin: {}",
        wallet,
        ctx.accounts.admin.key()
    );
    Ok(())
}
