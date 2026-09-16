use anchor_lang::prelude::*;
use crate::state::{VaultState, Contest, ContestStatus, GovernanceConfig, gov_action};
use crate::errors::VaultError;
use crate::instructions::governance::authorize;

/// `set_contest_conclusion_time` — set (or clear) a contest's conclusion
/// timestamp (v0.18). The conclusion marks when the contest is considered done:
/// once `Clock.unix_timestamp` passes it, `set_contest_lock_time` rejects — the
/// lock time is final. Derived like the lock (compared against the chain Clock,
/// no oracle).
///
/// Auth (v0.19 audit #5, re-expressed as data in v0.26):
///   - Setting it for the FIRST time (current conclusion == 0):
///     `gov_action::SET_CONTEST_CONCLUSION_TIME` (default 2).
///   - AMENDING an already-set conclusion (the finality marker): escalates to
///     `gov_action::SET_CONTEST_CONCLUSION_TIME_AMEND` (default 3). Clearing
///     or postponing it cheaply would let a small key set re-arm the relock —
///     the same late-entry vector as #5, one step back.
///   - Always rejected once the contest is settled/cancelled or has concluded.
///
/// Timestamps must be non-negative; a set conclusion must follow a set lock.
///
/// VaultState is zero-copy (v0.16) — read via `load()?`.
#[derive(Accounts)]
pub struct SetContestConclusionTime<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Second vault signer, named for wire compatibility with v0.25 callers.
    /// Since v0.26 it simply counts toward whichever threshold applies.
    pub cosigner: Option<Signer<'info>>,

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
        seeds = [b"contest", contest.contest_id.as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
}

pub fn handle_set_contest_conclusion_time(
    ctx: Context<SetContestConclusionTime>,
    new_conclusion_timestamp: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        ctx.accounts.contest.status != ContestStatus::Settled
            && ctx.accounts.contest.status != ContestStatus::Cancelled,
        VaultError::ContestAlreadySettled
    );

    // Once the contest has actually concluded, the conclusion is final.
    let current_conclusion = ctx.accounts.contest.conclusion_timestamp;
    if current_conclusion != 0 {
        require!(now < current_conclusion, VaultError::ContestConcluded);
    }

    // Timestamp validity (audit #5): non-negative; and if set, must be in the
    // FUTURE and follow a set lock. The future check matters even on a FIRST
    // set — the cheaper branch, at two signatures (`SET_CONTEST_CONCLUSION_TIME`;
    // amending an already-set conclusion costs three): a past conclusion would
    // immediately conclude the contest — enabling settle (the #6 gate) and
    // bricking set_contest_lock_time (ContestConcluded) — a two-signature
    // bypass of the finality guarantee.
    require!(new_conclusion_timestamp >= 0, VaultError::InvalidTimestamp);
    if new_conclusion_timestamp != 0 {
        require!(new_conclusion_timestamp > now, VaultError::InvalidTimestamp);
        let lock = ctx.accounts.contest.lock_timestamp;
        if lock != 0 {
            require!(new_conclusion_timestamp > lock, VaultError::InvalidTimestamp);
        }
    }

    // AUTHORIZATION (v0.26). Audit #5's escalation survives as a choice of
    // ACTION ID: amending an already-set conclusion (clear/postpone) is what
    // defeats the "lock is final once concluded" guarantee, so it looks up the
    // higher number. Setting it the first time (0 -> value) does not.
    let action = if current_conclusion != 0 {
        gov_action::SET_CONTEST_CONCLUSION_TIME_AMEND
    } else {
        gov_action::SET_CONTEST_CONCLUSION_TIME
    };
    {
        let vault_state = ctx.accounts.vault_state.load()?;
        let mut named: Vec<Pubkey> = vec![ctx.accounts.admin.key()];
        if let Some(cosigner) = ctx.accounts.cosigner.as_ref() {
            named.push(cosigner.key());
        }
        authorize(
            &vault_state,
            &ctx.accounts.governance,
            action,
            &named,
            ctx.remaining_accounts,
        )?;
    }

    ctx.accounts.contest.conclusion_timestamp = new_conclusion_timestamp;
    msg!(
        "Contest conclusion_timestamp set to {} for contest_id={:?} (amend: {})",
        new_conclusion_timestamp,
        ctx.accounts.contest.contest_id,
        current_conclusion != 0
    );
    Ok(())
}
