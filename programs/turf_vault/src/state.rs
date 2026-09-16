use anchor_lang::prelude::*;

use crate::errors::VaultError;

// ──────────────────────────────────────────────────────────────────────────
// Program-wide constants (compile-time, immutable)
// ──────────────────────────────────────────────────────────────────────────
//
// These constants harden the vault against the "frontrun-initialize" attack
// class: once the program is deployed, anyone can race the first call to
// `initialize` and become the vault owner. By baking the expected init
// authority and accepted mints into the program itself, an attacker can't
// initialize the vault even if they win the race — Anchor rejects the TX
// before it touches state.
//
// Build profiles:
//   default (devnet) — uses devnet test mints
//   --features mainnet — uses canonical mainnet USDC + USDT mints
// ──────────────────────────────────────────────────────────────────────────

/// Maximum number of multisig signer slots the vault can hold.
///
/// FIVE IS A HARD CEILING SET BY THE ACCOUNT, not a policy choice. `VaultState`
/// had exactly 64 reserved bytes and a Pubkey is 32, so two appended slots
/// consume the reserve precisely. A sixth slot would have to grow the account,
/// which for a `zero_copy` singleton means a realloc + a migration instruction
/// and a window in which the vault is half-written. Raise this ONLY together
/// with that migration.
pub const MAX_SIGNERS: usize = 5;

/// Maximum number of currencies in the on-chain registry. Capped at 16 to
/// keep `accepted_currencies` at 1280 bytes (16 × 80) and `entry_fee_by_currency`
/// / `entry_fees` at 128 bytes (16 × 8) each.
pub const MAX_CURRENCIES: usize = 16;

/// Max payout tiers per contest. Mirrors the v0.15.1 `#[max_len(10)]`.
pub const MAX_PAYOUT_TIERS: usize = 10;

/// The single wallet permitted to call `initialize` on a mainnet build.
/// Hardcoded to Alex's Phantom key — never lives on the server, so a
/// Heroku/AWS compromise can't reinit the vault.
///
/// This matters once-per-deployment. After `initialize` runs, it's never
/// checked again — vault ops use `vault_state.signers` / `validate_multisig`.
/// Operational cost: Alex signs the one-time init TX from Phantom (or a
/// local CLI loaded with their key); the bot takes over for everything else.
///
/// Bytes = base58 decode of `7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr`.
#[cfg(feature = "mainnet")]
pub const INIT_AUTHORITY: Pubkey = Pubkey::new_from_array([
    97, 102, 159, 134, 4, 135, 247, 38, 25, 80, 120, 222, 238, 244, 126, 240,
    127, 147, 165, 62, 97, 27, 221, 166, 58, 24, 35, 40, 64, 79, 47, 199,
]);

/// USDC mint pinned by a mainnet build (canonical Circle USDC). Used to
/// pin both `vault_state.payout_mint` AND `accepted_currencies[0].mint`.
/// Bytes = base58 decode of `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
#[cfg(feature = "mainnet")]
pub const EXPECTED_USDC_MINT: Pubkey = Pubkey::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49,
    177, 187, 228, 194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);

/// USDT mint pinned by a mainnet build (canonical Tether USDT). Used to
/// pin `accepted_currencies[1].mint`. (USDT is not the payout mint in v0.16;
/// it's just the second pre-registered entry-fee currency.)
/// Bytes = base58 decode of `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`.
#[cfg(feature = "mainnet")]
pub const EXPECTED_USDT_MINT: Pubkey = Pubkey::new_from_array([
    206, 1, 14, 96, 175, 237, 178, 39, 23, 189, 99, 25, 47, 84, 20, 90,
    63, 150, 90, 51, 187, 130, 210, 199, 2, 158, 178, 206, 30, 32, 130, 100,
]);

// ──────────────────────────────────────────────────────────────────────────
// AcceptedCurrency
// ──────────────────────────────────────────────────────────────────────────

/// One slot in the on-chain currency registry. `mint == Pubkey::default()`
/// means the slot is unused. `active == 0` means the slot is registered
/// but disabled for new entries / new contests (slot is never reclaimed —
/// preserves currency_idx stability across the program's life).
///
/// `kind` is an operator tag (0 = stablecoin, 1 = sol-wrapped, etc.) —
/// informational only, never consulted by program logic. `_pad` reserves
/// 14 bytes for future fields (per-currency fee-cap, display ticker, etc.).
///
/// Zero-copy (Pod-safe): `active` is u8 (0/1) rather than bool — bool is
/// not Pod-safe because non-{0,1} byte values cause undefined behavior.
/// We provide unsafe Pod + Zeroable impls so this struct can sit inside
/// `VaultState`'s `accepted_currencies: [AcceptedCurrency; 16]` and be
/// re-interpreted from the account's raw bytes via bytemuck.
#[repr(C)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AcceptedCurrency {
    /// SPL mint for this currency. `Pubkey::default()` for unused slots.
    pub mint: Pubkey,             // 32
    /// Per-currency operator-revenue ATA (PDA at [b"op_rev", mint]).
    pub op_rev_ata: Pubkey,       // 32
    /// Operator tag (0 = stablecoin, 1 = sol-wrapped, ...). Informational.
    pub kind: u8,                 //  1
    /// 1 == active; 0 == deactivated. Flip to 0 via `deactivate_currency`.
    /// u8 instead of bool for Pod safety (zero-copy compatibility).
    pub active: u8,               //  1
    /// Reserved padding for forward-compat. 14 bytes brings the struct to
    /// 80 bytes total for clean alignment + future field expansion.
    pub _pad: [u8; 14],           // 14
}
// Total: 80 bytes per slot. 16 slots = 1280 bytes.

// SAFETY: AcceptedCurrency is `#[repr(C)]` and every field is itself Pod
// (Pubkey is Pod via solana_program, u8 + u8 + [u8; 14] are trivially Pod).
// No padding bytes — fields pack to exactly 80 bytes (32+32+1+1+14).
unsafe impl anchor_lang::__private::bytemuck::Pod for AcceptedCurrency {}
unsafe impl anchor_lang::__private::bytemuck::Zeroable for AcceptedCurrency {}

// ──────────────────────────────────────────────────────────────────────────
// Accounts
// ──────────────────────────────────────────────────────────────────────────

