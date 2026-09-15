//! Host-target unit tests for the username registry.
//!
//! WHY THESE ARE UNIT TESTS. The registry is two pure rules — what the
//! canonical key is, and who may write a record — wrapped in account structs.
//! An integration test against a validator can only observe them through a
//! whole transaction, where a wrong answer surfaces as a generic failure
//! several steps from its cause. These assert the rules where they are
//! decided. The Anchor suite in `tests/turf_vault.ts` then asserts the same
//! refusals END TO END, because a rule that holds in a function and is never
//! reached from the instruction is worth nothing.
//!
//! EVERY BEHAVIOURAL TEST HERE ASSERTS A REFUSAL, not a success code. The
//! feature's whole value is the calls it REJECTS: a second wallet on a taken
//! name, anyone at all on a vault-held one, and a rename that tries to keep
//! the name it is leaving. A test that only proves the happy path proves the
//! feature was never armed.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::set_username::{
    canonical_username_key, require_canonical_form, require_canonical_key, validate_username,
    validate_username_charset_len, validate_username_prefix,
};
use crate::instructions::username_registry::{claim_or_confirm, settle_previous_record};
use crate::state::{
    gov_action, GovernanceConfig, UserAccount, UsernameRecord, DEFAULT_THRESHOLDS,
    DEFAULT_MINT_WINDOW_CAP, DEFAULT_MINT_WINDOW_SECONDS, GOV_TABLE_LEN,
};

const NOW: i64 = 1_789_000_000;

fn pk(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

/// A 32-byte zero-padded username buffer, exactly as the instruction argument
/// arrives on the wire.
fn name(text: &str) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[..text.len()].copy_from_slice(text.as_bytes());
    buf
}

fn key(text: &str) -> [u8; 32] {
    canonical_username_key(&name(text))
}

fn err_code(e: Error) -> u32 {
    match e {
        Error::AnchorError(inner) => inner.error_code_number,
        other => panic!("expected an AnchorError, got {other:?}"),
    }
}

fn empty_record() -> UsernameRecord {
    UsernameRecord {
        owner: Pubkey::default(),
        name: [0u8; 32],
        claimed_at: 0,
        bump: 0,
        _reserved: [0; 16],
    }
}

/// A `UserAccount` as it exists AFTER this upgrade: its name is locked.
fn registered_user(wallet: Pubkey, username: &str) -> UserAccount {
    UserAccount {
        wallet,
        username: name(username),
        seeds: 0,
        entries: 0,
        wins: 0,
        cashes: 0,
        total_won: 0,
        bump: 254,
        username_registered: 1,
        _reserved: [0; 31],
    }
}

/// One of the 47 accounts that predate the registry: a name, and no record.
fn pre_registry_user(wallet: Pubkey, username: &str) -> UserAccount {
    let mut user = registered_user(wallet, username);
    user.username_registered = 0;
    user
}

fn governance() -> GovernanceConfig {
    GovernanceConfig {
        thresholds: DEFAULT_THRESHOLDS,
        mint_window_seconds: DEFAULT_MINT_WINDOW_SECONDS,
        mint_window_cap: DEFAULT_MINT_WINDOW_CAP,
        bump: 255,
        _reserved: [0; 64],
    }
}

// ══════════════════════════════════════════════════════════════════════════
// THE CANONICAL KEY — this function IS the uniqueness rule
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn two_usernames_differing_only_in_case_are_one_name() {
    // THE HEADLINE PROPERTY. The registry refuses a duplicate by colliding on
    // a PDA seed, so "is this the same name?" is decided entirely by whether
    // this function returns the same 32 bytes. If it stopped folding case,
    // "Alice" would derive a different PDA from "alice", both would be
    // claimable, and the feature would be silently off for exactly the
    // impersonation it exists to stop.
    assert_eq!(key("Alice"), key("alice"));
    assert_eq!(key("ALICE"), key("alice"));
    assert_eq!(key("aLiCe"), key("alice"));
}

