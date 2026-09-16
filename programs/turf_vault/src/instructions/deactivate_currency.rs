use anchor_lang::prelude::*;
use crate::state::{VaultState, MAX_CURRENCIES, GovernanceConfig, gov_action};
use crate::errors::VaultError;
use crate::instructions::governance::{authorize, named_signers};

/// `deactivate_currency` — flip a slot's `active` flag to 0.
///
/// The slot itself is preserved (mint + op_rev_ata stay). This ensures
/// historical `Contest.entry_fee_by_currency[idx]` and
/// `Contest.entry_fees[idx]` remain valid lookups.
///
/// Side effects:
///   - Existing open contests with non-zero fee at this slot will fail
///     entry with `CurrencyNotActive`.
///   - `create_contest` will reject any new contest with non-zero fee
///     at this slot (validation #4 in §3.7).
///   - The operator-revenue ATA for the deactivated currency stays
///     drainable via `sweep_operator_revenue`.
///
/// Auth: `gov_action::DEACTIVATE_CURRENCY` (default 3).
///
/// VaultState is zero-copy (v0.16). load_mut() for the write.
#[derive(Accounts)]
pub struct DeactivateCurrency<'info> {
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

pub fn handle_deactivate_currency(
    ctx: Context<DeactivateCurrency>,
    currency_idx: u8,
) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26). `admin`, plus `cosigner` when
    // one was supplied, are the NAMED signers; any further signatures the
    // stored threshold demands are taken from the leading `remaining_accounts`.
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::DEACTIVATE_CURRENCY,
            &named_signers(
                ctx.accounts.admin.key(),
                ctx.accounts.cosigner.as_ref().map(|s| s.key()),
            ),
            ctx.remaining_accounts,
        )?;
    }

    let idx = currency_idx as usize;
    require!(idx < MAX_CURRENCIES, VaultError::InvalidCurrencyIndex);

    let mut vault = ctx.accounts.vault_state.load_mut()?;

    require!(
        vault.accepted_currencies[idx].mint != Pubkey::default(),
        VaultError::InvalidCurrencyIndex
    );
    require!(
        vault.accepted_currencies[idx].active == 1,
        VaultError::CurrencyNotActive
    );

    vault.accepted_currencies[idx].active = 0;
    let mint = vault.accepted_currencies[idx].mint;

    msg!(
        "Currency deactivated: slot={}, mint={}",
        idx,
        mint
    );
    Ok(())
}