/// Singleton vault account. Holds the multisig signer set (up to
/// `MAX_SIGNERS`), the pinned payout mint (USDC), the per-currency registry,
/// a treasury authority pin, and a pause flag.
///
/// PDA seeds: [b"vault"]
///
/// Zero-copy: VaultState is too large (~1507 data bytes) to deserialize
/// onto BPF's 4KB stack via borsh. Anchor's `#[account(zero_copy)]` maps
/// the account data buffer directly as a typed reference via bytemuck::Pod,
/// avoiding the full-struct stack alloc that borsh's deserialize_reader
/// would perform.
///
/// ── LAYOUT IS POSITIONAL. READ THIS BEFORE EDITING A FIELD ────────────────
///
/// `zero_copy(unsafe)` + `#[repr(C)]` means every field's OFFSET is its
/// identity. There is no name-keyed decode and no version tag: the program
/// reads byte range 96..97 and calls it `threshold` because that is where
/// `threshold` sits, not because anything on chain says so.
///
/// So a field may only ever be APPENDED, never inserted and never widened in
/// place. v0.26 needed two more signer slots and the tempting edit was
/// `signers: [Pubkey; 3]` → `[Pubkey; 5]`. That single character shifts
/// `threshold`, `bump`, `paused`, `payout_mint`, `treasury_authority` and the
/// entire 1280-byte currency registry 64 bytes to the right — and it COMPILES,
/// DEPLOYS, AND RUNS. The live vaults on devnet and mainnet would then be read
/// with `threshold` taken from the first byte of what is physically signer[3],
/// `payout_mint` taken from the middle of the old treasury pin, and the
/// currency registry off by 64 bytes. Nothing would error; the vault would
/// simply mean something else.
///
/// The slots were therefore APPENDED as `signers_ext`, carved out of the
/// 64 reserved bytes at the tail. Every pre-existing offset is unchanged,
/// `size_of::<VaultState>()` is unchanged at 1507, and the account needs no
/// realloc and no migration instruction. `scripts/check-reserved.js` proved
/// those 64 bytes were ALL ZERO on both clusters before the claim, which is
/// what makes the read safe: on a vault that has not yet been rotated the two
/// new slots decode as `Pubkey::default()` — exactly the "empty slot"
/// sentinel `all_signers()` skips. The upgrade is therefore behaviour-neutral
/// on deploy; the signer set changes only when a human later runs the
/// rotation ceremony.
///
/// THE RESERVE IS NOW FULLY CONSUMED. A future field cannot be carved from
/// this account — it needs a PDA of its own, which is why the per-action
/// threshold table lives in `GovernanceConfig` and the mint cap counter in
/// `MintWindow` rather than here.
///
/// `paused` is u8 (0/1) rather than bool for Pod safety.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct VaultState {
    /// The first three multisig signer slots. Historically the WHOLE set;
    /// since v0.26 the set is `signers` ++ `signers_ext`, read through
    /// `all_signers()`. OFFSET 0 — never move, never widen (see above).
    pub signers: [Pubkey; 3],                          //   96  @0
    /// LEGACY global threshold, written once by `initialize`. Since v0.26 the
    /// authoritative numbers are PER-ACTION and live in `GovernanceConfig`;
    /// this field is retained only because moving it would shift every field
    /// below it. Nothing reads it for authorization.
    pub threshold: u8,                                 //    1  @96
    /// PDA bump.
    pub bump: u8,                                      //    1  @97
    /// Emergency pause flag. When 1, enter_contest and
    /// enter_contest_with_token return VaultPaused. Other ops remain
    /// available so operators can wind down in-flight state.
    /// u8 instead of bool for Pod safety (zero-copy compatibility).
    pub paused: u8,                                    //    1  @98
    /// Payout mint — pinned at `initialize`, immutable thereafter.
    /// All `settle_contest` / `cancel_contest` / `close_contest` flows
    /// constrain this. In a mainnet build, must equal EXPECTED_USDC_MINT.
    pub payout_mint: Pubkey,                           //   32  @99
    /// Squads vault PDA — pinned at `initialize`. `sweep_operator_revenue`
    /// enforces `treasury_ata.owner == treasury_authority`, and since v0.26
    /// `close_contest` pays reclaimed rent here rather than to its caller.
    pub treasury_authority: Pubkey,                    //   32  @131
    /// On-chain currency registry. Slot 0 holds the payout currency (USDC),
    /// slot 1 holds USDT, slots 2-15 are populated via `register_currency`.
    pub accepted_currencies: [AcceptedCurrency; 16],   // 1280  @163
    /// Signer slots 4 and 5 (v0.26). APPENDED into what was `_reserved`, so
    /// every offset above is untouched and the account size is unchanged.
    /// `Pubkey::default()` means the slot is EMPTY — which is how a vault
    /// deployed but not yet rotated reads, and why this upgrade changes no
    /// behaviour until the rotation ceremony runs.
    ///
    /// Slots are LEFT-PACKED: `update_signers` refuses a set with a gap, so
    /// "empty" can only ever be a suffix and `all_signers()` cannot silently
    /// skip a live key.
    pub signers_ext: [Pubkey; 2],                      //   64  @1443
    /// Reserve EXHAUSTED by `signers_ext` (v0.26). Kept at length zero so the
    /// next reader sees, in the layout itself, that there is nothing left to
    /// carve: a new field needs its own PDA.
    pub _reserved: [u8; 0],                            //    0  @1507
}

impl VaultState {
    /// Every signer slot the vault holds, in order, with EMPTY slots skipped.
    ///
    /// This is the ONLY place that knows the set is stored in two pieces.
    /// `signers` and `signers_ext` are never read directly for authorization
    /// anywhere else in the program — route new checks through here (or
    /// through `is_signer` / `authorize`, which both do) so a rotated 5-slot
    /// vault and a never-rotated 3-slot vault behave identically.
    pub fn all_signers(&self) -> impl Iterator<Item = &Pubkey> {
        self.signers
            .iter()
            .chain(self.signers_ext.iter())
            .filter(|k| **k != Pubkey::default())
    }

    /// How many signer slots are occupied (1..=MAX_SIGNERS).
    pub fn active_signer_count(&self) -> u8 {
        self.all_signers().count() as u8
    }

    /// Is `key` a member of the active signer set?
    ///
    /// The `Pubkey::default()` guard is not redundant with the filter in
    /// `all_signers`: it states the invariant at the point a caller could
    /// otherwise pass the zero key and match an empty slot if the filter were
    /// ever relaxed. The zero key is never a signer.
    pub fn is_signer(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.all_signers().any(|s| s == key)
    }