#[test]
fn distinct_names_never_share_a_key() {
    // The other direction: folding too much would refuse legitimate users.
    assert_ne!(key("alice"), key("alicee"));
    assert_ne!(key("alice"), key("alic"));
    assert_ne!(key("alice"), key("bob"));
    // Padding is part of the key, so a name and that name plus a trailing
    // space are different names rather than the same one.
    assert_ne!(key("alice"), key("alice "));
}

#[test]
fn the_key_is_a_full_32_bytes_and_keeps_its_padding() {
    let k = key("alice");
    assert_eq!(k.len(), 32);
    assert_eq!(&k[..5], b"alice");
    assert!(k[5..].iter().all(|&b| b == 0), "padding must survive");
}

#[test]
fn canonicalizing_a_key_again_changes_nothing() {
    // `require_canonical_form` leans on this: a key is canonical exactly when
    // running it through the function is a no-op.
    let k = key("Alice");
    assert_eq!(canonical_username_key(&k), k);
    assert!(require_canonical_form(&k).is_ok());
}

#[test]
fn a_key_that_is_not_the_canonical_form_is_refused() {
    // The seed is an ARGUMENT — it has to be, because Anchor needs it where
    // the account struct expands — so it is re-derived and checked, the same
    // shape `mint_entry_token` uses for `source_ref_hash`. Without this a
    // caller could lock a name that has nothing to do with the one they set.
    let err = require_canonical_key(&name("Alice"), &name("bob"))
        .expect_err("a key that is not this username's canonical form must be refused");
    assert_eq!(err_code(err), 6061, "expected UsernameKeyMismatch");

    // The near-miss that matters: the key left UNLOWERCASED.
    let err = require_canonical_key(&name("Alice"), &name("Alice"))
        .expect_err("an un-lowercased key must be refused");
    assert_eq!(err_code(err), 6061);

    // And the reservation path's stricter form check.
    let err = require_canonical_form(&name("Alice"))
        .expect_err("a reservation key must already be lowercase");
    assert_eq!(err_code(err), 6061);
}

// ══════════════════════════════════════════════════════════════════════════
// THE CLAIM — the refusals this whole feature exists for
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn a_second_wallet_cannot_claim_a_name_that_is_already_held() {
    // THE TEST THAT MATTERS MOST. Mr. McRitchie's own framing: "I have a turf
    // user, another user should be stopped because it's already taken."
    let mut record = empty_record();
    claim_or_confirm(&mut record, pk(1), key("alice"), 254, NOW)
        .expect("the first claimant takes a free name");
    assert_eq!(record.owner, pk(1));

    let err = claim_or_confirm(&mut record, pk(2), key("alice"), 254, NOW)
        .expect_err("a second wallet must NOT be able to take a held name");
    assert_eq!(err_code(err), 6060, "expected UsernameAlreadyClaimed");

    // And the refusal must not have half-written the record on its way out.
    assert_eq!(record.owner, pk(1), "the holder must be untouched");
}

#[test]
fn a_vault_held_name_is_unclaimable_by_anyone() {
    // THE BLOCKED LIST, ASSERTED AS A REFUSAL. A reservation is just a record
    // the vault owns, so "nobody can take this name" has to fall out of the
    // same check that stops a second player — otherwise the blocked list is
    // decorative.
    let vault = pk(200);
    let mut record = empty_record();
    claim_or_confirm(&mut record, vault, key("slur"), 254, NOW).expect("the vault reserves it");

    for wallet in [pk(1), pk(2), pk(99)] {
        let err = claim_or_confirm(&mut record, wallet, key("slur"), 254, NOW)
            .expect_err("a reserved name must be unclaimable");
        assert_eq!(err_code(err), 6060, "expected UsernameAlreadyClaimed");
    }
    assert_eq!(record.owner, vault, "the reservation must survive");
    assert!(record.is_reserved(&vault));
    assert!(!record.is_held_by(&pk(1)));
}

