use anchor_lang::prelude::*;

/// Every error this program can return. Codes 6000+ are Anchor's
/// reserved range for program-defined errors; the numbering here is
/// stable across versions (don't renumber — Rails error-decoding maps
/// integer codes to messages).
///
/// v0.16 retired codes (kept for numbering stability — variants stay
/// in the enum but no path emits them):
///   - 6011 AccountAlreadyMigrated (retired with v0.15.1)
///   - 6012 InvalidAccountData (was reserved)
///   - 6019 WithdrawDailyCapExceeded (no more daily cap)
///
/// v0.20 un-retired 6017 SignerContinuityRequired — `update_signers` is back.
///
/// v0.16 new codes start at 6023.
///
/// v0.26 claims 6046-6059 for governance; the username registry, landing in
/// the same upgrade window, has now CLAIMED 6060-6066. See the block comment
/// in the middle of the enum for why that reservation was three unreachable
/// variants rather than a comment — a comment cannot stop Anchor, which
/// assigns codes by POSITION and would otherwise have shifted every governance
/// code under Rails' integer decoding.
#[error_code]
pub enum VaultError {
    // ── 6000-6022: stable from v0.15.1 ────────────────────────────────────
    #[msg("Only the vault admin can perform this action")]
    Unauthorized,                                // 6000
    #[msg("Token mint is not accepted by this vault")]
    InvalidMint,                                 // 6001
    #[msg("Insufficient balance for this operation")]
    InsufficientBalance,                         // 6002
    #[msg("Contest is not open for entries")]
    ContestNotOpen,                              // 6003
    #[msg("Contest is full")]
    ContestFull,                                 // 6004
    #[msg("Contest has not been settled")]
    ContestNotSettled,                           // 6005
    #[msg("Contest is already settled")]
    ContestAlreadySettled,                       // 6006
    #[msg("User already entered this contest with this entry number")]
    DuplicateEntry,                              // 6007
    #[msg("Settlement payouts exceed prize pool")]
    SettlementOverflow,                          // 6008
    #[msg("Arithmetic overflow")]
    Overflow,                                    // 6009
    #[msg("Payout amounts must sum to prize_pool amount")]
    InvalidPayoutTiers,                          // 6010
    #[msg("Account is already larger than expected — cannot migrate")]
    AccountAlreadyMigrated,                      // 6011 — retired
    #[msg("Account data is invalid or has wrong discriminator")]
    InvalidAccountData,                          // 6012 — retired
    #[msg("Invalid threshold: must be between 1 and the number of active signers (max 5)")]
    InvalidThreshold,                            // 6013
    #[msg("Duplicate signer in signers array")]
    DuplicateSigner,                             // 6014
    #[msg("Entry token has already been consumed")]
    EntryTokenAlreadyConsumed,                   // 6015
    #[msg("Entry token owner does not match the wallet entering the contest")]
    EntryTokenWrongOwner,                        // 6016
    #[msg("New signer set must retain enough of the authorizing cosigners to meet the update_signers threshold")]
    SignerContinuityRequired,                    // 6017 — live again in v0.20 (update_signers)
    #[msg("Vault is paused — user-facing funds operations are temporarily disabled")]
    VaultPaused,                                 // 6018
    #[msg("Withdrawal would exceed the per-user daily cap")]
    WithdrawDailyCapExceeded,                    // 6019 — retired
    #[msg("Username uses a reserved prefix")]
    UsernameReserved,                            // 6020
    #[msg("Username contains characters that are not printable ASCII (0x20..0x7E)")]
    UsernameInvalidChars,                        // 6021
    #[msg("Username must be at least 3 characters")]
    UsernameTooShort,                            // 6022

    // ── 6023+: new in v0.16 ───────────────────────────────────────────────
    #[msg("Currency mint is already registered in the vault registry")]
    CurrencyAlreadyRegistered,                   // 6023
    #[msg("Vault currency registry is full")]
    CurrencyRegistryFull,                        // 6024
    #[msg("Currency index is out of range or refers to an unused slot")]
    InvalidCurrencyIndex,                        // 6025
    #[msg("Currency is registered but deactivated")]
    CurrencyNotActive,                           // 6026
    #[msg("Contest does not accept this currency (entry fee is zero)")]
    EntryFeeNotSet,                              // 6027
    #[msg("Contest is not locked")]
    ContestNotLocked,                            // 6028
    #[msg("Contest cannot be cancelled in its current status")]
    ContestNotCancellable,                       // 6029
    #[msg("Prize pool account still holds tokens — cannot close contest")]
    PrizePoolNotEmpty,                           // 6030
    #[msg("Operator-revenue account is empty — nothing to sweep")]
    EmptyRevenueAccount,                         // 6031
    #[msg("Treasury ATA owner does not match the pinned treasury authority")]
    TreasuryAuthorityMismatch,                   // 6032
    #[msg("Contest must have at least one entry fee or a non-zero prize pool")]
    FeeAndPrizeBothZero,                         // 6033
    #[msg("Contest is locked — the lock timestamp has passed")]
    ContestLocked,                               // 6034
    #[msg("Contest has concluded — the conclusion timestamp has passed")]
    ContestConcluded,                            // 6035