    /// Genuine N-of-M: `keys` must hold at least `required` DISTINCT members
    /// of the active signer set.
    ///
    /// This REPLACES the v0.16 `validate_multisig(s1, s2)`, which was
    /// `s1 != s2 && is_signer(s1) && is_signer(s2)` — structurally exactly two
    /// signatures, and it NEVER READ `self.threshold`. The threshold field was
    /// decorative for the program's entire life: a vault storing `threshold: 3`
    /// still authorized treasury operations on two signatures, and the docs
    /// said 2-of-3 because two was all the code could ever mean.
    ///
    /// Callers do not invoke this directly — they go through
    /// `instructions::governance::authorize`, which collects the signing keys
    /// and looks the per-action `required` up in `GovernanceConfig`.
    pub fn validate_threshold(&self, keys: &[Pubkey], required: u8) -> Result<()> {
        require!(required >= 1, VaultError::GovernanceThresholdInvalid);

        let mut distinct = 0u8;
        let mut seen: [Pubkey; MAX_SIGNERS] = [Pubkey::default(); MAX_SIGNERS];

        for key in keys.iter() {
            require!(self.is_signer(key), VaultError::Unauthorized);
            // Reject a repeat of a key already counted — N signatures from one
            // keypair is one signature. `seen` is bounded by MAX_SIGNERS
            // because a distinct member of the set cannot exceed it.
            require!(
                !seen[..distinct as usize].contains(key),
                VaultError::DuplicateSigner
            );
            require!((distinct as usize) < MAX_SIGNERS, VaultError::DuplicateSigner);
            seen[distinct as usize] = *key;
            distinct += 1;
        }

        require!(distinct >= required, VaultError::InsufficientSigners);
        Ok(())
    }
}

/// One per user wallet. Holds on-chain stat counters (entries / wins /
/// cashes / total_won) plus the loyalty seeds counter and the user's
/// chosen display name. v0.16 dropped the custodial balance / deposit /
/// withdraw / daily-cap fields — funds now live in user ATAs.
///
/// PDA seeds: [b"user", wallet.as_ref()]
#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    /// Owner wallet.
    pub wallet: Pubkey,           // 32
    /// On-chain master copy of the user's display name. UTF-8 zero-padded.
    pub username: [u8; 32],       // 32
    /// Loyalty points awarded per entry from the contest's Season schedule.
    /// Rails derives "level" client-side from this value.
    pub seeds: u64,               //  8
    /// Lifetime contests entered. Increments on every successful entry.
    pub entries: u32,             //  4
    /// Lifetime 1st-place finishes (rank == 1 in settle_contest).
    pub wins: u32,                //  4
    /// Lifetime any-payout finishes (payout > 0 in settle_contest).
    pub cashes: u32,              //  4
    /// Lifetime USDC payouts received. Increments by `payout` on settle.
    pub total_won: u64,           //  8
    /// PDA bump.
    pub bump: u8,                 //  1
    /// 1 once this account's `username` is locked by a `UsernameRecord`.
    ///
    /// ── WHY A FLAG, AND WHY IT COSTS NO BYTES ─────────────────────────────
    ///
    /// A rename must CLOSE the record for the old name, or a user simply keeps
    /// it: claim "alice", rename to "bob" while omitting the old record from
    /// the account list, and now hold both — at about 0.0015 SOL a name, which
    /// is not a deterrent. The old record is therefore a required account on
    /// the rename path. But a program cannot prove an account was OMITTED
    /// rather than absent, so "the user has no record yet" had to become a fact
    /// stored on chain rather than a claim made by the caller.
    ///
    /// It is carved from the FIRST BYTE of `_reserved`, which drops to 31. For
    /// a Borsh `#[account]` what matters is field ORDER and total size, and
    /// both are unchanged: `INIT_SPACE` stays 125 and every live account
    /// deserializes exactly as before. Appending after `_reserved` would have
    /// grown the account by one byte and made every existing one too small to
    /// load — the mistake `VaultState`'s layout test exists to catch, in the
    /// one place the reserve was still there to spend.
    ///
    /// Reads 0 on all 47 production accounts (created at v0.16+, which zeroes
    /// the reserve). And if it somehow read 1 on an account with no record, the
    /// failure is a REFUSED RENAME pointing at `backfill_username_record`, not
    /// a lost name — the flag fails closed.
    pub username_registered: u8,  //  1
    /// Reserved padding for forward-compat (referral, kyc tier, etc.).
    pub _reserved: [u8; 31],      // 31
}

/// Lifecycle of a Contest.
///   Open      — accepting entries (locking is now DERIVED from
///               `lock_timestamp` vs chain time, not this status — see
///               set_contest_lock_time + the enter_contest time gate)
///   Locked    — vestigial (v0.17 retired lock_contest/unlock_contest); kept
///               for enum-discriminant stability. No instruction sets it.
///   Settled   — graded, payouts disbursed
///   Cancelled — refunded to creator, no further state transitions allowed
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ContestStatus {
    Open,
    Locked,
    Settled,
    Cancelled,
}