#[test]
fn the_holder_reclaiming_their_own_name_is_idempotent() {
    // A retried job, and the case-only rename, both land here. It must
    // succeed without rewriting the record's history.
    let mut record = empty_record();
    claim_or_confirm(&mut record, pk(1), key("alice"), 254, NOW).unwrap();
    let claimed_at = record.claimed_at;

    claim_or_confirm(&mut record, pk(1), key("alice"), 254, NOW + 5_000)
        .expect("the holder may confirm their own name");
    assert_eq!(record.claimed_at, claimed_at, "confirming must not restamp");
}

#[test]
fn a_record_whose_stored_name_disagrees_with_its_key_is_refused() {
    // Belt and braces against a corrupt account: the seeds constraint already
    // proves the PDA came from this key, so a disagreement means the record
    // is not what it claims to be.
    let mut record = empty_record();
    claim_or_confirm(&mut record, pk(1), key("alice"), 254, NOW).unwrap();
    record.name = key("bob");

    let err = claim_or_confirm(&mut record, pk(1), key("alice"), 254, NOW)
        .expect_err("a record must not be acted on under the wrong name");
    assert_eq!(err_code(err), 6064, "expected UsernameRecordNameMismatch");
}

#[test]
fn nobody_can_claim_a_name_for_the_zero_key() {
    // `claim_or_confirm` reads "owner is unset" as "this account was just
    // created". Letting a caller STORE the zero key would break that reading
    // and leave a live record that reads as freshly allocated — claimable by
    // the next person through the door.
    let mut record = empty_record();
    let err = claim_or_confirm(&mut record, Pubkey::default(), key("alice"), 254, NOW)
        .expect_err("the zero key must never be recorded as an owner");
    assert_eq!(err_code(err), 6000, "expected Unauthorized");
}

#[test]
fn an_unset_owner_reads_as_reserved_so_a_corrupt_record_fails_closed() {
    // No write path produces this. It is folded into `is_reserved` anyway so
    // that if one ever did, the name reads as UNCLAIMABLE rather than falling
    // open to whoever asks first.
    let record = empty_record();
    assert!(record.is_reserved(&pk(200)));
    assert!(!record.is_held_by(&Pubkey::default()));
}

// ══════════════════════════════════════════════════════════════════════════
// THE RENAME — closing the name you leave
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn a_registered_rename_that_omits_the_old_record_is_refused() {
    // THE ACCUMULATION BUG. Claim "alice", rename to "bob" leaving the old
    // record out of the account list, and you hold two names for about
    // 0.0015 SOL — repeatable. A program cannot tell an omitted account from
    // an absent one, which is why `username_registered` is stored on chain.
    let user = registered_user(pk(1), "alice");
    let err = settle_previous_record(&user, &pk(1), &key("bob"), None)
        .expect_err("a registered rename must hand back the name it leaves");
    assert_eq!(err_code(err), 6062, "expected UsernameRecordMissing");
}

#[test]
fn a_rename_cannot_close_someone_elses_record() {
    let user = registered_user(pk(1), "alice");
    let mut someone_elses = empty_record();
    claim_or_confirm(&mut someone_elses, pk(2), key("carol"), 254, NOW).unwrap();

    let err = settle_previous_record(&user, &pk(1), &key("bob"), Some(&someone_elses))
        .expect_err("a rename must not be able to close another wallet's record");
    assert_eq!(err_code(err), 6063, "expected UsernameRecordOwnerMismatch");
}

#[test]
fn a_rename_cannot_close_a_different_name_it_also_holds() {
    // Owned by the right wallet, but not the name being given up. Without
    // this a holder of two names could rename and close whichever of the two
    // they preferred to lose, keeping the other.
    let user = registered_user(pk(1), "alice");
    let mut other_name = empty_record();
    claim_or_confirm(&mut other_name, pk(1), key("archive"), 254, NOW).unwrap();

    let err = settle_previous_record(&user, &pk(1), &key("bob"), Some(&other_name))
        .expect_err("only the CURRENT name's record may be closed");
    assert_eq!(err_code(err), 6064, "expected UsernameRecordNameMismatch");
}

