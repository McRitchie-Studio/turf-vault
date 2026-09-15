use anchor_lang::prelude::*;
use crate::state::{VaultState, GovernanceConfig, gov_action};
use crate::instructions::governance::{authorize, named_signers};

/// `pause` — emergency stop for user-facing funds operations.
///
/// While the vault is paused, these instructions return `VaultPaused`:
///   - enter_contest
///   - enter_contest_with_token
///
/// These instructions REMAIN AVAILABLE during a pause (intentional —
/// operators may need to wind down in-flight state, mint tokens for
/// already-paid Stripe purchases, etc):
///   - settle_contest, close_contest, cancel_contest
///   - mint_entry_token
///   - register_currency, deactivate_currency
///   - set_username, create_user_account
///   - create_season, create_contest, set_contest_lock_time
///   - sweep_operator_revenue
///   - pause, unpause
///
/// Auth: `gov_action::PAUSE` — default 2, FLOOR 1.
///
/// Two rather than one is Mr. McRitchie's own call, and it is the better
/// number: the agent can still pull the brake, while a single leaked key
/// cannot grief the business by halting entries at will. Lifting the brake
/// (`unpause`) costs three and is floored there, so a captured system can
/// stop the platform and can never restart it.
///
/// THE FLOOR IS 1, AND THE ACCOUNT STRUCT HONOURS THAT. `cosigner` is
/// `Option<Signer>` precisely so this instruction can be retuned to a single
/// signature by transaction if an incident ever shows two costs too much
/// latency. A mandatory second `Signer` would have made that retune succeed on
/// paper and fail on the chain — see `named_signers`.
///
/// `reason` is a human-readable note logged on-chain. It's a fixed
/// 64-byte array for predictable account sizing; trim trailing zeros
/// when displaying.
///
/// VaultState is zero-copy (v0.16). load_mut() for the write.
#[derive(Accounts)]
pub struct PauseVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Second vault signer. OPTIONAL since the threshold became data: a
    /// mandatory `Signer` here would be a floor of 2 that no stored table
    /// could lower, and the table and the account struct would disagree in
    /// silence. See `named_signers`.
    pub cosigner: Option<Signer<'info>>,

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

pub fn handle_pause(ctx: Context<PauseVault>, reason: [u8; 64]) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26). `admin`, plus `cosigner` when
    // one was supplied, are the NAMED signers; any further signatures the
    // stored threshold demands are taken from the leading `remaining_accounts`.
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::PAUSE,
            &named_signers(
                ctx.accounts.admin.key(),
                ctx.accounts.cosigner.as_ref().map(|s| s.key()),
            ),
            ctx.remaining_accounts,
        )?;
    }

    let admin_key = ctx.accounts.admin.key();
    let cosigner_key = ctx
        .accounts
        .cosigner
        .as_ref()
        .map(|s| s.key())
        .unwrap_or(admin_key);

    {
        let mut vault = ctx.accounts.vault_state.load_mut()?;
        vault.paused = 1;
    }

    // Best-effort UTF-8 decode for the log line. If reason contains non-UTF-8
    // bytes, fall back to a hex preview so we still record SOMETHING.
    let trimmed: Vec<u8> = reason.iter().take_while(|b| **b != 0).copied().collect();
    let reason_str = String::from_utf8(trimmed.clone())
        .unwrap_or_else(|_| format!("<binary {} bytes>", trimmed.len()));

    msg!(
        "Vault PAUSED by {} + {}. Reason: {}",
        admin_key,
        cosigner_key,
        reason_str
    );
    Ok(())
}