/// One per contest. Holds the per-currency entry-fee schedule, accumulated
/// per-currency fee tallies (operator revenue, separate from prize pool),
/// payout tiers, status, season binding, and the creator/admin pubkeys.
///
/// PDA seeds: [b"contest", contest_id]  (contest_id = SHA256 of Rails slug)
#[account]
#[derive(InitSpace)]
pub struct Contest {
    /// SHA256(Rails slug). Stable, opaque, 32 bytes.
    pub contest_id: [u8; 32],
    /// Payer pubkey from create_contest (admin bot, pays SOL rent).
    pub admin: Pubkey,
    /// Creator pubkey (signs the prize_pool USDC transfer from their ATA).
    pub creator: Pubkey,
    /// Season this contest is bound to (OPSEC-023). Pins the seed schedule.
    pub season_id: u32,
    /// USDC prize pool — pre-funded by creator at create time. Immutable.
    pub prize_pool: u64,
    /// Per-currency entry-fee schedule. `entry_fee_by_currency[i] = 0`
    /// means currency `i` is NOT accepted for this contest.
    pub entry_fee_by_currency: [u64; MAX_CURRENCIES],
    /// Per-currency collected fees (operator revenue). Increments by the
    /// fee on every paid entry of currency `i`.
    pub entry_fees: [u64; MAX_CURRENCIES],
    /// Maximum number of entries this contest accepts.
    pub max_entries: u32,
    /// Number of entries currently in the contest.
    pub current_entries: u32,
    /// Current lifecycle state.
    pub status: ContestStatus,
    /// USDC paid per rank, 6-decimal. Must sum to `prize_pool`. Max 10 ranks.
    #[max_len(10)]
    pub payout_amounts: Vec<u64>,
    /// PDA bump.
    pub bump: u8,
    /// Derived time-lock (Unix seconds, chain Clock). `now >= lock_timestamp`
    /// ⇒ contest locked (no new entries). `0` = no lock scheduled (enterable
    /// until a lock time is set). Carved out of the former `[u8; 32]`
    /// `_reserved` padding (i64 = 8 bytes, `_reserved` 32 → 24) so total
    /// `INIT_SPACE` is UNCHANGED — existing Contest PDAs need no re-init:
    /// their zeroed reserved bytes decode as `lock_timestamp == 0`.
    pub lock_timestamp: i64,
    /// Derived conclusion marker (Unix seconds, chain Clock). `now >=
    /// conclusion_timestamp` ⇒ the contest has concluded: its lock time can no
    /// longer change (`set_contest_lock_time` rejects). `0` = no conclusion
    /// scheduled. Carved out of `_reserved` (32 → 24 → 16) so total
    /// `INIT_SPACE` stays UNCHANGED — v0.17 Contest PDAs need no re-init
    /// (their zeroed bytes decode as `conclusion_timestamp == 0`).
    pub conclusion_timestamp: i64,
    /// Reserved padding for forward-compat.
    pub _reserved: [u8; 16],
}

/// Status of a single contest entry. Settle transitions Active → Won/Lost.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EntryStatus {
    Active,
    Won,
    Lost,
}

/// One per (contest, wallet, entry_num). A user can have multiple entries
/// per contest (Rails caps at 3); each gets its own PDA.
///
/// PDA seeds: [b"entry", contest_id, wallet.as_ref(), entry_num.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct ContestEntry {
    pub contest_id: [u8; 32],     // 32
    pub wallet: Pubkey,           // 32
    pub entry_num: u32,           //  4
    pub status: EntryStatus,      //  1
    pub rank: u32,                //  4
    pub payout: u64,              //  8
    /// Index into `vault_state.accepted_currencies` of the currency this
    /// entry was paid in. `u8::MAX` is the sentinel for token-funded entries
    /// (no SPL transfer occurred).
    pub currency_idx: u8,         //  1
    pub bump: u8,                 //  1
    pub _reserved: [u8; 16],      // 16
}

/// Source enum for an EntryTokenAccount — how the user obtained the token.
pub mod entry_token_source {
    pub const OPERATOR: u8 = 0;
    pub const STRIPE: u8 = 1;
    pub const MOONPAY: u8 = 2;

    /// High bit of `EntryTokenAccount.source`, set by `burn_entry_token` to
    /// tombstone a voucher an operator has clawed back.
    ///
    /// It lives in the SPARE BIT of an existing field rather than in a field of
    /// its own because `EntryTokenAccount::LEN` (124) is fully packed: growing
    /// the struct would break `Account<EntryTokenAccount>` deserialization for
    /// every token already minted on chain, and with it
    /// `enter_contest_with_token` for those holders. The provenance values above
    /// occupy 0..=2 here and 0..=5 in Rails (ENTRY_TOKEN_SOURCE also carries
    /// paypal/coinflow/aeropay), and `mint_entry_token` assigns `source` raw with
    /// no range check — so bit 7 is free and staying free.
    ///
    /// A burn sets this AND `consumed`. `consumed` is what blocks the spend;
    /// this flag is what tells a burn apart from a genuine redemption, which
    /// matters both for the audit trail and for any UI that would otherwise
    /// label a clawed-back token "used".
    pub const BURNED_FLAG: u8 = 0b1000_0000;

    /// Mask for the provenance half of `source`. Any reader that wants
    /// OPERATOR/STRIPE/... must apply this, because a burned token carries
    /// `BURNED_FLAG` in the same byte.
    pub const SOURCE_MASK: u8 = 0b0111_1111;
}

/// EntryTokenAccount: a pre-purchased contest entry token issued by the admin.
/// User redeems one of these to enter a contest without paying the entry fee at entry time.
///
/// PDA seeds (v0.19, audit #9): [b"entry_token", sha256(source_ref)]. Derived
/// from the external reference's hash so re-minting the same `source_ref`
/// collides on init (true idempotency); replaces the old caller-supplied
/// `sequence`. `source_ref` must be globally unique across wallets.
/// Discovery: getProgramAccounts filter by `owner` (still in the account body).
#[account]
pub struct EntryTokenAccount {
    pub owner: Pubkey,            // user wallet
    pub source: u8,               // entry_token_source::{OPERATOR, STRIPE, MOONPAY}
    pub source_ref: [u8; 64],     // truncated/padded external reference (e.g. Stripe session id)
    pub consumed: bool,
    pub consumed_at: Option<i64>, // unix timestamp when consumed
    pub created_at: i64,          // unix timestamp at mint
    pub bump: u8,
}

impl EntryTokenAccount {
    /// Layout (after 8-byte Anchor discriminator):
    ///   owner:        Pubkey      32
    ///   source:       u8           1
    ///   source_ref:   [u8; 64]    64
    ///   consumed:     bool         1
    ///   consumed_at:  Option<i64>  1 + 8 = 9 (tag + payload; payload always present in space calc)
    ///   created_at:   i64          8
    ///   bump:         u8           1
    /// Subtotal data: 116
    /// + 8 discriminator = 124
    pub const LEN: usize = 8 + 32 + 1 + 64 + 1 + (1 + 8) + 8 + 1;
}

/// Season: a contest season with a per-entry seed-award schedule.
/// The schedule is set at season creation and is immutable thereafter.
/// Entries award `seed_schedule[entry_num.min(4) as usize]` — entries 5+
/// clamp to slot 4.
///
/// PDA seeds: [b"season", season_id.to_le_bytes()] (u32 LE, 4 bytes).
#[account]
pub struct Season {
    pub season_id: u32,
    pub name: [u8; 32],          // UTF-8 padded with 0x00
    pub seed_schedule: [u64; 5], // entries 0-4; entry index 5+ clamps to slot 4
    pub quest_seeds: [u64; 16],  // v0.23: reward per seed_grant_kind (0 username, 1 newsletter, 2 invite, 3 chat, 4-15 future)
    pub start_at: i64,           // unix timestamp
    pub created_at: i64,         // unix timestamp
    pub bump: u8,
}

