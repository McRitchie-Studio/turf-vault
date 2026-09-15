use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use crate::state::{VaultState, Contest, ContestStatus, GovernanceConfig, gov_action};
use crate::errors::VaultError;
use crate::instructions::governance::authorize;

/// `close_contest` — reclaim SOL rent from a settled (or cancelled) Contest.
///
/// Closes:
///   1. The prize_pool ATA, after sweeping any residual USDC to the
///      operator-revenue USDC ATA (§11 Q8 — handles 1-USDC-dust from
///      rounding errors without blocking the close).
///   2. The Contest PDA itself, transferring its lamports to the TREASURY.
///
/// Refuses to run on un-finalized contests — status must be Settled or
/// Cancelled.
///
/// ── v0.26: RECLAIMED RENT GOES TO THE TREASURY, NOT THE CALLER ────────────
///
/// Both rent refunds — the Contest PDA's and the prize_pool ATA's — used to
/// land on `admin`, which is whichever vault signer happened to send the
/// transaction. That quietly made "close a finished contest" a routine that
/// PAYS THE CALLER: the rent was funded by the platform at create time, and
/// every close moved a little of it to a personal wallet chosen by the signer.
/// It is small per contest and unbounded in aggregate, and it gave a key that
/// should have no financial upside a reason to exist.
///
/// Both destinations are now pinned to `vault_state.treasury_authority`, the
/// same Squads vault `sweep_operator_revenue` already pays into. The caller
/// still pays the transaction fee, so closing is now mildly costly rather than
/// mildly profitable — which is the correct incentive for a janitorial action.
///
/// Auth: `gov_action::CLOSE_CONTEST` (default 2).
///
/// VaultState is zero-copy (v0.16) — load()? for bump + signer check.
#[derive(Accounts)]
pub struct CloseContest<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table. Required by every vault-authorized
    /// instruction since v0.26 — see `instructions::governance::authorize`.
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    /// CHECK: destination for ALL reclaimed rent. Pinned to the vault's
    /// `treasury_authority` (the Squads vault PDA), so the constraint — not
    /// the caller's choice of account — decides where the lamports land. It is
    /// unchecked because it is a lamport destination only: nothing reads or
    /// writes its data, and a lamport credit is valid against any account.
    #[account(
        mut,
        constraint = treasury.key() == vault_state.load()?.treasury_authority
            @ VaultError::InvalidRentDestination,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.as_ref()],
        bump = contest.bump,
        constraint = (contest.status == ContestStatus::Settled || contest.status == ContestStatus::Cancelled)
            @ VaultError::ContestNotSettled,
        close = treasury,
    )]
    pub contest: Account<'info, Contest>,

    /// Prize pool ATA — closed in this instruction. Any residual balance
    /// is swept to op_rev_usdc_ata first (decided §11 Q8).
    #[account(
        mut,
        seeds = [b"prize_pool", contest.contest_id.as_ref()],
        bump,
        token::mint = payout_mint,
        token::authority = vault_state,
    )]
    pub prize_pool: Box<Account<'info, TokenAccount>>,

    #[account(
        constraint = payout_mint.key() == vault_state.load()?.payout_mint @ VaultError::InvalidMint,
    )]
    pub payout_mint: Box<Account<'info, Mint>>,

    /// Operator-revenue USDC ATA — destination for any residual prize_pool
    /// USDC. PDA-bound to the payout mint at [b"op_rev", payout_mint].
    #[account(
        mut,
        seeds = [b"op_rev", payout_mint.key().as_ref()],
        bump,
        token::mint = payout_mint,
        token::authority = vault_state,
    )]
    pub op_rev_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_close_contest(ctx: Context<CloseContest>) -> Result<()> {
    // AUTHORIZATION — the single path (v0.26). Anchor's `close = treasury`
    // runs in the EXIT phase, after this handler, and a handler error reverts
    // the whole transaction regardless, so nothing is reclaimed unless this
    // check passes.
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::CLOSE_CONTEST,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    let dust = ctx.accounts.prize_pool.amount;

    let vault_bump = ctx.accounts.vault_state.load()?.bump;
    let vault_seeds: &[&[u8]] = &[b"vault", core::slice::from_ref(&vault_bump)];
    let signer_seeds = &[vault_seeds];

    // Sweep any residual prize_pool USDC → op_rev_usdc_ata.
    if dust > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_pool.to_account_info(),
            to: ctx.accounts.op_rev_usdc_ata.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, dust)?;
    }

    // Close the prize_pool ATA, reclaiming its rent to the TREASURY (v0.26).
    let cpi_close = CloseAccount {
        account: ctx.accounts.prize_pool.to_account_info(),
        destination: ctx.accounts.treasury.to_account_info(),
        authority: ctx.accounts.vault_state.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_close,
        signer_seeds,
    );
    token::close_account(cpi_ctx)?;

    msg!(
        "Contest closed. dust swept: {}, prize_pool ATA closed, rent reclaimed to treasury {}.",
        dust,
        ctx.accounts.treasury.key()
    );
    Ok(())
}
