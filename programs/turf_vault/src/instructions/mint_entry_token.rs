use anchor_lang::prelude::*;
use solana_program::hash::hash;
use crate::state::{
    gov_action, EntryTokenAccount, GovernanceConfig, MintWindow, VaultState,
};
use crate::errors::VaultError;
use crate::instructions::governance::authorize;

/// `mint_entry_token` — admin mints a pre-purchased contest-entry voucher
/// for a user.
///
/// The recipient (user) later consumes one of these via
/// enter_contest_with_token to enter a contest without paying the USDC
/// entry fee at entry time. Typical triggers: a Stripe purchase
/// (TokenPurchaseJob), an operator gift (admin UI), a level-up reward.
///
/// PDA seeds (v0.19, audit #9): [b"entry_token", source_ref_hash], where
/// `source_ref_hash` is passed by the caller and the handler asserts it equals
/// `sha256(source_ref)`. (The hash is passed as a fixed-size arg rather than
/// computed in the seed expression because `anchor idl build` cannot represent
/// a function-call seed; the on-chain assert keeps the binding sound.) The PDA
/// is therefore derived from a hash of the external reference, so re-minting the
/// same `source_ref` collides on `init` and fails — TRUE on-chain idempotency
/// (replaces the old caller-supplied `sequence`, which let the same source_ref
/// mint unlimited distinct tokens). `source_ref` must therefore be GLOBALLY
/// unique across wallets (the Stripe path namespaces by session_id; operator
/// mints must use a per-mint-unique ref). `owner` is stored in the account body
/// (not a seed), so getProgramAccounts discovery by owner is unchanged.
///
/// ── AUTH: A PER-WINDOW CAP, NOT A FLAT THRESHOLD (v0.26) ──────────────────
///
/// An entry token is a claim on a real prize pool, and minting one was a
/// 1-of-N routine op with NO CEILING of any kind. A single signature could
/// mint unlimited free entries — the largest of the three value-creation
/// findings, because unlike a leaked key that spends a balance, this one
/// creates the value it spends.
///
/// The fix is a CAP THAT RAISES THE BAR rather than a door that closes:
///
///   within the window's cap   `gov_action::MINT_ENTRY_TOKEN`          (1)
///   above it                  `gov_action::MINT_ENTRY_TOKEN_OVER_CAP` (3)
///
/// So the ordinary Stripe-fulfilment path is untouched at one signature, and a
/// mint run that would exceed the day's budget does not FAIL — it asks for
/// three humans. An operator with a legitimate spike is never blocked; an
/// agent minting on its own hits a ceiling it cannot raise, because both the
/// cap and the over-cap threshold live in `GovernanceConfig`.
///
/// The counter lives in a `MintWindow` PDA keyed by window index — it could
/// not live on `VaultState`, whose reserve was consumed exactly by the two new
/// signer slots. `window_index` is an INSTRUCTION ARGUMENT because it is a PDA
/// seed and Anchor's IDL build cannot express a computed seed; the handler
/// asserts it against the chain clock, so a caller cannot pick an empty window
/// to mint into.
///
/// The user_wallet is NOT a signer — tokens can be minted for any wallet.
/// (Consent at redemption time is enforced separately by the consume
/// instructions.) The seed-based idempotency closes double-mint/replay
/// regardless of the signer count.
///
/// NOT gated by vault pause — operators must be able to fulfill Stripe
/// purchases that completed before the pause.
///
/// VaultState is zero-copy (v0.16) — load()? for the signer check.
#[derive(Accounts)]
#[instruction(source: u8, source_ref: [u8; 64], source_ref_hash: [u8; 32], window_index: i64)]
pub struct MintEntryToken<'info> {
    /// Vault signer (admin) — pays SOL rent for the EntryTokenAccount PDA.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table, and the mint-window policy (length + cap).
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,

    /// Per-window mint counter. Created on the window's first mint.
    ///
    /// `init_if_needed` is safe here against the reinit attack it usually
    /// invites: nothing in this program closes a `MintWindow`, so the account
    /// cannot be destroyed and re-created to zero the counter. Its fields are
    /// either derived from the seed (`window_index`, `bump`) or monotonic
    /// (`minted`), so a fresh zeroed account and an existing one take the same
    /// code path.
    #[account(
        init_if_needed,
        payer = admin,
        space = MintWindow::LEN,
        seeds = [b"mint_window", window_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub mint_window: Account<'info, MintWindow>,

    /// CHECK: The recipient wallet. Used only to set `owner` on the new
    /// account (NOT a PDA seed in v0.19). Not a signer; not modified.
    pub user_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = EntryTokenAccount::LEN,
        seeds = [
            b"entry_token".as_ref(),
            source_ref_hash.as_ref(),
        ],
        bump,
    )]
    pub entry_token: Account<'info, EntryTokenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handle_mint_entry_token(
    ctx: Context<MintEntryToken>,
    source: u8,
    source_ref: [u8; 64],
    source_ref_hash: [u8; 32],
    window_index: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // The window is a PDA SEED, so it is caller-supplied. Pin it to the chain
    // clock or the cap is decorative: a caller could otherwise name a window
    // far in the past or future, find its counter at zero, and mint at the low
    // threshold forever without ever touching today's count.
    let current_window = ctx.accounts.governance.window_index_for(now)?;
    require!(
        window_index == current_window,
        VaultError::MintWindowMismatch
    );

    // WHICH ACTION APPLIES is decided by the count BEFORE this mint, so the
    // mint that would cross the cap is itself the first one to need three
    // signatures — not the one after it.
    let cap = ctx.accounts.governance.mint_window_cap;
    require!(cap > 0, VaultError::InvalidMintWindowPolicy);
    let already_minted = ctx.accounts.mint_window.minted;
    let action = if already_minted < cap {
        gov_action::MINT_ENTRY_TOKEN
    } else {
        gov_action::MINT_ENTRY_TOKEN_OVER_CAP
    };

    // AUTHORIZATION — the single path (v0.26).
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            action,
            &[ctx.accounts.admin.key()],
            ctx.remaining_accounts,
        )?;
    }

    // Bind the PDA seed hash to source_ref: the seed is a caller-supplied arg
    // (IDL-build can't encode a function-call seed), so assert it really is
    // sha256(source_ref). Catches a wrong client-side hash loudly instead of
    // minting at a PDA that doesn't match the stored ref (audit #9).
    require!(
        hash(&source_ref).to_bytes() == source_ref_hash,
        VaultError::EntryTokenSeedMismatch
    );

    let user_wallet = ctx.accounts.user_wallet.key();
    let entry_token = &mut ctx.accounts.entry_token;
    entry_token.owner = user_wallet;
    entry_token.source = source;
    entry_token.source_ref = source_ref;
    entry_token.consumed = false;
    entry_token.consumed_at = None;
    entry_token.created_at = now;
    entry_token.bump = ctx.bumps.entry_token;

    // Record the mint against the window. Written after the token so a
    // failure above cannot inflate the counter.
    let mint_window = &mut ctx.accounts.mint_window;
    mint_window.window_index = window_index;
    mint_window.bump = ctx.bumps.mint_window;
    mint_window.minted = mint_window
        .minted
        .checked_add(1)
        .ok_or(VaultError::Overflow)?;

    msg!(
        "Entry token minted for {} (source: {}). Window {}: {}/{} used{}",
        ctx.accounts.entry_token.owner,
        source,
        window_index,
        mint_window.minted,
        cap,
        if already_minted >= cap { " — OVER CAP" } else { "" }
    );
    Ok(())
}
