use anchor_lang::prelude::*;
use crate::state::{VaultState, GovernanceConfig, gov_action};
use crate::instructions::governance::authorize;

/// `unpause` — lift the emergency stop.
///
/// Restores enter_contest{,_with_token} operations. No time-based auto-unpause
/// (deliberately — an attacker who can pause should not be able to wait it out).
///
/// Auth: `gov_action::UNPAUSE` (default 3, IMMOVABLE FLOOR 3). Deliberately NOT
/// the same authority as `pause`, which is 2: lifting the brake costs strictly
/// more than pulling it, so an agent able to halt the platform cannot also
/// un-halt it. `DEFAULT_THRESHOLDS` calls that difference "the whole
/// asymmetry", and `THRESHOLD_FLOORS` is what stops three signatures from
/// retuning it away.
///
/// VaultState is zero-copy (v0.16). load_mut() for the write.
#[derive(Accounts)]
pub struct UnpauseVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub cosigner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump = vault_state.load()?.bump,
    )]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table. Required by every vault-authorized
    /// instruction since v0.26 — see `instructions::governance::authorize`.
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,
}

pub fn handle_unpause(ctx: Context<UnpauseVault>) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26). `admin` + `cosigner` are the
    // instruction's NAMED signers; any further signatures the stored threshold
    // demands are taken from the leading `remaining_accounts`.
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::UNPAUSE,
            &[ctx.accounts.admin.key(), ctx.accounts.cosigner.key()],
            ctx.remaining_accounts,
        )?;
    }

    let admin_key = ctx.accounts.admin.key();
    let cosigner_key = ctx.accounts.cosigner.key();

    {
        let mut vault = ctx.accounts.vault_state.load_mut()?;
        vault.paused = 0;
    }

    msg!(
        "Vault UNPAUSED by {} + {}",
        admin_key,
        cosigner_key
    );
    Ok(())
}
