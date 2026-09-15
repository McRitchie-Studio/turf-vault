use anchor_lang::prelude::*;
use crate::state::{UserAccount, UsernameRecord};
use crate::errors::VaultError;
use crate::instructions::username_registry::{
    claim_or_confirm, settle_previous_record, UsernameClaimed,
};

/// `set_username` — wallet owner sets / overwrites their display username.
///
/// The on-chain UserAccount holds the master copy of the username (v0.14.0);
/// Rails mirrors it. The account owner signs the change — no admin,
/// no multisig, no rate limit.
///
/// Bytes are stored verbatim as a 32-byte zero-padded UTF-8 array. v0.15.1
/// (prelaunch audit C2) enforces a minimum on-chain validity bar — reserved
/// prefixes, printable-ASCII, length floor — so a caller bypassing Rails
/// can't claim "admin", inject control chars, or set a 1-char username.
///
/// ── UNIQUENESS IS NOW ENFORCED HERE ───────────────────────────────────────
///
/// The name is CLAIMED in the registry as part of the same transaction: a
/// `UsernameRecord` PDA at `[b"username", name_key]` whose existence is the
/// lock. A name another account already holds, or one the vault has reserved,
/// is refused with `UsernameAlreadyClaimed` (6060). The old note here said
/// uniqueness "stays off-chain in Rails" — it could not, because a caller who
/// skips Rails skips the check with it.
///
/// A RENAME must hand back the old name: pass `previous_username_record` and
/// it is closed, refunding its rent to the wallet. The rules — and the
/// accumulation bug that makes the old record mandatory rather than optional —
/// are in `username_registry::settle_previous_record`.
///
/// A CASE-ONLY change ("alice" → "Alice") keeps the same registry key, so the
/// record the wallet already holds is simply confirmed and nothing is closed.
/// Setting the identical name is therefore still idempotent.
#[derive(Accounts)]
#[instruction(username: [u8; 32], name_key: [u8; 32])]
pub struct SetUsername<'info> {
    /// `mut` since v0.26: the wallet pays rent for its own name record, and
    /// receives the refund when it gives one up.
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user", wallet.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.wallet == wallet.key() @ VaultError::Unauthorized,
    )]
    pub user_account: Account<'info, UserAccount>,

    /// The lock on the name being taken.
    #[account(
        init_if_needed,
        payer = wallet,
        space = UsernameRecord::LEN,
        seeds = [b"username".as_ref(), name_key.as_ref()],
        bump,
    )]
    pub username_record: Account<'info, UsernameRecord>,

    /// The lock on the name being given up. Required on a real rename by a
    /// registered account; refused otherwise.
    #[account(mut, close = wallet)]
    pub previous_username_record: Option<Account<'info, UsernameRecord>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_set_username(
    ctx: Context<SetUsername>,
    username: [u8; 32],
    name_key: [u8; 32],
) -> Result<()> {
    validate_username(&username)?;
    require_canonical_key(&username, &name_key)?;

    let wallet = ctx.accounts.wallet.key();
    let previous_name = ctx.accounts.user_account.username;

    settle_previous_record(
        &ctx.accounts.user_account,
        &wallet,
        &name_key,
        ctx.accounts.previous_username_record.as_deref(),
    )?;

    let bump = ctx.bumps.username_record;
    let timestamp = Clock::get()?.unix_timestamp;
    claim_or_confirm(
        &mut ctx.accounts.username_record,
        wallet,
        name_key,
        bump,
        timestamp,
    )?;

    let user = &mut ctx.accounts.user_account;
    user.username = username;
    user.username_registered = 1;

    emit!(UsernameClaimed {
        owner: wallet,
        name: name_key,
        display_name: username,
        previous_name,
        timestamp,
    });

    msg!("Username updated for: {}", wallet);
    Ok(())
}

