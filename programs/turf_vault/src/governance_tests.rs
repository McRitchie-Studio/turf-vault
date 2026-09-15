//! Host-target unit tests for the v0.26 governance surface.
//!
//! WHY THESE ARE RUST UNIT TESTS AND NOT ONLY ANCHOR TESTS. The properties
//! below are properties of a MEMORY LAYOUT and of three pure functions. An
//! integration test against a validator can only observe them indirectly —
//! it would notice a shifted field as a wrong payout mint several steps later,
//! if at all, and a threshold table that silently reads zero as "no signatures
//! required" would show up as a test that PASSES. Asserting the layout
//! directly is the only way to make the failure land on the line that caused
//! it.
//!
//! The layout block in particular is a REGRESSION GUARD ON A CLASS OF EDIT,
//! not on a bug that happened: it fails the instant someone widens a field in
//! place rather than appending, which is the one mistake that would silently
//! misread every live vault on devnet and mainnet.

use anchor_lang::prelude::*;
use std::mem::{offset_of, size_of};

use crate::errors::VaultError;
use crate::state::{
    gov_action, AcceptedCurrency, GovernanceConfig, VaultState, DEFAULT_MINT_WINDOW_CAP,
    DEFAULT_MINT_WINDOW_SECONDS, GOV_TABLE_LEN, MAX_SIGNERS,
};