#[test]
fn a_correct_rename_is_accepted_and_reports_itself_as_a_rename() {
    let user = registered_user(pk(1), "alice");
    let mut current = empty_record();
    claim_or_confirm(&mut current, pk(1), key("alice"), 254, NOW).unwrap();

    let renaming = settle_previous_record(&user, &pk(1), &key("bob"), Some(&current))
        .expect("handing back the current name is the legal path");
    assert!(renaming, "a changed key is a rename");
}

#[test]
fn a_case_only_change_keeps_the_record_and_refuses_one_offered() {
    // "alice" -> "Alice" is the same registry key, so there is nothing to
    // close. Offering a record anyway could only be some OTHER record, and
    // closing it would be a silent loss — so it is refused, not ignored.
    let user = registered_user(pk(1), "alice");
    let renaming = settle_previous_record(&user, &pk(1), &key("Alice"), None)
        .expect("a case-only change is legal and closes nothing");
    assert!(!renaming, "the canonical key did not change");

    let mut current = empty_record();
    claim_or_confirm(&mut current, pk(1), key("alice"), 254, NOW).unwrap();
    let err = settle_previous_record(&user, &pk(1), &key("Alice"), Some(&current))
        .expect_err("nothing is due back on a case-only change");
    assert_eq!(err_code(err), 6065, "expected UsernameRecordNotExpected");
}

#[test]
fn a_pre_registry_user_renames_without_a_record_and_may_not_invent_one() {
    // The 47 production accounts. They hold no record, so their old name
    // simply returns to the pool — Mr. McRitchie's accepted semantic:
    // renaming does not lock the name you left.
    let user = pre_registry_user(pk(1), "alice");
    let renaming = settle_previous_record(&user, &pk(1), &key("bob"), None)
        .expect("a pre-registry account has nothing to hand back");
    assert!(renaming);

    // And they cannot hand back a record they do not have, which would be a
    // way to close someone else's.
    let mut stranger = empty_record();
    claim_or_confirm(&mut stranger, pk(2), key("carol"), 254, NOW).unwrap();
    let err = settle_previous_record(&user, &pk(1), &key("bob"), Some(&stranger))
        .expect_err("an unregistered account owes nothing back");
    assert_eq!(err_code(err), 6065, "expected UsernameRecordNotExpected");
}

// ══════════════════════════════════════════════════════════════════════════
// THE VALIDITY BAR — the prefix list survives the registry
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn xan_is_reserved_because_an_operator_identity_is_not_claimable() {
    // The entry added with this change. It goes through the FULL bar a lone
    // wallet faces, which is the path a would-be claimant actually takes.
    for attempt in ["xan", "Xan", "XAN"] {
        let err = validate_username(&name(attempt))
            .expect_err("an operator identity must not be claimable");
        assert_eq!(err_code(err), 6020, "expected UsernameReserved for {attempt}");
    }

    // A control, so this test cannot pass because `validate_username` refuses
    // everything: a name that is not on the list is accepted.
    assert!(
        validate_username(&name("xylophone")).is_ok(),
        "the bar must still accept an ordinary name"
    );
}

#[test]
fn the_prefix_list_still_catches_what_the_registry_cannot() {
    // A registry is EXACT-MATCH. It stops a second "admin" and says nothing
    // at all about "admin123", which is why the prefix list is kept rather
    // than replaced. These are the lookalikes only the list can refuse.
    for attempt in ["admin123", "turfmonster1", "xan1", "moderator", "rootuser"] {
        let err = validate_username_prefix(&name(attempt))
            .expect_err("the prefix list must still refuse a lookalike");
        assert_eq!(err_code(err), 6020, "expected UsernameReserved for {attempt}");
    }

    // `xan` is the entry added with the registry, and it is a PREFIX like
    // every other — so it blocks "xanadu" too. That is the existing design's
    // accepted behaviour, not a new one: `mod` has always blocked "modern".
    let err = validate_username_prefix(&name("xanadu")).expect_err("prefix, not exact match");
    assert_eq!(err_code(err), 6020);
    let err = validate_username_prefix(&name("XAN")).expect_err("case-insensitive");
    assert_eq!(err_code(err), 6020);
}