// Prelaunch audit C2 (2026-05-24): on-chain username validity bar.
// Shared between `set_username` and `create_user_account` so a direct
// program caller can't bypass Rails' format/reservation checks on either
// entry point.
//
// UNIQUENESS IS NOW ON CHAIN — the `UsernameRecord` PDA in
// `instructions::username_registry`, which this file's callers claim. What
// STAYS off chain is what the original note called policy rather than
// consensus, and that half of it still holds: homoglyph normalization and rate
// limiting remain Rails' job. Uniqueness was the part that had to move,
// because Rails cannot enforce it against a caller who skips Rails.

/// Reserved username prefixes — case-INSENSITIVE comparison against the
/// leading bytes of the username. Anything starting with one of these is
/// rejected; protects operator/staff/brand identity from squatting.
/// KEPT, DELIBERATELY, ALONGSIDE THE REGISTRY. The two mechanisms answer
/// different questions and neither subsumes the other: the registry is
/// EXACT-MATCH, so it stops a second "admin" but not "admin123", while this
/// list stops the lookalike and cannot say anything about uniqueness. Prefix
/// list = patterns; registry = uniqueness and reservations.
///
/// `xan` is the operator's own identity and must not be claimable. Note that
/// this is a PREFIX list, so it also blocks "xanadu" — an accepted property of
/// the design, not a new one: `mod` has always blocked "modern".
///
/// `scripts/tests/username-key.test.js` parses this array out of the source
/// and fails when the off-chain copy in `scripts/lib/username-key.js` disagrees
/// with it, so the two lists cannot drift.
const RESERVED_PREFIXES: &[&[u8]] = &[
    b"admin",
    b"system",
    b"turf",
    b"vault",
    b"turfmonster",
    b"support",
    b"mod",
    b"official",
    b"staff",
    b"team",
    b"root",
    b"xan",
];

const MIN_USERNAME_LEN: usize = 3;

/// Validates a 32-byte username buffer. Returns Ok(()) iff:
///   - At least MIN_USERNAME_LEN non-null leading bytes.
///   - Every non-null byte is printable ASCII (0x20..=0x7E).
///   - The leading bytes (lowercased) do NOT start with a reserved prefix.
///
/// Trailing 0x00 bytes are treated as standard fixed-array padding and
/// allowed (the "effective length" is the index of the first 0x00, or 32).
///
/// v0.25 split this into `validate_username_charset_len` +
/// `validate_username_prefix` so an admin-authorized path could waive ONLY the
/// reserved-prefix branch. Those two instructions (`admin_create_user_account`,
/// `admin_set_username`) are DELETED; the split survives them because the
/// waiver moved to the quorum-authorized registry instructions
/// (`overwrite_username`, `reserve_username`), where it costs three signatures
/// instead of one. A vault signature has never relaxed the charset /
/// min-length bar and still does not.
pub fn validate_username(username: &[u8; 32]) -> Result<()> {
    validate_username_charset_len(username)?;
    validate_username_prefix(username)
}

/// Charset + length floor only — the non-waivable half of the validity bar.
/// Used directly by the admin-authorized username instructions.
pub fn validate_username_charset_len(username: &[u8; 32]) -> Result<()> {
    let effective_len = effective_len(username);
    require!(effective_len >= MIN_USERNAME_LEN, VaultError::UsernameTooShort);

    // Charset: every non-null byte must be printable ASCII (0x20..=0x7E).
    // This rejects control chars, high-bit bytes, and non-ASCII UTF-8 —
    // the latter is also how homoglyph attacks are kept out at this layer
    // (Rails normalizes further before this point in the legit flow).
    for &b in &username[..effective_len] {
        require!(
            (0x20..=0x7E).contains(&b),
            VaultError::UsernameInvalidChars
        );
    }

    Ok(())
}