impl Season {
    /// Layout (after 8-byte Anchor discriminator):
    ///   season_id:      u32          4
    ///   name:           [u8; 32]    32
    ///   seed_schedule:  [u64; 5]    40
    ///   quest_seeds:    [u64; 16]  128   (v0.23 — reward per seed_grant_kind)
    ///   start_at:       i64          8
    ///   created_at:     i64          8
    ///   bump:           u8           1
    /// Subtotal data: 221
    /// + 8 discriminator = 229
    pub const LEN: usize = 8 + 4 + 32 + 40 + 128 + 8 + 8 + 1;
}

/// Discriminator for a standalone seed grant (quest bonus). Part of the
/// SeedGrant idempotency-guard PDA seed.
pub mod seed_grant_kind {
    /// One-time bonus for a user's FIRST manual username change.
    pub const USERNAME_FIRST_CHANGE: u8 = 0;
    /// One-time bonus for joining the email newsletter.
    pub const NEWSLETTER_JOIN: u8 = 1;
    /// Per-invitee bonus when an invited friend enters a contest.
    pub const INVITE_FRIEND: u8 = 2;
    /// One-time bonus for a user's FIRST contest-chat message (v0.23).
    pub const CHAT_MESSAGE: u8 = 3;
    /// Upper bound for grant_seeds kind validation (v0.23). Flexible so new
    /// quests (kinds 4..=15) need only a Rails constant — never a redeploy.
    /// Each kind also indexes Season.quest_seeds for its on-chain reward amount.
    pub const MAX_SEED_GRANT_KIND: u8 = 15;
}

/// Upper bound on a single `grant_seeds` amount. The largest quest reward is
/// 45 (invite); 1000 leaves headroom for future quests while capping a leaked
/// 1-of-3 key's per-call blast radius.
pub const MAX_GRANT_SEEDS: u64 = 1_000;

/// SeedGrant: a once-only guard + audit record for a standalone admin seed
/// grant (quest bonus). Its EXISTENCE is the idempotency lock — `init` collides
/// on a repeat grant of the same (user, kind[, invitee]), so the TX fails.
///
/// PDA seeds: [b"seed_grant", user_wallet, kind, invitee]
///   - USERNAME_FIRST_CHANGE / NEWSLETTER_JOIN: invitee = Pubkey::default()
///     → once-EVER per user.
///   - INVITE_FRIEND: invitee = the friend's wallet → once-per-invitee.
#[account]
#[derive(InitSpace)]
pub struct SeedGrant {
    /// Recipient wallet (the UserAccount whose seeds were credited).
    pub user: Pubkey,         // 32
    /// seed_grant_kind::{USERNAME_FIRST_CHANGE, NEWSLETTER_JOIN, INVITE_FRIEND}.
    pub kind: u8,             //  1
    /// The invited friend's wallet for INVITE_FRIEND; Pubkey::default() otherwise.
    pub invitee: Pubkey,      // 32
    /// Seeds credited by this grant.
    pub amount: u64,          //  8
    /// Unix timestamp (chain Clock) at grant time.
    pub granted_at: i64,      //  8
    /// PDA bump.
    pub bump: u8,             //  1
    /// Reserved padding for forward-compat.
    pub _reserved: [u8; 16],  // 16
}

// ──────────────────────────────────────────────────────────────────────────
// Governance — per-action thresholds, stored as DATA
// ──────────────────────────────────────────────────────────────────────────

/// Governance action ids. These index `GovernanceConfig.thresholds`, so the
/// numbers are PERMANENT: changing one silently re-points a stored threshold
/// at a different action. Append new actions at the end and never renumber —
/// the same discipline `errors.rs` keeps, and for the same reason.
pub mod gov_action {
    pub const SETTLE_CONTEST: u8 = 0;
    pub const CANCEL_CONTEST: u8 = 1;
    pub const SWEEP_OPERATOR_REVENUE: u8 = 2;
    pub const REGISTER_CURRENCY: u8 = 3;
    pub const DEACTIVATE_CURRENCY: u8 = 4;
    pub const PAUSE: u8 = 5;
    pub const UNPAUSE: u8 = 6;
    pub const UPDATE_SIGNERS: u8 = 7;
    pub const CREATE_SEASON: u8 = 8;
    pub const CLOSE_CONTEST: u8 = 9;
    pub const SET_CONTEST_LOCK_TIME: u8 = 10;
    pub const SET_CONTEST_CONCLUSION_TIME: u8 = 11;
    /// A mint that stays WITHIN the current window's cap.
    pub const MINT_ENTRY_TOKEN: u8 = 12;
    /// A mint that would take the current window ABOVE its cap.
    pub const MINT_ENTRY_TOKEN_OVER_CAP: u8 = 13;
    pub const BURN_ENTRY_TOKEN: u8 = 14;
    pub const GRANT_SEEDS: u8 = 15;
    /// Retuning the table itself, and the mint-window policy.
    pub const SET_GOVERNANCE: u8 = 16;
    /// RETIRED in the username-registry change: both instructions that read
    /// this id (`admin_create_user_account`, `admin_set_username`) were
    /// DELETED. The id itself can never be reused — it indexes a stored
    /// threshold table, and re-pointing it at a new action would silently
    /// hand that action whatever number a live account happens to hold here.
    /// It stays declared, at its shipped default, exactly like the retired
    /// error codes in `errors.rs`.
    pub const ADMIN_USERNAME: u8 = 17;
    /// Creating a contest (the vault-signer half; the creator signs too).
    pub const CREATE_CONTEST: u8 = 18;
    /// Facilitating a user entry (the vault-signer half; the player signs too).
    pub const ENTER_CONTEST: u8 = 19;
    /// RE-OPENING an entry window whose lock has already PASSED. Escalated
    /// above the ordinary reschedule because it is the results-known
    /// late-entry vector: by the time a lock has engaged, outcomes may be
    /// knowable, and moving the lock forward lets an entry in against them.
    pub const SET_CONTEST_LOCK_TIME_REOPEN: u8 = 20;
    /// AMENDING an already-set conclusion. Same vector one step back: the
    /// conclusion is what makes a lock final, so clearing or postponing it
    /// re-arms the re-open above.
    pub const SET_CONTEST_CONCLUSION_TIME_AMEND: u8 = 21;