#[test]
fn a_quorum_waives_only_the_prefix_branch_never_the_charset_bar() {
    // `overwrite_username` and `reserve_username` call
    // `validate_username_charset_len` alone — that is where the deleted
    // `admin_set_username`'s waiver now lives, at three signatures. What it
    // must NOT waive is the rest of the bar.
    assert!(
        validate_username_charset_len(&name("turf")).is_ok(),
        "a quorum may write a reserved-prefix name"
    );
    assert!(
        validate_username(&name("turf")).is_err(),
        "a lone wallet may not"
    );

    let err = validate_username_charset_len(&name("ab"))
        .expect_err("the length floor is not waivable");
    assert_eq!(err_code(err), 6022, "expected UsernameTooShort");

    let mut control_chars = name("bad");
    control_chars[1] = 0x07;
    let err = validate_username_charset_len(&control_chars)
        .expect_err("the charset bar is not waivable");
    assert_eq!(err_code(err), 6021, "expected UsernameInvalidChars");
}

#[test]
fn a_blank_name_can_never_be_locked() {
    // Every account without a username canonicalizes to the same 32 zero
    // bytes, so one blank record would collide for all of them.
    // `backfill_username_record` applies this bar to the stored name for
    // exactly that reason.
    let err = validate_username_charset_len(&[0u8; 32])
        .expect_err("a blank name must not be lockable");
    assert_eq!(err_code(err), 6022, "expected UsernameTooShort");
}

// ══════════════════════════════════════════════════════════════════════════
// THE ACCOUNT LAYOUT
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn the_registration_flag_cost_no_bytes() {
    // IF THIS FAILS, EVERY LIVE UserAccount IS TOO SMALL TO LOAD. The flag was
    // carved from the first byte of `_reserved` (32 -> 31), not appended after
    // it. Appending would have grown the account by one byte and bricked all
    // 47 of them on the first instruction after the upgrade.
    assert_eq!(UserAccount::INIT_SPACE, 125);
    assert_eq!(8 + UserAccount::INIT_SPACE, 133);
}

#[test]
fn a_pre_upgrade_account_reads_as_unregistered() {
    // The reserve was zeroed at v0.16, so the byte the flag now occupies
    // reads 0 on every production account — which is what makes the
    // pre-registry rename path reachable for them at all.
    let zeroed_reserve = pre_registry_user(pk(1), "alice");
    assert_eq!(zeroed_reserve.username_registered, 0);
}

#[test]
fn a_username_record_is_97_bytes() {
    // 8 discriminator + 32 owner + 32 name + 8 claimed_at + 1 bump + 16
    // reserved. About 0.0015 SOL of rent, which is the number the migration
    // estimate (47 names, ~0.07 SOL) rests on.
    assert_eq!(UsernameRecord::INIT_SPACE, 89);
    assert_eq!(UsernameRecord::LEN, 97);
}

// ══════════════════════════════════════════════════════════════════════════
// GOVERNANCE — the ids, the floors, and the migration hazard
// ══════════════════════════════════════════════════════════════════════════

#[test]
fn the_username_actions_occupy_the_ids_appended_after_governance() {
    // Action ids index a STORED table, so they are permanent: re-pointing one
    // hands that action whatever number a live account happens to hold at
    // that index. These were appended after the governance block's 21.
    assert_eq!(gov_action::OVERWRITE_USERNAME, 22);
    assert_eq!(gov_action::RESERVE_USERNAME, 23);
    assert_eq!(gov_action::RELEASE_USERNAME, 24);
    assert_eq!(gov_action::COUNT, 25);

    // And the id the two deleted instructions used is RETIRED, not reused.
    assert_eq!(gov_action::ADMIN_USERNAME, 17);
}