fn pk(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn empty_currency() -> AcceptedCurrency {
    AcceptedCurrency {
        mint: Pubkey::default(),
        op_rev_ata: Pubkey::default(),
        kind: 0,
        active: 0,
        _pad: [0; 14],
    }
}

/// A vault shaped like the ones LIVE on devnet and mainnet right now: three
/// signers, and the two appended slots still reading as zero because no
/// rotation has happened yet.
fn unrotated_vault() -> VaultState {
    VaultState {
        signers: [pk(1), pk(2), pk(3)],
        threshold: 2,
        bump: 254,
        paused: 0,
        payout_mint: pk(10),
        treasury_authority: pk(11),
        accepted_currencies: [empty_currency(); 16],
        signers_ext: [Pubkey::default(); 2],
        _reserved: [],
    }
}

/// The same vault after the full two-step rotation ceremony.
fn rotated_vault() -> VaultState {
    let mut v = unrotated_vault();
    v.signers = [pk(1), pk(2), pk(3)];
    v.signers_ext = [pk(4), pk(5)];
    v
}

fn governance() -> GovernanceConfig {
    GovernanceConfig {
        thresholds: crate::state::DEFAULT_THRESHOLDS,
        mint_window_seconds: DEFAULT_MINT_WINDOW_SECONDS,
        mint_window_cap: DEFAULT_MINT_WINDOW_CAP,
        bump: 255,
        _reserved: [0; 64],
    }
}

fn err_code(e: Error) -> u32 {
    match e {
        Error::AnchorError(inner) => inner.error_code_number,
        other => panic!("expected an AnchorError, got {other:?}"),
    }
}

// ══════════════════════════════════════════════════════════════════════════
// THE LAYOUT. Read the failure message before changing a number here.
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn vault_state_field_offsets_are_frozen() {
    // `VaultState` is `zero_copy(unsafe)` + `repr(C)`: a field's OFFSET is its
    // identity, because the account data buffer is reinterpreted in place with
    // no name-keyed decode and no version tag.
    //
    // IF THIS TEST FAILS, DO NOT UPDATE THE NUMBERS. It means a field was
    // inserted or widened rather than appended, and the deployed vaults on
    // devnet and mainnet would be read with every subsequent field shifted —
    // `threshold` taken from inside a pubkey, `payout_mint` straddling two
    // fields, the currency registry off by the width of the change. It would
    // compile, deploy, and run.
    assert_eq!(offset_of!(VaultState, signers), 0);
    assert_eq!(offset_of!(VaultState, threshold), 96);
    assert_eq!(offset_of!(VaultState, bump), 97);
    assert_eq!(offset_of!(VaultState, paused), 98);
    assert_eq!(offset_of!(VaultState, payout_mint), 99);
    assert_eq!(offset_of!(VaultState, treasury_authority), 131);
    assert_eq!(offset_of!(VaultState, accepted_currencies), 163);

    // The v0.26 append lands exactly where `_reserved` used to start...
    assert_eq!(offset_of!(VaultState, signers_ext), 1443);
    // ...and consumes it exactly, leaving nothing behind.
    assert_eq!(size_of::<[Pubkey; 2]>(), 64);
    assert_eq!(size_of::<VaultState>(), 1507);
}

#[test]
fn vault_state_size_is_unchanged_so_no_realloc_is_needed() {
    // 8 discriminator + 1507 data = the 1515-byte account already on chain.
    // Equality here is what makes "deploy first, rotate later" true: a larger
    // struct would make every existing account too small to load, and the
    // upgrade would brick the vault on its first instruction.
    assert_eq!(8 + size_of::<VaultState>(), 1515);
}

// ══════════════════════════════════════════════════════════════════════════
// MIGRATION SAFETY — the most important behavioural test in this file.
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn unrotated_vault_behaves_exactly_as_it_did_before_the_upgrade() {
    // This is the property the whole append-don't-widen design exists to buy:
    // on the day v0.26 is deployed, and for as long afterwards as the operator
    // takes to run the rotation ceremony, the vault must behave IDENTICALLY to
    // v0.25. The two new slots read as `Pubkey::default()` from the previously
    // zeroed reserve, which `all_signers` treats as empty.
    let vault = unrotated_vault();

    assert_eq!(vault.active_signer_count(), 3);
    assert_eq!(vault.all_signers().count(), 3);
    assert!(vault.is_signer(&pk(1)));
    assert!(vault.is_signer(&pk(2)));
    assert!(vault.is_signer(&pk(3)));
    assert!(!vault.is_signer(&pk(4)));

    // The empty slots must never be usable as a signer. If the zero key
    // matched, ANY caller could authorize by naming a pubkey nobody holds.
    assert!(!vault.is_signer(&Pubkey::default()));

    // And a 2-of-3 action still authorizes on exactly the two keys it used to.
    assert!(vault.validate_threshold(&[pk(1), pk(2)], 2).is_ok());
}

#[test]
fn rotated_five_signer_set_validates() {
    let vault = rotated_vault();

    assert_eq!(vault.active_signer_count(), 5);
    for i in 1..=5u8 {
        assert!(vault.is_signer(&pk(i)), "slot {i} should be a signer");
    }
    assert!(!vault.is_signer(&pk(6)));

    // Three distinct members satisfy a 3-threshold action — including three
    // drawn from ACROSS the split, which is the case that would fail if
    // anything still read `signers` alone.
    assert!(vault.validate_threshold(&[pk(3), pk(4), pk(5)], 3).is_ok());
    assert!(vault.validate_threshold(&[pk(1), pk(5), pk(2)], 3).is_ok());
}

// ══════════════════════════════════════════════════════════════════════════
// THE THRESHOLD IS REAL — these fail against v0.25's `validate_multisig`.
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn two_signatures_are_refused_for_a_three_threshold_action() {
    // THE HEADLINE REGRESSION TEST. v0.25's `validate_multisig(s1, s2)` was
    // `s1 != s2 && is_signer(s1) && is_signer(s2)` — it accepted exactly two
    // signatures and never read `threshold` at all. So a vault storing
    // `threshold: 3` still settled contests on two, and this assertion would
    // have failed against every version of this program before v0.26.
    let vault = rotated_vault();
    let err = vault
        .validate_threshold(&[pk(1), pk(2)], 3)
        .expect_err("two signatures must not satisfy a threshold of three");
    assert_eq!(err_code(err), 6046, "expected InsufficientSigners");
}

#[test]
fn the_same_key_twice_is_one_signature() {
    // Two signatures from one keypair is one signature. Without this, a single
    // agent-held key could satisfy any threshold by being named repeatedly.
    let vault = rotated_vault();
    let err = vault
        .validate_threshold(&[pk(1), pk(1), pk(1)], 3)
        .expect_err("a repeated key must not count three times");
    assert_eq!(err_code(err), 6014, "expected DuplicateSigner");
}

#[test]
fn a_non_member_cannot_make_up_the_count() {
    let vault = rotated_vault();
    let err = vault
        .validate_threshold(&[pk(1), pk(2), pk(99)], 3)
        .expect_err("a stranger must not count toward the threshold");
    assert_eq!(err_code(err), 6000, "expected Unauthorized");
}

#[test]
fn a_zero_threshold_is_refused_rather_than_authorizing_everything() {
    // Defence against a corrupt or partially-written table reaching this far:
    // "zero signatures required" must be an ERROR, never an open vault.
    let vault = rotated_vault();
    let err = vault
        .validate_threshold(&[], 0)
        .expect_err("a zero threshold must be rejected");
    assert_eq!(err_code(err), 6048, "expected GovernanceThresholdInvalid");
}

// ══════════════════════════════════════════════════════════════════════════
// THE STORED TABLE
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn shipped_defaults_match_the_agreed_table() {
    // The numbers Mr. McRitchie decided on 2026-09-14/15, asserted so a later
    // edit to `DEFAULT_THRESHOLDS` has to be deliberate.
    let g = governance();
    for (action, expected, name) in [
        (gov_action::SETTLE_CONTEST, 3, "settle_contest"),
        (gov_action::CANCEL_CONTEST, 3, "cancel_contest"),
        (gov_action::SWEEP_OPERATOR_REVENUE, 3, "sweep_operator_revenue"),
        (gov_action::REGISTER_CURRENCY, 3, "register_currency"),
        (gov_action::DEACTIVATE_CURRENCY, 3, "deactivate_currency"),
        (gov_action::CREATE_SEASON, 3, "create_season"),
        (gov_action::UPDATE_SIGNERS, 3, "update_signers"),
        (gov_action::UNPAUSE, 3, "unpause"),
        (gov_action::BURN_ENTRY_TOKEN, 3, "burn_entry_token"),
        (gov_action::MINT_ENTRY_TOKEN_OVER_CAP, 3, "mint above cap"),
        (gov_action::SET_GOVERNANCE, 3, "set_governance"),
        (gov_action::PAUSE, 2, "pause"),
        (gov_action::CLOSE_CONTEST, 2, "close_contest"),
        (gov_action::SET_CONTEST_LOCK_TIME, 2, "set_contest_lock_time"),
        (gov_action::SET_CONTEST_CONCLUSION_TIME, 2, "set_contest_conclusion_time"),
        (gov_action::MINT_ENTRY_TOKEN, 1, "mint within cap"),
        (gov_action::GRANT_SEEDS, 1, "grant_seeds"),
        (gov_action::ADMIN_USERNAME, 1, "admin username waiver"),
    ] {
        assert_eq!(g.threshold_for(action), expected, "{name}");
    }
}

#[test]
fn pause_is_cheaper_than_unpause() {
    // The asymmetry, asserted as a relationship rather than as two numbers, so
    // it survives any future retune of either side: a captured system must be
    // able to pull the brake and never able to release it.
    let g = governance();
    assert!(
        g.threshold_for(gov_action::PAUSE) < g.threshold_for(gov_action::UNPAUSE),
        "pause must never cost as much as unpause"
    );
}

#[test]
fn an_unset_entry_reads_as_the_shipped_default_not_as_zero() {
    // A zeroed table must never mean "no signatures required". This is the
    // difference between a corrupt account and an open vault.
    let mut g = governance();
    g.thresholds = [0u8; GOV_TABLE_LEN];
    assert_eq!(g.threshold_for(gov_action::SETTLE_CONTEST), 3);
    assert_eq!(g.threshold_for(gov_action::PAUSE), 2);
    assert_eq!(g.threshold_for(gov_action::MINT_ENTRY_TOKEN), 1);
}

#[test]
fn floors_are_enforced_on_read_not_only_on_write() {
    // Even if a value below the floor somehow reached storage — a future write
    // path that forgot to check, a partially-written account — the READ raises
    // it. `update_signers` can never be authorized on two signatures.
    let mut g = governance();
    g.thresholds[gov_action::UPDATE_SIGNERS as usize] = 1;
    g.thresholds[gov_action::UNPAUSE as usize] = 2;
    g.thresholds[gov_action::SET_GOVERNANCE as usize] = 1;
    assert_eq!(g.threshold_for(gov_action::UPDATE_SIGNERS), 3);
    assert_eq!(g.threshold_for(gov_action::UNPAUSE), 3);
    assert_eq!(g.threshold_for(gov_action::SET_GOVERNANCE), 3);
}

#[test]
fn an_action_id_past_the_table_cannot_index_out_of_bounds() {
    let g = governance();
    assert_eq!(g.threshold_for(200), 1);
    assert_eq!(GovernanceConfig::floor_for(200), 1);
    assert_eq!(GovernanceConfig::default_for(200), 1);
}

#[test]
fn every_live_action_has_a_default_within_the_signer_ceiling() {
    // A default above MAX_SIGNERS would ship an action that no possible signer
    // set could ever authorize.
    let g = governance();
    let mut action = 0u8;
    while (action as usize) < gov_action::COUNT {
        let t = g.threshold_for(action);
        assert!(t >= 1, "action {action} requires zero signatures");
        assert!(
            (t as usize) <= MAX_SIGNERS,
            "action {action} requires {t}, more than the {MAX_SIGNERS} slots that exist"
        );
        action += 1;
    }
    assert_eq!(g.max_live_threshold(), 3);
}

// ══════════════════════════════════════════════════════════════════════════
// THE MINT WINDOW
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn window_index_partitions_time_and_refuses_a_zero_length_window() {
    let g = governance();
    assert_eq!(g.window_index_for(0).unwrap(), 0);
    assert_eq!(g.window_index_for(86_399).unwrap(), 0);
    assert_eq!(g.window_index_for(86_400).unwrap(), 1);
    // `div_euclid`, not `/`: a negative timestamp must not floor toward zero
    // and share window 0 with the first day of the epoch.
    assert_eq!(g.window_index_for(-1).unwrap(), -1);

    let mut broken = governance();
    broken.mint_window_seconds = 0;
    let err = broken
        .window_index_for(1)
        .expect_err("a zero-length window must be rejected, not divide by zero");
    assert_eq!(err_code(err), 6054, "expected InvalidMintWindowPolicy");
}

// ══════════════════════════════════════════════════════════════════════════
// THE ERROR BLOCK — the boundary the sibling task depends on.
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn governance_error_codes_occupy_exactly_6046_through_6059() {
    // Anchor assigns codes BY POSITION in the enum. The three reserved
    // variants are what keep the next appended variant landing on 6060, where
    // `username-registry-on-chain` expects to start. Without them a second
    // branch appending in the same upgrade window would silently claim 6057
    // and every code below it would shift under Rails' integer decoding.
    assert_eq!(VaultError::InsufficientSigners as u32 + 6000, 6046);
    assert_eq!(VaultError::InvalidRentDestination as u32 + 6000, 6056);
    assert_eq!(VaultError::ReservedGovernance6059 as u32 + 6000, 6059);

    // The pre-existing codes Rails already decodes must not have moved.
    assert_eq!(VaultError::Unauthorized as u32 + 6000, 6000);
    assert_eq!(VaultError::InvalidThreshold as u32 + 6000, 6013);
    assert_eq!(VaultError::DuplicateSigner as u32 + 6000, 6014);
    assert_eq!(VaultError::SignerContinuityRequired as u32 + 6000, 6017);
    assert_eq!(VaultError::EntryTokenAlreadyBurned as u32 + 6000, 6045);
}