    // ── The username registry ─────────────────────────────────────────────
    /// Rename any user WITHOUT that user's consent. The consent requirement is
    /// what made the old `admin_set_username` useless against the two cases it
    /// was wanted for — a squatter and a slur — because both are held by
    /// someone with no reason to co-sign their own eviction. Removing consent
    /// is safe only because the number is high enough that no agent can reach
    /// it alone, which is why this one carries a FLOOR (see `THRESHOLD_FLOORS`).
    pub const OVERWRITE_USERNAME: u8 = 22;
    /// The vault claims a free name for itself — "add to the blocked list".
    pub const RESERVE_USERNAME: u8 = 23;
    /// The vault gives a name it holds back to the pool — "lift a block".
    pub const RELEASE_USERNAME: u8 = 24;

    /// One past the highest live action id.
    pub const COUNT: usize = 25;
}

/// Stored width of the threshold table. Wider than `gov_action::COUNT` so new
/// actions can be added by a program upgrade without resizing the account.
pub const GOV_TABLE_LEN: usize = 32;

/// The thresholds this program ships with, indexed by `gov_action`.
///
/// These are DEFAULTS, not constants in the authorization path — the stored
/// table wins wherever it is non-zero. Shipping a default for every action is
/// what lets `threshold_for` treat a zero as "unset" and fall back rather than
/// authorize on zero signatures.
///
/// Decided by Mr. McRitchie 2026-09-14/15. The design intent, in one line:
/// anything that MOVES MONEY or CHANGES WHO GOVERNS needs three; the brake
/// needs fewer signatures than the attack; and nothing that an agent can reach
/// on its own may lift a brake the agent's own capture would have triggered.
pub const DEFAULT_THRESHOLDS: [u8; GOV_TABLE_LEN] = {
    let mut t = [1u8; GOV_TABLE_LEN];
    t[gov_action::SETTLE_CONTEST as usize] = 3;
    t[gov_action::CANCEL_CONTEST as usize] = 3;
    t[gov_action::SWEEP_OPERATOR_REVENUE as usize] = 3;
    t[gov_action::REGISTER_CURRENCY as usize] = 3;
    t[gov_action::DEACTIVATE_CURRENCY as usize] = 3;
    // A brake must be EASIER to pull than the attack it stops. Two, not one:
    // the agent can still stop the platform, but a single leaked key cannot
    // grief the business by halting entries at will.
    t[gov_action::PAUSE as usize] = 2;
    // ...and three to release it. An agent must never be able to lift its own
    // brake, which is the whole asymmetry.
    t[gov_action::UNPAUSE as usize] = 3;
    t[gov_action::UPDATE_SIGNERS as usize] = 3;
    t[gov_action::CREATE_SEASON as usize] = 3;
    t[gov_action::CLOSE_CONTEST as usize] = 2;
    t[gov_action::SET_CONTEST_LOCK_TIME as usize] = 2;
    t[gov_action::SET_CONTEST_CONCLUSION_TIME as usize] = 2;
    t[gov_action::MINT_ENTRY_TOKEN as usize] = 1;
    t[gov_action::MINT_ENTRY_TOKEN_OVER_CAP as usize] = 3;
    // burn_entry_token destroys user property, the holder never signs, and
    // pause does not stop it. It is WRITTEN BUT NEVER DEPLOYED, so shipping it
    // at three regresses nothing — and three is the reversible choice, since
    // lowering it later is one transaction and un-burning a voucher is not.
    t[gov_action::BURN_ENTRY_TOKEN as usize] = 3;
    t[gov_action::GRANT_SEEDS as usize] = 1;
    t[gov_action::SET_GOVERNANCE as usize] = 3;
    t[gov_action::ADMIN_USERNAME as usize] = 1;
    t[gov_action::CREATE_CONTEST as usize] = 1;
    t[gov_action::ENTER_CONTEST as usize] = 1;
    // The two ESCALATED branches. Their base actions sit at two on Mr.
    // McRitchie's own call; these are the results-known paths the v0.19 audit
    // (#5) already escalated, carried forward and raised from two to three.
    // Raising them is the reversible direction — if three proves to cost real
    // operational time, `set_action_threshold` puts it back at two in one
    // transaction, whereas a contest graded against a re-opened window cannot
    // be un-graded.
    t[gov_action::SET_CONTEST_LOCK_TIME_REOPEN as usize] = 3;
    t[gov_action::SET_CONTEST_CONCLUSION_TIME_AMEND as usize] = 3;
    // The username registry. All three are three, and all three are FLOORED at
    // three — which is unusual enough to state the reason rather than leave it
    // to be inferred. See `THRESHOLD_FLOORS` below: a `GovernanceConfig`
    // bootstrapped by the PREVIOUS binary already stores a literal `1` at these
    // indices, so a default alone would never be read.
    t[gov_action::OVERWRITE_USERNAME as usize] = 3;
    t[gov_action::RESERVE_USERNAME as usize] = 3;
    t[gov_action::RELEASE_USERNAME as usize] = 3;
    t
};