/// Reserved-prefix check only — the half a QUORUM may waive, via
/// `overwrite_username` / `reserve_username` (the operator's own "turf" house
/// account is the canonical case). A lone wallet never can.
pub fn validate_username_prefix(username: &[u8; 32]) -> Result<()> {
    let effective_len = effective_len(username);

    // Reserved prefix: lowercase compare against each entry.
    for reserved in RESERVED_PREFIXES {
        if effective_len >= reserved.len() {
            let head = &username[..reserved.len()];
            let matches = head
                .iter()
                .zip(reserved.iter())
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
            if matches {
                return Err(error!(VaultError::UsernameReserved));
            }
        }
    }

    Ok(())
}

/// Index of the first 0x00 (fixed-array padding), or 32 if none.
pub(crate) fn effective_len(username: &[u8; 32]) -> usize {
    username.iter().position(|&b| b == 0).unwrap_or(32)
}

// ──────────────────────────────────────────────────────────────────────────
// The canonical registry key
// ──────────────────────────────────────────────────────────────────────────

/// The 32 bytes that seed a name's `UsernameRecord`: the username lowercased,
/// with its zero padding preserved.
///
/// ── THIS FUNCTION IS THE UNIQUENESS RULE ──────────────────────────────────
///
/// Two usernames collide exactly when this returns the same bytes for both, so
/// lowercasing here is what makes "Alice" and "alice" ONE name rather than two.
/// Getting that wrong in either direction is the whole bug class: fold too
/// much and distinct users are refused; fold too little and a display-name
/// impersonation walks straight through.
///
/// ── WHY THE PADDING IS PART OF THE KEY ────────────────────────────────────
///
/// The key is the FULL 32 bytes, zero padding included, rather than a slice cut
/// at the first NUL. A fixed-width seed keeps the off-chain derivation a
/// single unambiguous rule — pad the lowercased UTF-8 to 32 and hand it over —
/// with no convention for a caller to get subtly wrong, and it is what lets
/// every instruction here take `name_key: [u8; 32]` as a plain argument and
/// seed the PDA with it directly. The mapping stays injective either way:
/// padding is deterministic, so two different names cannot pad to the same
/// 32 bytes.
///
/// ONLY ASCII IS FOLDED, and that is complete rather than partial:
/// `validate_username_charset_len` has already refused every byte outside
/// 0x20..=0x7E on every path that reaches here, so there is no non-ASCII case
/// left for this to mishandle.
///
/// The off-chain twin is `canonicalKey()` in `scripts/lib/username-key.js`.
pub fn canonical_username_key(username: &[u8; 32]) -> [u8; 32] {
    let mut key = *username;
    for byte in key.iter_mut() {
        *byte = byte.to_ascii_lowercase();
    }
    key
}

/// Refuse a `name_key` argument that is not the canonical form of `username`.
///
/// The key is an ARGUMENT rather than something derived inside the account
/// struct because a PDA seed has to be available where Anchor expands
/// `#[derive(Accounts)]`. `mint_entry_token` already carries the identical
/// shape — `source_ref_hash` is passed in, seeds the PDA, and is re-derived in
/// the handler — and this is that pattern, not a new one.
///
/// It is a correctness check, not a permission check: a mismatched key would
/// otherwise lock a name nobody asked for, under a record whose stored `name`
/// disagreed with the username it was supposed to protect.
pub fn require_canonical_key(username: &[u8; 32], name_key: &[u8; 32]) -> Result<()> {
    require!(
        canonical_username_key(username) == *name_key,
        VaultError::UsernameKeyMismatch
    );
    Ok(())
}

/// Refuse a key that is not already in canonical form — i.e. that still
/// carries an uppercase byte.
///
/// Used where there is no separate display name to canonicalize FROM: a
/// reservation blocks a string rather than naming an account, so its key must
/// arrive lowercased or it would block a spelling nobody can type.
pub fn require_canonical_form(name_key: &[u8; 32]) -> Result<()> {
    require_canonical_key(name_key, name_key)
}
