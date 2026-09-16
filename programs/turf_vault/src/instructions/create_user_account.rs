use anchor_lang::prelude::*;
use crate::errors::VaultError;
use crate::state::{UserAccount, UsernameRecord};
use crate::instructions::set_username::{require_canonical_key, validate_username};
use crate::instructions::username_registry::{claim_or_confirm, UsernameClaimed};

/// `create_user_account` — first-touch onboarding for a wallet.
///
/// Allocates a UserAccount PDA at the v0.16 layout. All counters start at
/// zero. The username is set at creation time (per-byte zero-padded);
/// owner can change it later via `set_username`.
///
/// Permissionless payer: anyone can pay SOL rent for any wallet's account
/// (enables operator-funded onboarding). The wallet itself is NOT a
/// signer on this call — Rails creates it after a managed-wallet
/// generates, or before the first Phantom-wallet entry.
///
/// THE NAME IS CLAIMED IN THE SAME TRANSACTION. Creating the `UserAccount`
/// without its `UsernameRecord` would leave an account displaying a name it
/// does not hold — exactly the window uniqueness exists to close, and a
/// permissionless instruction is precisely where it would be raced. So the
/// record is allocated here too, and a signup for a name already taken (or
/// reserved by the vault) fails with `UsernameAlreadyClaimed` (6060) rather
/// than succeeding into an unlockable state.
///
/// ── AND THE OWNER IT CLAIMS WITH IS DATA, SO IT IS CHECKED ────────────────
///
/// `wallet` is an ARGUMENT, not a `Signer`, and that is load-bearing rather
/// than lax: neither live onboarding path has the wallet's signature to offer.
/// Rails creates the account for a **Phantom** wallet it holds no key for (a
/// server-signed preamble before the entry that wallet will sign), and for a
/// **managed** wallet from a background job at signup. Requiring a signature
/// here would end both.
///
/// The cost of that is that the record's owner is whatever the caller says,
/// and `claim_or_confirm` only refuses `Pubkey::default()`. So a caller could
/// name the `[b"vault"]` PDA and mint a record indistinguishable from the
/// reservation `reserve_username` makes at three signatures —
/// `UsernameRecord`'s doc rests uniqueness on "a player-held record is written
/// from a `Signer`'s key and can therefore never collide with the vault PDA",
/// and this was the one path where the premise did not hold.
///
/// `require_not_vault_pda` closes it, and closes it COMPLETELY rather than
/// partially: `UsernameRecord::is_reserved` reads exactly two owners as
/// reserved — the vault PDA and `Pubkey::default()` — and `claim_or_confirm`
/// already refuses the second. Refusing an off-curve `wallet` outright would
/// be broader but no more complete here, and it is not available anyway:
/// `Pubkey::is_on_curve` is `unimplemented!()` under `target_os = "solana"`, so
/// an on-curve test on chain means adding the `solana-curve25519` syscall crate
/// to a binary that upgrades through a 3-of-5 Squads ceremony. What the broader
/// check would additionally stop — naming some arbitrary key nobody holds — is
/// the unbounded squatting this design already accepts and answers with
/// `overwrite_username`, which needs no consent from the holder it evicts.
#[derive(Accounts)]
#[instruction(wallet: Pubkey, username: [u8; 32], name_key: [u8; 32])]
pub struct CreateUserAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user", wallet.as_ref()],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        space = UsernameRecord::LEN,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_user_account(
    ctx: Context<CreateUserAccount>,
    wallet: Pubkey,
    username: [u8; 32],
    name_key: [u8; 32],
) -> Result<()> {
    // FIRST, BEFORE ANY CHECK ON THE NAME. Anchor returns the first failing
    // constraint, so ordering decides which error a forged call sees — and a
    // caller impersonating the vault must not be able to choose a different,
    // less alarming refusal by also passing a bad username. Who is claiming is
    // decided before what they are claiming.
    //
    // Derived rather than taken as an account: adding `vault_state` to the
    // account list would be a wire change every caller has to ship in the same
    // breath, for a check that needs no account data. `ctx.program_id` keeps
    // this correct on both the devnet and mainnet `declare_id!` branches.
    let (vault_pda, _) = Pubkey::find_program_address(&[b"vault"], ctx.program_id);
    require_not_vault_pda(&wallet, &vault_pda)?;

    // Prelaunch audit C2: on-chain username validity bar. Reserved-prefix
    // and printable-ASCII gate so an attacker front-running a signup can't
    // claim "admin" or inject control chars.
    validate_username(&username)?;
    require_canonical_key(&username, &name_key)?;

    let bump = ctx.bumps.username_record;
    let timestamp = Clock::get()?.unix_timestamp;
    claim_or_confirm(
        &mut ctx.accounts.username_record,
        wallet,
        name_key,
        bump,
        timestamp,
    )?;

    init_user_account(&mut ctx.accounts.user_account, wallet, username, ctx.bumps.user_account);

    emit!(UsernameClaimed {
        owner: wallet,
        name: name_key,
        display_name: username,
        previous_name: [0u8; 32],
        timestamp,
    });

    msg!("User account created for: {}", wallet);
    Ok(())
}

/// A signup may not name the vault's own `[b"vault"]` PDA as its wallet.
///
/// Split out from the handler so the rule is assertable on the host target,
/// where `find_program_address` needs a curve feature the program build does
/// not carry — the comparison is the rule, the derivation is just how the
/// handler gets its second argument.
pub fn require_not_vault_pda(wallet: &Pubkey, vault: &Pubkey) -> Result<()> {
    require!(wallet != vault, VaultError::VaultPdaNotAWallet);
    Ok(())
}

/// Shared field initialization for a freshly-allocated UserAccount PDA.
///
/// It had two callers until `admin_create_user_account` was deleted with the
/// registry change; it stays a function because the `username_registered`
/// flag below is exactly the kind of field a second entry point would forget.
pub fn init_user_account(
    user: &mut UserAccount,
    wallet: Pubkey,
    username: [u8; 32],
    bump: u8,
) {
    user.wallet = wallet;
    user.username = username;
    user.seeds = 0;
    user.entries = 0;
    user.wins = 0;
    user.cashes = 0;
    user.total_won = 0;
    user.bump = bump;
    // The name IS locked — every path that reaches here claims its record in
    // the same transaction. An account created with this flag left at 0 would
    // be able to rename without handing its name back.
    user.username_registered = 1;
    user._reserved = [0; 31];
}