/// Immovable floors. `set_action_threshold` refuses to store a value below
/// these, and `threshold_for` raises a stored value up to them on READ — so a
/// floor holds even against a table written by some future path that forgot to
/// check, and against a corrupted or partially-written account.
///
/// WHY FLOORS EXIST AT ALL. Without one, three signatures could lower
/// `update_signers` to two, and the next day the two agent-reachable keys
/// rotate the operator out of his own vault — the precise attack this whole
/// change exists to close, reintroduced through the retuning mechanism. The
/// same argument covers `unpause` (an agent must not be able to lower the bar
/// for lifting its own brake) and `set_governance` itself (or the floor could
/// be lowered by lowering the thing that guards the floors).
pub const THRESHOLD_FLOORS: [u8; GOV_TABLE_LEN] = {
    let mut f = [1u8; GOV_TABLE_LEN];
    f[gov_action::UPDATE_SIGNERS as usize] = 3;
    f[gov_action::UNPAUSE as usize] = 3;
    f[gov_action::SET_GOVERNANCE as usize] = 3;

    // ── THE USERNAME REGISTRY, AND WHY ALL THREE ARE FLOORED ──────────────
    //
    // THE MIGRATION HAZARD FIRST, because it is the reason a DEFAULT would not
    // have been enough. `DEFAULT_THRESHOLDS` starts life as `[1u8; 32]` and
    // then overwrites the ids it knows about, so a table written by a binary
    // that predates these three actions stores a literal `1` at 22, 23 and 24
    // — not a zero. `threshold_for` treats zero as "unset" and falls back to
    // the shipped default; it has no way to treat a ONE as unset, and must
    // not, because one is a legitimate retune. So on a `GovernanceConfig`
    // bootstrapped by the sibling governance binary, the defaults above are
    // simply never read, and these actions would authorize on ONE signature.
    //
    // The floor is applied on READ, which makes it the only mechanism here
    // that cannot be forgotten: no post-upgrade `set_action_threshold` call, no
    // runbook step, nothing an operator has to remember at 2am.
    //
    // AND THE FLOOR IS RIGHT ON ITS OWN MERITS, per action:
    //
    //   OVERWRITE_USERNAME — it renames a user who does not sign. Consent was
    //     removed precisely because three signatures replace it; a quorum able
    //     to retune this to one would be handing a single agent-reachable key
    //     the power to rename anybody on the platform.
    //
    //   RELEASE_USERNAME — a reservation is a BRAKE on a name, and this
    //     program's stated asymmetry is that nothing an agent reaches alone may
    //     lift a brake (see `PAUSE`/`UNPAUSE` above). Releasing "slur" back
    //     into the pool is exactly that lift.
    //
    //   RESERVE_USERNAME — the brake side, and the one where a lower number
    //     would be defensible on its own: blocking a slur fast is a good thing
    //     to be able to do cheaply. It is floored anyway, because the migration
    //     hazard above applies to it identically and a stored `1` here is
    //     indistinguishable from a deliberate retune to one. Lowering it is a
    //     one-line change to this table plus a program upgrade — deliberately
    //     the same cost as any other floor, and flagged as Mr. McRitchie's call.
    f[gov_action::OVERWRITE_USERNAME as usize] = 3;
    f[gov_action::RESERVE_USERNAME as usize] = 3;
    f[gov_action::RELEASE_USERNAME as usize] = 3;
    f
};

/// Default mint-cap window: one day.
pub const DEFAULT_MINT_WINDOW_SECONDS: i64 = 86_400;

/// Default number of entry tokens mintable in one window at the low threshold.
/// Above it the mint still succeeds, but demands `MINT_ENTRY_TOKEN_OVER_CAP`
/// signatures — the cap raises the BAR, it does not close the door.
pub const DEFAULT_MINT_WINDOW_CAP: u32 = 250;

/// Per-action governance thresholds + the mint-window policy.
///
/// PDA seeds: [b"governance"]
///
/// ── WHY THIS IS AN ACCOUNT AND NOT A `const` ──────────────────────────────
///
/// Every number in here was a judgment call made in one evening, and a
/// judgment call baked into a `const` can only be revised by a program
/// upgrade — which for this program means assembling the Squads 2-of-3 vault,
/// rebuilding, re-pinning the IDL hash and a devnet rehearsal. That cost is
/// what turns "is three the right number for settle?" into a question worth
/// stalling on. Stored as data, it is one transaction, so the safe default is
/// always the cheap choice and no number here is a one-way door.
///
/// ── WHY IT IS A SEPARATE PDA AND NOT A FIELD ON `VaultState` ──────────────
///
/// It could not be a field. `VaultState`'s 64 reserved bytes were consumed
/// EXACTLY by `signers_ext`, and growing a `zero_copy` singleton means a
/// realloc plus a migration instruction. A fresh PDA costs one rent-exempt
/// account and no migration.
///
/// Borsh (`#[account]`), not zero-copy: at ~117 bytes it is nowhere near the
/// BPF stack limit that forced `VaultState` zero-copy.
#[account]
pub struct GovernanceConfig {
    /// Required signature count per `gov_action`. A ZERO means "never set" and
    /// reads back as `DEFAULT_THRESHOLDS` — see `threshold_for`.
    pub thresholds: [u8; GOV_TABLE_LEN],   // 32
    /// Length of a mint-cap window in seconds.
    pub mint_window_seconds: i64,          //  8
    /// Entry tokens mintable per window before the threshold escalates.
    pub mint_window_cap: u32,              //  4
    /// PDA bump.
    pub bump: u8,                          //  1
    /// Reserved padding for forward-compat. Unlike `VaultState`'s, this one is
    /// real headroom — this account can also simply be reallocated.
    pub _reserved: [u8; 64],               // 64
}

impl GovernanceConfig {
    /// 8 discriminator + 32 + 8 + 4 + 1 + 64.
    pub const LEN: usize = 8 + GOV_TABLE_LEN + 8 + 4 + 1 + 64;

    /// Required signatures for `action`.
    ///
    /// THREE PROPERTIES, AND EACH ONE IS LOAD-BEARING:
    ///   1. An UNSET (zero) entry falls back to the shipped default. A zeroed
    ///      or partially-written table must never read as "zero signatures
    ///      required" — that would turn a corrupt account into an open vault.
    ///   2. The floor is applied on READ, not only on write, so a floor holds
    ///      even against a value some future write path stored without
    ///      checking.
    ///   3. An out-of-range action id reads as its default rather than
    ///      indexing past the table.
    pub fn threshold_for(&self, action: u8) -> u8 {
        let idx = action as usize;
        let stored = if idx < GOV_TABLE_LEN { self.thresholds[idx] } else { 0 };
        let defaulted = if stored == 0 { Self::default_for(action) } else { stored };
        let floor = Self::floor_for(action);
        if defaulted < floor {
            floor
        } else {
            defaulted
        }
    }

    pub fn default_for(action: u8) -> u8 {
        let idx = action as usize;
        if idx < GOV_TABLE_LEN {
            DEFAULT_THRESHOLDS[idx]
        } else {
            1
        }
    }

    pub fn floor_for(action: u8) -> u8 {
        let idx = action as usize;
        if idx < GOV_TABLE_LEN {
            THRESHOLD_FLOORS[idx]
        } else {
            1
        }
    }