#[test]
fn all_three_username_actions_ship_at_three_and_are_floored_there() {
    let g = governance();
    for (action, label) in [
        (gov_action::OVERWRITE_USERNAME, "overwrite_username"),
        (gov_action::RESERVE_USERNAME, "reserve_username"),
        (gov_action::RELEASE_USERNAME, "release_reserved_username"),
    ] {
        assert_eq!(g.threshold_for(action), 3, "{label} default");
        assert_eq!(GovernanceConfig::floor_for(action), 3, "{label} floor");
    }
}

#[test]
fn a_governance_account_written_before_this_upgrade_still_demands_three() {
    // THE MIGRATION HAZARD, AND WHY A DEFAULT ALONE WOULD NOT HAVE HELD.
    //
    // `DEFAULT_THRESHOLDS` starts as `[1u8; 32]` and then overwrites the ids
    // it knows about, so `init_governance` run by the SIBLING binary — which
    // has no ids 22-24 — writes a literal ONE at those indices. Not a zero.
    // `threshold_for` treats zero as "unset" and falls back to the shipped
    // default; it cannot treat a one as unset, and must not, because one is a
    // legitimate retune.
    //
    // So on any account bootstrapped before this change, the defaults above
    // are NEVER READ, and these three actions would authorize on ONE
    // signature — `overwrite_username`, the instruction that renames people
    // without asking them, reachable by a single agent-held key.
    //
    // The floor is applied on READ, which is the only mechanism here that
    // cannot be forgotten: no post-upgrade transaction, no runbook step.
    let mut stale = governance();
    stale.thresholds = [1u8; GOV_TABLE_LEN];

    assert_eq!(stale.threshold_for(gov_action::OVERWRITE_USERNAME), 3);
    assert_eq!(stale.threshold_for(gov_action::RESERVE_USERNAME), 3);
    assert_eq!(stale.threshold_for(gov_action::RELEASE_USERNAME), 3);
}

#[test]
fn reserving_a_name_is_never_costlier_than_releasing_one() {
    // The same asymmetry `pause_is_cheaper_than_unpause` pins, applied to the
    // other brake this program has: a reservation stops a name being taken,
    // and lifting it is what puts a slur back in the pool. Asserted as a
    // RELATIONSHIP so it survives a retune of either side.
    let g = governance();
    assert!(
        g.threshold_for(gov_action::RESERVE_USERNAME)
            <= g.threshold_for(gov_action::RELEASE_USERNAME),
        "blocking a name must never cost more than unblocking it"
    );
    assert!(
        GovernanceConfig::floor_for(gov_action::RESERVE_USERNAME)
            <= GovernanceConfig::floor_for(gov_action::RELEASE_USERNAME),
        "and no retune may invert it"
    );
}

#[test]
fn the_username_registry_owns_error_codes_6060_upward() {
    // The governance block reserved 6060+ with three unreachable variants
    // because Anchor assigns codes BY POSITION. These are the codes Rails
    // will decode; a shift here would silently re-point every message.
    assert_eq!(VaultError::UsernameAlreadyClaimed as u32 + 6000, 6060);
    assert_eq!(VaultError::UsernameKeyMismatch as u32 + 6000, 6061);
    assert_eq!(VaultError::UsernameRecordMissing as u32 + 6000, 6062);
    assert_eq!(VaultError::UsernameRecordOwnerMismatch as u32 + 6000, 6063);
    assert_eq!(VaultError::UsernameRecordNameMismatch as u32 + 6000, 6064);
    assert_eq!(VaultError::UsernameRecordNotExpected as u32 + 6000, 6065);
    assert_eq!(VaultError::UsernameNotReserved as u32 + 6000, 6066);

    // Nothing below the boundary moved.
    assert_eq!(VaultError::ReservedGovernance6059 as u32 + 6000, 6059);
    assert_eq!(VaultError::InvalidRentDestination as u32 + 6000, 6056);
    assert_eq!(VaultError::UsernameReserved as u32 + 6000, 6020);
}
