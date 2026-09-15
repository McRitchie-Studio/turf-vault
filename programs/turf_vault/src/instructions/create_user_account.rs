use anchor_lang::prelude::*;
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