    /// The largest threshold any live action requires.
    ///
    /// `update_signers` checks the incoming set against this so a rotation can
    /// never leave the vault with fewer keys than some action needs — which
    /// would brick that action with no way back except another rotation.
    pub fn max_live_threshold(&self) -> u8 {
        let mut max = 1u8;
        let mut action = 0u8;
        while (action as usize) < gov_action::COUNT {
            let t = self.threshold_for(action);
            if t > max {
                max = t;
            }
            action += 1;
        }
        max
    }

    /// Which window a timestamp falls in. `mint_window_seconds` is validated
    /// positive on write, and defended again here so a zero can never divide.
    pub fn window_index_for(&self, unix_timestamp: i64) -> Result<i64> {
        require!(
            self.mint_window_seconds > 0,
            VaultError::InvalidMintWindowPolicy
        );
        Ok(unix_timestamp.div_euclid(self.mint_window_seconds))
    }
}

/// Per-window mint counter for `mint_entry_token`.
///
/// PDA seeds: [b"mint_window", window_index.to_le_bytes()]
///
/// Uncapped value creation was the worst of the three earlier findings: a
/// single 1-of-N signature could mint unlimited free entries, each one a claim
/// on a real prize pool. This account is what makes the cap observable on
/// chain rather than a Rails-side convention a captured Rails would not honour.
///
/// One account per window, created on that window's first mint via
/// `init_if_needed`. Nothing closes a `MintWindow`, so the counter cannot be
/// reset by closing and re-initialising it.
#[account]
pub struct MintWindow {
    /// `unix_timestamp.div_euclid(mint_window_seconds)` — also the PDA seed,
    /// stored so the account is self-describing to an off-chain reader.
    pub window_index: i64,    //  8
    /// Entry tokens minted in this window.
    pub minted: u32,          //  4
    /// PDA bump.
    pub bump: u8,             //  1
    /// Reserved padding for forward-compat.
    pub _reserved: [u8; 16],  // 16
}

impl MintWindow {
    /// 8 discriminator + 8 + 4 + 1 + 16.
    pub const LEN: usize = 8 + 8 + 4 + 1 + 16;
}

// ──────────────────────────────────────────────────────────────────────────
// The username registry
// ──────────────────────────────────────────────────────────────────────────

/// One account per claimed name. Its EXISTENCE is the lock, and its `owner`
/// says who holds it.
///
/// PDA seeds: `[b"username", canonical_username_key(name)]`
///
/// ── THE WHOLE MECHANISM, IN THREE STATES ──────────────────────────────────
///
///   absent                 the name is free
///   owner == some wallet   that player holds it
///   owner == the vault PDA the name is RESERVED — nobody can take it
///
/// Uniqueness and the blocked list are therefore ONE mechanism rather than
/// two. Blocking a name is the vault claiming it first; lifting a block is
/// closing the account. There is no list to walk, nothing to resize, and
/// growth is unbounded because each name pays its own rent.
///
/// ── IT IS AN EXISTING TECHNIQUE, NOT A NEW ONE ────────────────────────────
///
/// `mint_entry_token` keys its voucher PDA on `sha256(source_ref)` and
/// `grant_seeds` guards on `[b"seed_grant", ...]`; both use init-as-a-lock for
/// idempotency, and both have been in this program since v0.19. This applies
/// the same trick to names.
///
/// ── WHY THE VAULT PDA AND NOT A SENTINEL ──────────────────────────────────
///
/// `owner` is the vault's own `[b"vault"]` PDA for a reservation. An off-chain
/// reader needs no side table: derive `[b"vault"]` once and the owner field
/// answers "taken or reserved?" by itself.
///
/// WHAT KEEPS A PLAYER RECORD OFF THAT VALUE, precisely — the earlier wording
/// here said the address is off-curve so no keypair can produce it, and left
/// the reader to conclude that a player record therefore cannot collide with
/// it. Off-curve settles only the paths that take their owner from a `Signer`
/// (`set_username`) or from a chain-asserted field (`overwrite_username`,
/// `backfill_username_record`). `create_user_account` takes its owner as an
/// ARGUMENT, because neither onboarding path has the wallet's signature to
/// offer, so on that path the curve guarantees nothing and an explicit refusal
/// does the work: `require_not_vault_pda`, `VaultPdaNotAWallet` (6067).
///
/// `Pubkey::default()` is NOT a reservation sentinel, but `is_reserved` treats
/// it as one anyway — see that method.
#[account]
#[derive(InitSpace)]
pub struct UsernameRecord {
    /// Holder: a wallet for a player-held name, the `[b"vault"]` PDA for a
    /// reservation. Never `Pubkey::default()` on any account this program
    /// writes — which is what lets `init_if_needed` callers tell a
    /// freshly-created record from one that already existed.
    pub owner: Pubkey,        // 32
    /// The canonical (lowercased, zero-padded) name — the same 32 bytes that
    /// seed this PDA. Stored so the account is self-describing to an
    /// off-chain reader and so a caller naming the wrong record fails a field
    /// check rather than acting on it.
    pub name: [u8; 32],       // 32
    /// Chain time the record was created.
    pub claimed_at: i64,      //  8
    /// PDA bump.
    pub bump: u8,             //  1
    /// Reserved padding for forward-compat.
    pub _reserved: [u8; 16],  // 16
}

impl UsernameRecord {
    /// 8 discriminator + 32 + 32 + 8 + 1 + 16 = 97 bytes.
    pub const LEN: usize = 8 + UsernameRecord::INIT_SPACE;

    /// True when NO WALLET can act on this record.
    ///
    /// Two cases, and the second is the defensive one:
    ///   - the vault holds it (a real reservation), or
    ///   - `owner` is unset, which no write path in this program produces. A
    ///     zeroed or partially-written record must read as UNCLAIMABLE rather
    ///     than fall open to whoever asks first, so the unreachable case is
    ///     folded in here deliberately rather than left to chance.
    ///
    /// `release_reserved_username` deliberately does NOT use this — it demands
    /// an exact match on the vault key, so the release path can never be
    /// pointed at a record the vault does not actually hold.
    pub fn is_reserved(&self, vault: &Pubkey) -> bool {
        self.owner == *vault || self.owner == Pubkey::default()
    }

    /// True when `wallet` is the player holding this name.
    pub fn is_held_by(&self, wallet: &Pubkey) -> bool {
        *wallet != Pubkey::default() && self.owner == *wallet
    }
}
