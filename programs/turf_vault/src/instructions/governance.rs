use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::{
    gov_action, GovernanceConfig, VaultState, DEFAULT_MINT_WINDOW_CAP,
    DEFAULT_MINT_WINDOW_SECONDS, DEFAULT_THRESHOLDS, MAX_SIGNERS,
};

/// Signatures required to BOOTSTRAP the governance account.
///
/// Two, deliberately — and it is safe at two only because `init_governance`
/// TAKES NO ARGUMENTS. It can write exactly one thing: the compiled-in default
/// table. So the party that bootstraps cannot choose weak numbers, and the
/// worst an unwanted bootstrap achieves is installing the safe defaults one
/// transaction earlier than planned. Retuning any of them afterwards costs
/// `SET_GOVERNANCE` (three).
///
/// Two is also what the CURRENT live signer set can actually assemble on the
/// day of the upgrade, which matters: the vault's governance instructions all
/// require this account, so a bootstrap that needed a signature the operator
/// could not yet produce would strand the platform.
pub const BOOTSTRAP_THRESHOLD: u8 = 2;

// ──────────────────────────────────────────────────────────────────────────
// THE AUTHORIZATION PATH
// ──────────────────────────────────────────────────────────────────────────

/// Authorize one governance action. EVERY vault-authorized instruction in this
/// program goes through this function and nothing else.
///
/// ── WHAT IT REPLACED ──────────────────────────────────────────────────────
///
/// Until v0.26 there were two auth shapes, both in `#[account(constraint = …)]`
/// attributes: `is_signer(&admin.key())` for "routine" ops and
/// `validate_multisig(&admin.key(), &cosigner.key())` for "treasury" ops. The
/// second one was the bug. It read
///
/// ```text
/// s1 != s2 && is_signer(s1) && is_signer(s2)
/// ```
///
/// which is structurally EXACTLY TWO SIGNATURES and never reads
/// `vault.threshold` at all. The threshold field was decorative for the
/// program's whole life — a vault storing `3` still settled contests on two
/// signatures, and every doc in the repo said "2-of-3" because two was all the
/// code could express.
///
/// ── HOW EXTRA SIGNERS ARE PASSED ──────────────────────────────────────────
///
/// Named `Signer` accounts first (`admin`, and `cosigner` where the
/// instruction already had one), then as many LEADING `remaining_accounts` as
/// the threshold still needs. The count is not guessed — it is exactly
/// `required - named.len()`, and `required` comes from the stored table, so
/// the split is deterministic for both sides of the wire.
///
/// This shape was chosen over adding `Option<Signer>` fields to fourteen
/// account structs for one reason: an instruction whose threshold its NAMED
/// signers already satisfy needs NO client change at all. `pause` at two still
/// takes `[admin, cosigner, vault_state, governance]` and every existing
/// caller keeps working. Only the actions that actually went up have to pass
/// anything new.
///
/// It FAILS CLOSED. A caller that does not know the threshold rose sends its
/// old account list; the first leading remaining account is then read as a
/// cosigner, is not a signer (or is not in the signer set), and the call is
/// rejected. The failure mode is a refused transaction, never a silent
/// under-authorized one.
///
/// Returns how many `remaining_accounts` were consumed, so an instruction that
/// also uses `remaining_accounts` for payload (only `settle_contest` does) can
/// split them apart.
pub fn authorize(
    vault: &VaultState,
    governance: &GovernanceConfig,
    action: u8,
    named: &[Pubkey],
    remaining: &[AccountInfo],
) -> Result<usize> {
    require!(
        (action as usize) < gov_action::COUNT,
        VaultError::InvalidGovernanceAction
    );

    let required = governance.threshold_for(action);
    require!(
        required >= 1 && (required as usize) <= MAX_SIGNERS,
        VaultError::GovernanceThresholdInvalid
    );

    let extra_needed = (required as usize).saturating_sub(named.len());
    require!(
        remaining.len() >= extra_needed,
        VaultError::InsufficientSigners
    );

    let mut keys: Vec<Pubkey> = Vec::with_capacity(named.len() + extra_needed);
    keys.extend_from_slice(named);
    for info in remaining.iter().take(extra_needed) {
        // A remaining account is raw AccountInfo — Anchor has proven nothing
        // about it. The `is_signer` flag is the whole reason this check exists;
        // without it any pubkey from the signer set could be named by anyone.
        require!(info.is_signer, VaultError::CosignerDidNotSign);
        keys.push(info.key());
    }

    // Distinctness, membership and the count are all `validate_threshold`'s.
    vault.validate_threshold(&keys, required)?;
    Ok(extra_needed)
}

// ──────────────────────────────────────────────────────────────────────────
// init_governance
// ──────────────────────────────────────────────────────────────────────────

/// `init_governance` — create the per-action threshold table.
///
/// NO ARGUMENTS BY DESIGN. It writes `DEFAULT_THRESHOLDS` verbatim, which is
/// what makes a two-signature bootstrap safe (see `BOOTSTRAP_THRESHOLD`).
///
/// ORDERING NOTE FOR THE DEPLOY. Every vault-authorized instruction requires
/// this account, so it must be created immediately after the program upgrade
/// lands and before normal operation resumes. `init` collides on a second
/// call, so it is idempotent in the only sense that matters: it cannot be run
/// twice to overwrite a retuned table.
#[derive(Accounts)]
pub struct InitGovernance<'info> {
    /// Vault signer; pays rent for the GovernanceConfig PDA.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(
        init,
        payer = admin,
        space = GovernanceConfig::LEN,
        seeds = [b"governance"],
        bump,
    )]
    pub governance: Account<'info, GovernanceConfig>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: leading extra cosigners, `BOOTSTRAP_THRESHOLD - 1`.
}

