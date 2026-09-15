use anchor_lang::prelude::*;
use crate::state::{
    VaultState, Season, GovernanceConfig, gov_action,
};
use crate::instructions::governance::authorize;

/// `create_season` — define a contest season with its own seed-award schedule.
///
/// Seeds are loyalty points awarded per entry. The schedule is a [u64; 5]
/// where index N is the seeds awarded for the user's Nth entry to a contest
/// in this season (entries 5+ clamp to slot 4). For example the default
/// schedule [25, 19, 14, 10, 7] rewards entry #0 with 25, then declining
/// returns for subsequent entries.
///
/// The schedule is IMMUTABLE after create — re-creating with the same
/// `season_id` is rejected by Anchor's `init` constraint.
///
/// Auth: 1-of-3 vault signer.
///
/// VaultState is zero-copy (v0.16) — load()? for the signer check.
#[derive(Accounts)]
#[instruction(season_id: u32)]
pub struct CreateSeason<'info> {
    /// Vault signer (admin) — pays SOL rent for the Season PDA.
    #[account(mut)]
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
        payer = admin,
        space = Season::LEN,
        seeds = [b"season", season_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub season: Account<'info, Season>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_season(
    ctx: Context<CreateSeason>,
    season_id: u32,
    name: [u8; 32],
    seed_schedule: [u64; 5],
    quest_seeds: [u64; 16],
    start_at: i64,
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
            gov_action::CREATE_SEASON,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    let season = &mut ctx.accounts.season;
    season.season_id = season_id;
    season.name = name;
    season.seed_schedule = seed_schedule;
    season.quest_seeds = quest_seeds; // v0.23 — per-quest-kind reward, indexed by seed_grant_kind
    season.start_at = start_at;
    season.created_at = Clock::get()?.unix_timestamp;
    season.bump = ctx.bumps.season;

    msg!(
        "Season created: id={}, schedule=[{}, {}, {}, {}, {}], start_at={}",
        season_id,
        seed_schedule[0],
        seed_schedule[1],
        seed_schedule[2],
        seed_schedule[3],
        seed_schedule[4],
        start_at
    );
    Ok(())
}