    // ── 6036+: new in v0.19 (audit highs #3 / #5) ─────────────────────────
    #[msg("Settlement payout destination is not the winner's associated token account")]
    InvalidPayoutDestination,                    // 6036
    #[msg("Invalid contest timestamp: must be non-negative, in the future, and lock must precede conclusion")]
    InvalidTimestamp,                            // 6037
    #[msg("Entry token seed hash does not match sha256(source_ref)")]
    EntryTokenSeedMismatch,                      // 6038

    // ── 6039+: new in v0.21 (on-chain name/slug) ──────────────────────────
    #[msg("Contest name exceeds the 96-byte on-chain limit")]
    ContestNameTooLong,                          // 6039
    #[msg("Contest slug exceeds the 64-byte on-chain limit")]
    ContestSlugTooLong,                          // 6040
    #[msg("Stored slug does not hash to contest_id: sha256(slug) != contest_id")]
    ContestSlugMismatch,                         // 6041

    // ── 6042+: new for grant_seeds (quest seed bonuses) ───────────────────
    #[msg("Seed grant kind is not one of the known quest kinds")]
    InvalidSeedGrantKind,                        // 6042
    #[msg("Invite grants require a non-default invitee; non-invite grants forbid one")]
    InvalidSeedGrantInvitee,                     // 6043
    #[msg("Seed grant amount must be greater than 0 and at most MAX_GRANT_SEEDS")]
    SeedGrantAmountInvalid,                      // 6044

    // ── 6045+: new for burn_entry_token (operator claw-back) ──────────────
    #[msg("Entry token has already been burned")]
    EntryTokenAlreadyBurned,                     // 6045

    // ── 6046-6059: v0.26 governance block (RESERVED RANGE — read this) ────
    //
    // ANCHOR ASSIGNS CODES BY POSITION IN THIS ENUM, not by the comment beside
    // the variant. Two branches that each "append freely" therefore both claim
    // 6046, and whichever merges second has every one of its codes silently
    // shifted — while Rails' integer→message decoding keeps reporting the OLD
    // meaning for the new number. The v0.26 upgrade window carries two such
    // branches, so the range was split in advance: 6046-6059 belongs to the
    // governance work, 6060+ to `username-registry-on-chain`.
    //
    // The three RESERVED variants at the end of this block are what make that
    // split hold. They are unreachable by construction and exist ONLY so that
    // the next variant appended below lands on 6060 and not on 6057. Consume
    // them from the top (rename the lowest-numbered one) rather than appending
    // past them, and the boundary survives.
    #[msg("Not enough distinct vault signers authorized this action")]
    InsufficientSigners,                         // 6046
    #[msg("An account offered as a vault cosigner did not sign the transaction")]
    CosignerDidNotSign,                          // 6047
    #[msg("Threshold must be between 1 and the number of active signers")]
    GovernanceThresholdInvalid,                  // 6048
    #[msg("Threshold is below the immovable floor for this action")]
    GovernanceFloorViolation,                    // 6049
    #[msg("Governance action id is out of range")]
    InvalidGovernanceAction,                     // 6050
    #[msg("Threshold exceeds the number of active signers — would brick the action")]
    ThresholdExceedsSignerSet,                   // 6051
    #[msg("Signer set is smaller than a live threshold requires, or has a gap before an occupied slot")]
    SignerSetTooSmall,                           // 6052
    #[msg("Mint window account does not match the window the chain clock is in")]
    MintWindowMismatch,                          // 6053
    #[msg("Mint window policy invalid: window seconds must be positive and the cap non-zero")]
    InvalidMintWindowPolicy,                     // 6054
    #[msg("Invite seed grants require the invitee's own UserAccount, and that user must have entered a contest")]
    SeedGrantInviteeNotRegistered,               // 6055
    #[msg("Reclaimed rent must be paid to the vault's pinned treasury authority")]
    InvalidRentDestination,                      // 6056

    #[msg("Reserved — do not emit")]
    ReservedGovernance6057,                      // 6057 — reserved, see note above
    #[msg("Reserved — do not emit")]
    ReservedGovernance6058,                      // 6058 — reserved, see note above
    #[msg("Reserved — do not emit")]
    ReservedGovernance6059,                      // 6059 — reserved, see note above

    // ── 6060+: the username registry ──────────────────────────────────────
    //
    // Claiming the range the governance block reserved, from the top of the
    // three placeholders as that block's note instructs: 6057/6058/6059 are
    // still `ReservedGovernance*`, and these variants sit after them, so the
    // first one lands on 6060 exactly as `username_registry_error_codes_*`
    // asserts. Nothing above this line moved.
    #[msg("Username is already held by another account, or reserved by the vault")]
    UsernameAlreadyClaimed,                      // 6060
    #[msg("name_key is not the canonical lowercased form of the username")]
    UsernameKeyMismatch,                         // 6061
    #[msg("This account's current username is registered — its UsernameRecord must be passed so the rename can close it")]
    UsernameRecordMissing,                       // 6062
    #[msg("The supplied UsernameRecord is not held by this wallet")]
    UsernameRecordOwnerMismatch,                 // 6063
    #[msg("The supplied UsernameRecord does not hold this account's current username")]
    UsernameRecordNameMismatch,                  // 6064
    #[msg("A previous UsernameRecord was supplied where none is due")]
    UsernameRecordNotExpected,                   // 6065
    #[msg("The vault does not hold this username — it is not a reservation")]
    UsernameNotReserved,                         // 6066
    #[msg("The vault PDA is not a wallet — only reserve_username can make the vault hold a name")]
    VaultPdaNotAWallet,                          // 6067
}