pub fn handle_init_governance(ctx: Context<InitGovernance>) -> Result<()> {
    // Cannot use `authorize` — that reads the very account being created.
    // Same collection rules, with the bootstrap threshold in place of a
    // looked-up one.
    {
        let vault = ctx.accounts.vault_state.load()?;
        let mut keys: Vec<Pubkey> = vec![ctx.accounts.admin.key()];
        let extra = (BOOTSTRAP_THRESHOLD as usize).saturating_sub(keys.len());
        require!(
            ctx.remaining_accounts.len() >= extra,
            VaultError::InsufficientSigners
        );
        for info in ctx.remaining_accounts.iter().take(extra) {
            require!(info.is_signer, VaultError::CosignerDidNotSign);
            keys.push(info.key());
        }
        vault.validate_threshold(&keys, BOOTSTRAP_THRESHOLD)?;
    }

    let governance = &mut ctx.accounts.governance;
    governance.thresholds = DEFAULT_THRESHOLDS;
    governance.mint_window_seconds = DEFAULT_MINT_WINDOW_SECONDS;
    governance.mint_window_cap = DEFAULT_MINT_WINDOW_CAP;
    governance.bump = ctx.bumps.governance;
    governance._reserved = [0; 64];

    msg!(
        "Governance initialized with shipped defaults. settle={}, pause={}, unpause={}, update_signers={}, burn={}, mint_window={}s cap={}",
        governance.threshold_for(gov_action::SETTLE_CONTEST),
        governance.threshold_for(gov_action::PAUSE),
        governance.threshold_for(gov_action::UNPAUSE),
        governance.threshold_for(gov_action::UPDATE_SIGNERS),
        governance.threshold_for(gov_action::BURN_ENTRY_TOKEN),
        governance.mint_window_seconds,
        governance.mint_window_cap,
    );
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// set_action_threshold
// ──────────────────────────────────────────────────────────────────────────

/// `set_action_threshold` — retune one action's required signature count.
///
/// This is the instruction that makes every number in `DEFAULT_THRESHOLDS`
/// reversible, and therefore makes picking the safe default the cheap choice
/// rather than a commitment.
///
/// Auth: `SET_GOVERNANCE` (three, floored — it cannot lower the bar on itself).
///
/// Refuses, in this order:
///   - an unknown action id (`InvalidGovernanceAction`),
///   - a value below the action's immovable floor (`GovernanceFloorViolation`),
///   - zero or more than `MAX_SIGNERS` (`GovernanceThresholdInvalid`),
///   - more than the vault currently HAS signers (`ThresholdExceedsSignerSet`) —
///     storing a threshold the signer set cannot satisfy would brick that
///     action, and for `update_signers` it would brick the only way back.
#[derive(Accounts)]
pub struct SetActionThreshold<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(mut, seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,
    // remaining_accounts: leading extra cosigners.
}

pub fn handle_set_action_threshold(
    ctx: Context<SetActionThreshold>,
    action: u8,
    value: u8,
) -> Result<()> {
    let (active_signers, previous) = {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::SET_GOVERNANCE,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
        (
            vault.active_signer_count(),
            ctx.accounts.governance.threshold_for(action),
        )
    };

    require!(
        (action as usize) < gov_action::COUNT,
        VaultError::InvalidGovernanceAction
    );
    require!(
        value >= GovernanceConfig::floor_for(action),
        VaultError::GovernanceFloorViolation
    );
    require!(
        value >= 1 && (value as usize) <= MAX_SIGNERS,
        VaultError::GovernanceThresholdInvalid
    );
    require!(
        value <= active_signers,
        VaultError::ThresholdExceedsSignerSet
    );

    ctx.accounts.governance.thresholds[action as usize] = value;

    msg!(
        "Governance threshold for action {} changed {} -> {} (active signers {})",
        action,
        previous,
        value,
        active_signers
    );
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// set_mint_window_policy
// ──────────────────────────────────────────────────────────────────────────

/// `set_mint_window_policy` — retune the entry-token mint cap.
///
/// The cap is data for the same reason the thresholds are: the right number
/// for "free entries per day before this needs three humans" is an operational
/// observation, not something to guess once and bake into a binary.
///
/// Auth: `SET_GOVERNANCE`.
///
/// Changing `mint_window_seconds` re-partitions time, so the window index a
/// given moment maps to changes and the NEXT mint lands in a fresh, empty
/// counter. That is a one-window loosening, and it is why the window length is
/// expected to be set once and left alone; the CAP is the knob to turn.
#[derive(Accounts)]
pub struct SetMintWindowPolicy<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    #[account(mut, seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,
    // remaining_accounts: leading extra cosigners.
}

pub fn handle_set_mint_window_policy(
    ctx: Context<SetMintWindowPolicy>,
    window_seconds: i64,
    cap: u32,
) -> Result<()> {
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::SET_GOVERNANCE,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    require!(
        window_seconds > 0 && cap > 0,
        VaultError::InvalidMintWindowPolicy
    );

    let governance = &mut ctx.accounts.governance;
    governance.mint_window_seconds = window_seconds;
    governance.mint_window_cap = cap;

    msg!(
        "Mint window policy set: {}s per window, cap {}",
        window_seconds,
        cap
    );
    Ok(())
}
