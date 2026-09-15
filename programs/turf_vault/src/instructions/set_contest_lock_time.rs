use anchor_lang::prelude::*;
use crate::state::{VaultState, Contest, ContestStatus, GovernanceConfig, gov_action};
use crate::errors::VaultError;
use crate::instructions::governance::authorize;

/// `set_contest_lock_time` — set (or clear) a contest's derived lock timestamp.
///
/// Locking is a derived property (v0.17): `enter_contest{,_with_token}` reject
/// entries once `Clock.unix_timestamp >= contest.lock_timestamp`. This is the
/// ONLY lock mechanism. "Lock now" is expressed by passing the current chain
/// time; `new_lock_timestamp == 0` clears the lock (enterable indefinitely).
///
/// Auth (v0.19 audit #5, re-expressed as data in v0.26):
///   - BEFORE the lock has passed: `gov_action::SET_CONTEST_LOCK_TIME`
///     (default 2) — a routine reschedule.
///   - AFTER the lock has passed (lock_timestamp != 0 && now >= it): amending
///     it RE-OPENS a contest whose entry window already closed, which is the
///     results-known late-entry vector, so it escalates to
///     `gov_action::SET_CONTEST_LOCK_TIME_REOPEN` (default 3).
///   - Always rejected once the contest is settled/cancelled or has concluded.
///
/// Both numbers are stored, so the escalation can be retuned without a
/// redeploy — but the ESCALATION ITSELF is structural: the branch below picks
/// which action id to look up, and no threshold value can collapse the two
/// paths into one.
///
/// Timestamps must be non-negative; a set lock must precede a set conclusion.
///
/// VaultState is zero-copy (v0.16) — read via `load()?`.
#[derive(Accounts)]
pub struct SetContestLockTime<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Second vault signer, named for wire compatibility with v0.25 callers.
    /// Since v0.26 it simply counts toward whichever threshold applies — pass
    /// it and it is one of the required signatures; omit it and the same
    /// signature must arrive through `remaining_accounts` instead.
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

pub fn handle_set_contest_lock_time(
    ctx: Context<SetContestLockTime>,
    new_lock_timestamp: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Final once settled/cancelled or concluded.
    require!(
        ctx.accounts.contest.status != ContestStatus::Settled
            && ctx.accounts.contest.status != ContestStatus::Cancelled,
        VaultError::ContestAlreadySettled
    );
    let conclusion = ctx.accounts.contest.conclusion_timestamp;
    if conclusion != 0 {
        require!(now < conclusion, VaultError::ContestConcluded);
    }

    // Timestamp validity (audit #5): non-negative; a set lock must precede a
    // set conclusion. (A past/now value is allowed — it locks immediately.)
    require!(new_lock_timestamp >= 0, VaultError::InvalidTimestamp);
    if new_lock_timestamp != 0 && conclusion != 0 {
        require!(new_lock_timestamp < conclusion, VaultError::InvalidTimestamp);
    }

    // AUTHORIZATION (v0.26). Audit #5's re-open protection survives as a
    // choice of ACTION ID rather than a hand-rolled second check: once the
    // lock has PASSED, amending it re-opens a closed entry window, so the
    // lookup escalates. Everything above this point only READS the contest —
    // the write is below — so running the check here rather than in a
    // constraint changes nothing about what is protected.
    let current_lock = ctx.accounts.contest.lock_timestamp;
    let lock_engaged = current_lock != 0 && now >= current_lock;
    let action = if lock_engaged {
        gov_action::SET_CONTEST_LOCK_TIME_REOPEN
    } else {
        gov_action::SET_CONTEST_LOCK_TIME
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

    ctx.accounts.contest.lock_timestamp = new_lock_timestamp;
    msg!(
        "Contest lock_timestamp set to {} for contest_id={:?} (post-lock re-open: {})",
        new_lock_timestamp,
        ctx.accounts.contest.contest_id,
        lock_engaged
    );
    Ok(())
}
