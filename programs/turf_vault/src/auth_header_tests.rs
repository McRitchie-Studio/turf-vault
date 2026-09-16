//! AUTH-HEADER GUARD — pins the AUTHORITY STATED IN COMMENTS to the authority
//! the program actually enforces.
//!
//! ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//!
//! Twice now this repo has shipped a comment that contradicted
//! `DEFAULT_THRESHOLDS`. The first time it was `README.md`'s Auth column; the
//! fix landed, and the very next day the SOURCE comments were found saying the
//! old numbers one file away from the table — `burn_entry_token`'s header still
//! read "1-of-3 vault signer" while the action shipped at three. That is the
//! dangerous direction: a reader reconciling two authorities takes the one
//! sitting closest to the code, and the closest one was wrong.
//!
//! Prose cannot be kept honest by review alone, because nothing about editing
//! `DEFAULT_THRESHOLDS` makes a stale sentence in another file fail anything.
//! So the coupling is ENFORCED HERE instead of assumed — the same argument
//! `bin/release-check` makes for `release-check-covers-ci.test.js`.
//!
//! ── WHY RUST AND NOT A NODE GUARD ─────────────────────────────────────────
//!
//! `scripts/check-doc-op-refs.js` is this repo's other prose guard, and a Node
//! lane would have been the cheaper lane to add. It would also have had to
//! PARSE `DEFAULT_THRESHOLDS` out of `state.rs` with a regex — which makes the
//! guard's own idea of the table a second transcription of it, free to drift
//! in exactly the way the guard exists to prevent. Here the table is not
//! parsed at all: `DEFAULT_THRESHOLDS` and `THRESHOLD_FLOORS` are linked in as
//! the compiled constants, and `gov_action::*` supplies the ids. Only the
//! PROSE side is parsed, which is the side that has no other representation.
//!
//! This runs in `cargo test --workspace --locked` — lane 5 of both
//! `.github/workflows/ci.yml` and `bin/release-check`. It is `#[cfg(test)]`,
//! so it contributes nothing to the BPF artifact.
//!
//! ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
//!
//! A. THE PIN. In any comment in this crate, a `gov_action` action name
//!    followed closely by a number means "this action takes that many
//!    signatures", and that number must equal `DEFAULT_THRESHOLDS`. This is
//!    deliberately NOT limited to `Auth:` headers: the two escalation headers
//!    (`set_contest_lock_time`, `set_contest_conclusion_time`) and
//!    `mint_entry_token`'s cap table state their numbers in blocks that no
//!    "find the Auth header" rule would delimit the same way, and those are
//!    precisely the numbers most worth holding.
//!
//! B. THE ANTI-DRIFT BAN. No `Auth` header may express authority as a literal
//!    `N-of-M`. `N` rots when a threshold is retuned and `M` rots on every
//!    signer rotation (the set is three today and five after the ceremony in
//!    `docs/SIGNER_ROTATION.md`), so an `N-of-M` in a header is a sentence
//!    with two independent ways to go stale and no way to notice. A signature
//!    COUNT plus the action name has neither.
//!
//!    This ban is scoped to `Auth` headers ON PURPOSE. Roughly 180 other
//!    `N-of-M` mentions in this repo are CORRECT — they describe the DEPLOYED
//!    v0.25 `VaultState` (a fixed 2-of-3 / 1-of-3 whose `threshold` field is
//!    never read) or the Squads upgrade authority, neither of which is this
//!    table. Banning the shape repo-wide would force ~180 edits that each
//!    replace a true statement with a false one.
//!
//! C. FLOOR HONESTY. A `FLOOR`/`FLOORED at` number in an `Auth` header must
//!    equal `THRESHOLD_FLOORS` for the action that header names.
//!
//! D. COMPLETENESS. `ACTION_NAMES` below must cover every id up to
//!    `gov_action::COUNT`, so adding an action forces adding its name here
//!    rather than silently widening the set of numbers nobody checks.

use crate::state::{gov_action, DEFAULT_THRESHOLDS, THRESHOLD_FLOORS};
use std::path::{Path, PathBuf};

/// Every governance action, paired with its id READ FROM THE CONSTANT. The
/// string is the only hand-written half; the id cannot drift because it is
/// `gov_action::*` itself. Assertion D holds the list's completeness.
const ACTION_NAMES: &[(&str, u8)] = &[
    ("SETTLE_CONTEST", gov_action::SETTLE_CONTEST),
    ("CANCEL_CONTEST", gov_action::CANCEL_CONTEST),
    ("SWEEP_OPERATOR_REVENUE", gov_action::SWEEP_OPERATOR_REVENUE),
    ("REGISTER_CURRENCY", gov_action::REGISTER_CURRENCY),
    ("DEACTIVATE_CURRENCY", gov_action::DEACTIVATE_CURRENCY),
    ("PAUSE", gov_action::PAUSE),
    ("UNPAUSE", gov_action::UNPAUSE),
    ("UPDATE_SIGNERS", gov_action::UPDATE_SIGNERS),
    ("CREATE_SEASON", gov_action::CREATE_SEASON),
    ("CLOSE_CONTEST", gov_action::CLOSE_CONTEST),
    ("SET_CONTEST_LOCK_TIME", gov_action::SET_CONTEST_LOCK_TIME),
    ("SET_CONTEST_CONCLUSION_TIME", gov_action::SET_CONTEST_CONCLUSION_TIME),
    ("MINT_ENTRY_TOKEN", gov_action::MINT_ENTRY_TOKEN),
    ("MINT_ENTRY_TOKEN_OVER_CAP", gov_action::MINT_ENTRY_TOKEN_OVER_CAP),
    ("BURN_ENTRY_TOKEN", gov_action::BURN_ENTRY_TOKEN),
    ("GRANT_SEEDS", gov_action::GRANT_SEEDS),
    ("SET_GOVERNANCE", gov_action::SET_GOVERNANCE),
    ("ADMIN_USERNAME", gov_action::ADMIN_USERNAME),
    ("CREATE_CONTEST", gov_action::CREATE_CONTEST),
    ("ENTER_CONTEST", gov_action::ENTER_CONTEST),
    ("SET_CONTEST_LOCK_TIME_REOPEN", gov_action::SET_CONTEST_LOCK_TIME_REOPEN),
    (
        "SET_CONTEST_CONCLUSION_TIME_AMEND",
        gov_action::SET_CONTEST_CONCLUSION_TIME_AMEND,
    ),
    ("OVERWRITE_USERNAME", gov_action::OVERWRITE_USERNAME),
    ("RESERVE_USERNAME", gov_action::RESERVE_USERNAME),
    ("RELEASE_USERNAME", gov_action::RELEASE_USERNAME),
];

/// How far past an action name a number may sit and still be read as that
/// action's threshold. Wide enough for the longest real form in the tree —
/// "`gov_action::SET_CONTEST_LOCK_TIME`\n///     (default 2)", which
/// normalizes to 12 characters — and far too narrow to reach into the next
/// sentence's prose.
const NUMBER_WINDOW: usize = 24;

/// THIS FILE, excluded from its own scan. Its prose quotes the exact stale
/// headers it exists to reject ("1-of-3 vault signer", "Auth: 2-of-3
/// multisig"), so scanning it would make the guard fail on its own
/// description of the bug. The control checks below drive the scanner over
/// those same strings as DATA, which is where a quotation belongs.
const GUARD_SOURCE: &str = "auth_header_tests.rs";

/// Characters that may sit between an action name and the number claimed to be
/// its threshold. This is an ALLOW-LIST on purpose, and it is what separates a
/// CLAIM from a USE:
///
///   claim  `gov_action::PAUSE` — default 2      → "` — default " ✓
///   claim  `OVERWRITE_USERNAME` (3, FLOORED…)   → "` ("          ✓
///   use    set_action_threshold(PAUSE, 1)       → ","            ✗ an argument
///   use    `threshold(SETTLE_CONTEST) - 2`      → ") - "         ✗ arithmetic
///
/// Both rejected forms are real comments in this tree, both are TRUE (one
/// narrates a fixed bug, the other subtracts the two named signers), and a
/// deny-list guard flagged both on its first run. A comma or a close-paren
/// means the name is being passed somewhere, not described.
const CLAIM_SEPARATORS: &[char] = &['`', ' ', '(', '\u{2014}', '\u{2013}', '-'];

/// Words that may join a name to its number without turning the sentence into
/// something other than a threshold claim. Every one is a form this tree
/// already writes — "(default 3)", "`SETTLE_CONTEST` signatures (default 3)",
/// "`UPDATE_SIGNERS` requires three" — and the list is kept to those on
/// purpose: each addition widens what the guard will read as a claim.
const CLAIM_CONNECTORS: &[&str] = &["default", "signatures", "requires"];

// ──────────────────────────────────────────────────────────────────────────
// Source access
// ──────────────────────────────────────────────────────────────────────────

/// The crate's `src/`, resolved from the manifest dir rather than the process
/// CWD — `cargo test` does not promise the latter, and a guard that silently
/// finds no files is a guard that always passes.
fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Every `.rs` file under `src/`, recursively. Read from the DIRECTORY rather
/// than a hand-kept list, so a new instruction file is guarded the moment it
/// exists instead of the moment somebody remembers to register it here.
fn rust_sources() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        let entries = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("auth-header guard: cannot read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("auth-header guard: unreadable dir entry").path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let label = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                let body = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                    panic!("auth-header guard: cannot read {}: {e}", path.display())
                });
                out.push((label, body));
            }
        }
    }
    let root = src_dir();
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    assert!(
        !out.is_empty(),
        "auth-header guard: found no .rs files under {} — the guard would pass vacuously",
        root.display()
    );
    out.sort();
    out
}

/// A run of consecutive comment lines, flattened to one string.
///
/// Blocks are split on any NON-comment line, so prose attached to two
/// different items can never bleed into one window. Blank doc lines (`///`
/// alone) stay INSIDE the block: `mint_entry_token`'s cap table is separated
/// from its `AUTH:` banner by one, and dropping the block there would lose
/// exactly the two numbers most worth pinning.
struct CommentBlock {
    /// 1-based line number of the block's first line.
    line: usize,
    /// Comment text with markers stripped and whitespace runs collapsed.
    text: String,
    /// Whether any line in the block introduces an authority header.
    is_auth: bool,
    /// The block's lines, markers stripped, for precise ban reporting.
    lines: Vec<(usize, String)>,
}

fn comment_blocks(source: &str) -> Vec<CommentBlock> {
    let mut blocks: Vec<CommentBlock> = Vec::new();
    let mut current: Option<CommentBlock> = None;

    for (idx, raw) in source.lines().enumerate() {
        let trimmed = raw.trim_start();
        let content = ["///", "//!", "//"]
            .iter()
            .find_map(|marker| trimmed.strip_prefix(marker));

        match content {
            Some(body) => {
                let body = body.trim();
                let auth_here = is_auth_header_line(body);
                let block = current.get_or_insert_with(|| CommentBlock {
                    line: idx + 1,
                    text: String::new(),
                    is_auth: false,
                    lines: Vec::new(),
                });
                block.is_auth |= auth_here;
                block.lines.push((idx + 1, body.to_string()));
                if !block.text.is_empty() {
                    block.text.push(' ');
                }
                block.text.push_str(body);
            }
            None => {
                if let Some(block) = current.take() {
                    blocks.push(block);
                }
            }
        }
    }
    if let Some(block) = current.take() {
        blocks.push(block);
    }

    for block in &mut blocks {
        block.text = collapse_whitespace(&block.text);
    }
    blocks
}

/// Does this comment line introduce an authority header?
///
/// Both spellings in the tree count: `Auth:` (most instructions) and `Auth (`
/// (the two escalation headers, which qualify the word before the colon).
/// Matched case-insensitively because `burn_entry_token` and
/// `mint_entry_token` shout theirs inside a box-drawn banner.
fn is_auth_header_line(body: &str) -> bool {
    let lowered = body.to_ascii_lowercase();
    lowered
        .match_indices("auth")
        .any(|(at, _)| {
            let rest = lowered[at + 4..].trim_start();
            rest.starts_with(':') || rest.starts_with('(')
        })
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            in_space = true;
        } else {
            if in_space && !out.is_empty() {
                out.push(' ');
            }
            in_space = false;
            out.push(ch);
        }
    }
    out
}

// ──────────────────────────────────────────────────────────────────────────
// Scanning
// ──────────────────────────────────────────────────────────────────────────

/// Action names longest-first, so `MINT_ENTRY_TOKEN` can never be matched
/// inside `MINT_ENTRY_TOKEN_OVER_CAP` (nor `SET_CONTEST_LOCK_TIME` inside
/// `..._REOPEN`, nor `SET_CONTEST_CONCLUSION_TIME` inside `..._AMEND`).
/// Getting this backwards would pin an escalated action to its base action's
/// number and call the disagreement a pass.
fn names_longest_first() -> Vec<(&'static str, u8)> {
    let mut names = ACTION_NAMES.to_vec();
    names.sort_by_key(|(name, _)| std::cmp::Reverse(name.len()));
    names
}

/// Every (action, number) claim in a stretch of comment text.
fn claims_in(text: &str) -> Vec<(&'static str, u8, u8)> {
    let names = names_longest_first();
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0usize;

    while at < bytes.len() {
        let matched = names.iter().find(|(name, _)| text[at..].starts_with(name));
        match matched {
            Some((name, id)) => {
                let end = at + name.len();
                // A name immediately followed by more identifier characters is
                // some longer symbol we do not know; do not read a number off it.
                let boundary_ok = text[end..]
                    .chars()
                    .next()
                    .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
                if boundary_ok {
                    if let Some(value) = number_after(&text[end..]) {
                        found.push((*name, *id, value));
                    }
                }
                at = end;
            }
            None => {
                at += 1;
                while at < bytes.len() && !text.is_char_boundary(at) {
                    at += 1;
                }
            }
        }
    }
    found
}

/// The first signature count stated within `NUMBER_WINDOW` characters, IF the
/// text between the name and that number is nothing but `CLAIM_SEPARATORS` and
/// the word "default".
///
/// Digits and the spelled forms both count: the tree writes "(default 3)",
/// "(3, FLOORED at 3)" and "`SET_GOVERNANCE` (three, floored)", and a guard
/// blind to the spelled form would quietly skip the action that guards the
/// table itself.
fn number_after(rest: &str) -> Option<u8> {
    let window_end = rest
        .char_indices()
        .nth(NUMBER_WINDOW)
        .map_or(rest.len(), |(i, _)| i);
    let window = &rest[..window_end];

    // Walk the gap. Anything outside the allow-list means this name is being
    // USED rather than described, and there is no threshold claim to check.
    let mut gap = window;
    loop {
        let trimmed = gap.trim_start_matches(CLAIM_SEPARATORS);
        let after_word = CLAIM_CONNECTORS
            .iter()
            .find_map(|w| trimmed.strip_prefix(w))
            .unwrap_or(trimmed);
        if after_word.len() == trimmed.len() {
            gap = trimmed;
            break;
        }
        gap = after_word;
    }
    let starts_claim = gap.starts_with(|c: char| c.is_ascii_digit())
        || ["one", "two", "three", "four", "five"]
            .iter()
            .any(|w| word_index(gap, w) == Some(0));
    if !starts_claim {
        return None;
    }
    let window = gap;

    let digit_at = window.find(|c: char| c.is_ascii_digit());
    let spelled = [("one", 1u8), ("two", 2), ("three", 3), ("four", 4), ("five", 5)]
        .into_iter()
        .filter_map(|(word, value)| word_index(window, word).map(|i| (i, value)))
        .min_by_key(|(i, _)| *i);

    match (digit_at, spelled) {
        (Some(d), Some((s, _))) if d < s => digit_value(&window[d..]),
        (Some(_), Some((_, value))) => Some(value),
        (Some(d), None) => digit_value(&window[d..]),
        (None, Some((_, value))) => Some(value),
        (None, None) => None,
    }
}

/// Index of `word` in `text` as a standalone word, case-insensitively.
fn word_index(text: &str, word: &str) -> Option<usize> {
    let lowered = text.to_ascii_lowercase();
    lowered.match_indices(word).find_map(|(at, _)| {
        let before_ok = at == 0
            || !lowered[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        let after = at + word.len();
        let after_ok = lowered[after..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric());
        (before_ok && after_ok).then_some(at)
    })
}

/// Reads the leading digit run. A multi-digit run is NOT a signature count —
/// it is a version, an error code or a section number — so it is ignored
/// rather than truncated to its first digit.
fn digit_value(text: &str) -> Option<u8> {
    let run: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    if run.len() != 1 {
        return None;
    }
    run.parse().ok()
}

/// A literal `N-of-M` written with digits on both sides.
fn n_of_m_in(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    for (at, _) in line.match_indices("-of-") {
        let before = line[..at].chars().next_back()?;
        let after = bytes.get(at + 4).copied()?;
        if before.is_ascii_digit() && after.is_ascii_digit() {
            let start = at - 1;
            let end = at + 5;
            return Some(line[start..end].to_string());
        }
    }
    None
}

// ──────────────────────────────────────────────────────────────────────────
// The assertions
// ──────────────────────────────────────────────────────────────────────────

/// D — the name list covers every live action id.
#[test]
fn action_name_table_is_complete() {
    assert_eq!(
        ACTION_NAMES.len(),
        gov_action::COUNT,
        "auth-header guard: ACTION_NAMES has {} entries but gov_action::COUNT is {}. \
         A new governance action was added without registering its NAME here, so every \
         comment stating that action's threshold is currently unguarded. Add it to \
         ACTION_NAMES.",
        ACTION_NAMES.len(),
        gov_action::COUNT
    );

    let mut seen = vec![false; gov_action::COUNT];
    for (name, id) in ACTION_NAMES {
        let idx = *id as usize;
        assert!(
            idx < gov_action::COUNT,
            "auth-header guard: {name} has id {id}, past gov_action::COUNT"
        );
        assert!(
            !seen[idx],
            "auth-header guard: two names registered for action id {id} ({name})"
        );
        seen[idx] = true;
    }
    let missing: Vec<usize> = seen
        .iter()
        .enumerate()
        .filter_map(|(i, hit)| (!hit).then_some(i))
        .collect();
    assert!(
        missing.is_empty(),
        "auth-header guard: no name registered for action id(s) {missing:?}"
    );
}

/// A — every threshold a comment states matches `DEFAULT_THRESHOLDS`.
#[test]
fn comments_state_the_shipped_thresholds() {
    let mut wrong = Vec::new();
    let mut pinned: Vec<&str> = Vec::new();
    let mut checked = 0usize;

    for (file, body) in rust_sources() {
        if file == GUARD_SOURCE {
            continue;
        }
        for block in comment_blocks(&body) {
            for (name, id, stated) in claims_in(&block.text) {
                checked += 1;
                if !pinned.contains(&name) {
                    pinned.push(name);
                }
                let shipped = DEFAULT_THRESHOLDS[id as usize];
                if stated != shipped {
                    wrong.push(format!(
                        "  {file}:{} — comment says {name} takes {stated}, \
                         DEFAULT_THRESHOLDS ships it at {shipped}",
                        block.line
                    ));
                }
            }
        }
    }

    // ANTI-VACUITY. Assertions that only ever confirm agreement pass just as
    // happily when the scanner has stopped matching anything at all, so the
    // scan has to prove it still has reach before its silence means anything.
    assert!(
        pinned.len() >= 15,
        "auth-header guard: only {} distinct actions are pinned by any comment \
         ({checked} claims total). The scanner has almost certainly stopped matching — \
         a changed comment marker, header shape, or separator — and a scanner that \
         finds nothing passes everything.",
        pinned.len()
    );
    for anchor in ["UNPAUSE", "BURN_ENTRY_TOKEN", "PAUSE"] {
        assert!(
            pinned.contains(&anchor),
            "auth-header guard: nothing pins {anchor}. These three are the actions the \
             two drift incidents were about — burn_entry_token shipped at 3 with a \
             header reading 1-of-3, and unpause claimed pause's authority — so each \
             must keep a checked threshold claim in its own header."
        );
    }

    assert!(
        wrong.is_empty(),
        "auth-header guard: {} comment(s) state an authority the program does not enforce.\n{}\n\n\
         `DEFAULT_THRESHOLDS` in state.rs is the authority — fix the COMMENT, not the table, \
         unless the threshold itself is what you meant to change.",
        wrong.len(),
        wrong.join("\n")
    );
}

/// B — no `Auth` header expresses authority as `N-of-M`.
#[test]
fn auth_headers_state_a_count_not_an_n_of_m() {
    let mut offenders = Vec::new();

    for (file, body) in rust_sources() {
        if file == GUARD_SOURCE {
            continue;
        }
        for block in comment_blocks(&body) {
            if !block.is_auth {
                continue;
            }
            // PARAGRAPH-SCOPED, not block-scoped. One `///` run often documents
            // a whole struct: `grant_seeds`'s Auth header is line 11 and an
            // unrelated, CORRECT "a leaked 1-of-3 key can't mint unbounded
            // seeds" sits at line 28 of the same run. Banning across the block
            // would demand an edit that replaces a true sentence about blast
            // radius with a false one. A blank `///` ends the header.
            let mut in_header = false;
            for (line_no, line) in &block.lines {
                if line.is_empty() {
                    in_header = false;
                    continue;
                }
                in_header |= is_auth_header_line(line);
                if !in_header {
                    continue;
                }
                if let Some(hit) = n_of_m_in(line) {
                    offenders.push(format!("  {file}:{line_no} — \"{hit}\""));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "auth-header guard: {} Auth header line(s) state authority as N-of-M.\n{}\n\n\
         Write the action name and a signature COUNT instead — \
         \"`gov_action::CANCEL_CONTEST` (default 3)\". N rots when a threshold is retuned \
         and M rots on every signer rotation, and neither failure announces itself. \
         (An N-of-M OUTSIDE an Auth header is usually correct — it describes the deployed \
         v0.25 VaultState or the Squads upgrade authority. This ban is header-scoped.)",
        offenders.len(),
        offenders.join("\n")
    );
}

/// C — a floor an `Auth` header claims matches `THRESHOLD_FLOORS`.
#[test]
fn auth_headers_state_the_real_floors() {
    let mut wrong = Vec::new();

    for (file, body) in rust_sources() {
        if file == GUARD_SOURCE {
            continue;
        }
        for block in comment_blocks(&body) {
            if !block.is_auth {
                continue;
            }
            let actions: Vec<(&str, u8)> = claims_in(&block.text)
                .into_iter()
                .map(|(name, id, _)| (name, id))
                .collect();
            // Only a header naming exactly ONE action can have its floor
            // attributed without guessing which action the floor belongs to.
            let Some((name, id)) = actions.first().copied() else {
                continue;
            };
            if actions.iter().any(|(_, other)| *other != id) {
                continue;
            }

            for marker in ["FLOORED at", "FLOOR"] {
                let Some(at) = block.text.find(marker) else {
                    continue;
                };
                let Some(stated) = number_after(&block.text[at + marker.len()..]) else {
                    continue;
                };
                let real = THRESHOLD_FLOORS[id as usize];
                if stated != real {
                    wrong.push(format!(
                        "  {file}:{} — header says {name} is floored at {stated}, \
                         THRESHOLD_FLOORS says {real}",
                        block.line
                    ));
                }
                break;
            }
        }
    }

    assert!(
        wrong.is_empty(),
        "auth-header guard: {} Auth header(s) claim a floor THRESHOLD_FLOORS does not set.\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// E — every handler states the authority it enforces.
///
/// THIS IS THE ASSERTION THAT CATCHES THE WORST SHAPE, and it exists because
/// assertions A-C demonstrably did not. `unpause`'s header read "Same 2-of-3
/// auth as `pause`" — an assertion of SAMENESS with an instruction that takes
/// two where `unpause` takes three, which `DEFAULT_THRESHOLDS` calls "the whole
/// asymmetry". A mutation run restoring that exact line passed A-C green: the
/// sentence names no action (so the pin had nothing to compare) and says "auth
/// as" rather than "Auth:" (so the ban did not consider it a header). The
/// guard would have missed the defect it was written for.
///
/// So the requirement is inverted. Rather than checking the claims a comment
/// happens to make, this reads the `gov_action::*` constants each handler
/// passes to `authorize` IN CODE and demands a checked claim for each. Prose
/// that describes authority by pointing at another instruction now fails for
/// what it OMITS, which no amount of phrasing can talk its way around.
///
/// `governance.rs` is exempt: it DEFINES `authorize` and names actions as
/// examples and floor checks rather than enforcing any one of them.
#[test]
fn every_handler_pins_the_action_it_authorizes() {
    const EXEMPT: &[&str] = &["instructions/governance.rs", "instructions/mod.rs"];
    let names = names_longest_first();
    let mut missing = Vec::new();

    for (file, body) in rust_sources() {
        if !file.starts_with("instructions/") || EXEMPT.contains(&file.as_str()) {
            continue;
        }

        // Actions this file ENFORCES, read from its code lines only.
        let mut enforced: Vec<&str> = Vec::new();
        for raw in body.lines() {
            let trimmed = raw.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            for (at, _) in trimmed.match_indices("gov_action::") {
                let rest = &trimmed[at + "gov_action::".len()..];
                if let Some((name, _)) = names.iter().find(|(n, _)| rest.starts_with(*n)) {
                    let end = name.len();
                    let boundary = rest[end..]
                        .chars()
                        .next()
                        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
                    if boundary && !enforced.contains(name) {
                        enforced.push(name);
                    }
                }
            }
        }
        if enforced.is_empty() {
            continue;
        }

        // Actions this file's comments pin to a number.
        let mut pinned: Vec<&str> = Vec::new();
        for block in comment_blocks(&body) {
            for (name, _, _) in claims_in(&block.text) {
                if !pinned.contains(&name) {
                    pinned.push(name);
                }
            }
        }

        for action in enforced {
            if !pinned.contains(&action) {
                missing.push(format!("  {file} — authorizes on {action}, states no threshold"));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "auth-header guard: {} handler(s) enforce an authority no comment in the file states.\n{}\n\n\
         Give each an Auth header naming the action and its signature COUNT — \
         \"Auth: `gov_action::UNPAUSE` (default 3, IMMOVABLE FLOOR 3)\". Describing the \
         authority by comparison (\"same auth as `pause`\") is what shipped unpause \
         claiming two signatures for an action that takes three.",
        missing.len(),
        missing.join("\n")
    );
}

// ──────────────────────────────────────────────────────────────────────────
// Control checks — the guard has to be able to FAIL
// ──────────────────────────────────────────────────────────────────────────
//
// Assertions A-C pass against a correct tree, which is exactly what a broken
// scanner also does. These four drive the scanner over text that IS wrong and
// prove it says so.

#[test]
fn scanner_catches_a_stale_threshold() {
    let text = collapse_whitespace("Auth: `gov_action::BURN_ENTRY_TOKEN` (default 1).");
    let claims = claims_in(&text);
    assert_eq!(claims.len(), 1, "expected one claim, got {claims:?}");
    let (name, id, stated) = claims[0];
    assert_eq!(name, "BURN_ENTRY_TOKEN");
    assert_eq!(stated, 1);
    assert_ne!(
        stated,
        DEFAULT_THRESHOLDS[id as usize],
        "the pre-fix burn_entry_token header must read as a CONTRADICTION"
    );
}

#[test]
fn scanner_prefers_the_longest_action_name() {
    let text = collapse_whitespace("`gov_action::MINT_ENTRY_TOKEN_OVER_CAP` (3)");
    let claims = claims_in(&text);
    assert_eq!(claims.len(), 1, "expected one claim, got {claims:?}");
    assert_eq!(claims[0].0, "MINT_ENTRY_TOKEN_OVER_CAP");
    assert_eq!(claims[0].2, 3);
}

#[test]
fn scanner_catches_an_n_of_m_header() {
    let block = &comment_blocks("/// Auth: 2-of-3 multisig.\nstruct X;")[0];
    assert!(block.is_auth, "the line must register as an Auth header");
    assert_eq!(
        n_of_m_in(&block.lines[0].1).as_deref(),
        Some("2-of-3"),
        "the pre-fix cancel_contest header must read as a ban violation"
    );
}

#[test]
fn scanner_reads_both_header_spellings_and_ignores_prose_numbers() {
    assert!(is_auth_header_line("Auth: `gov_action::PAUSE` — default 2."));
    assert!(is_auth_header_line(
        "Auth (v0.19 audit #5, re-expressed as data in v0.26):"
    ));
    assert!(is_auth_header_line(
        "── Auth: `gov_action::BURN_ENTRY_TOKEN` (default 3); owner does NOT sign ──"
    ));
    assert!(!is_auth_header_line("Authorization happens in governance.rs"));

    // A name with no number nearby states no threshold, so there is nothing to
    // contradict — governance.rs's `Auth: `SET_GOVERNANCE`.` is exactly this.
    let text = collapse_whitespace(
        "Auth: `SET_GOVERNANCE`. Changing `mint_window_seconds` re-partitions time.",
    );
    assert!(
        claims_in(&text).is_empty(),
        "a bare action name must not pick a number out of the following sentence"
    );

    // A multi-digit run is a version or an error code, never a signature count.
    let text = collapse_whitespace("`gov_action::GRANT_SEEDS` (default 1 — unchanged from v0.25).");
    assert_eq!(claims_in(&text), vec![("GRANT_SEEDS", gov_action::GRANT_SEEDS, 1)]);
}

/// THE MUTATION THAT ESCAPED, kept as a standing control.
///
/// Measured 2026-09-16: with assertions A-C in place and `unpause.rs` restored
/// to its shipped header, the suite ran 8/8 GREEN. This test freezes the two
/// reasons why, so that neither can be "simplified" back into the guard
/// without something failing:
///
///   * the sentence names no action, so THE PIN has nothing to compare, and
///   * it says "auth as", not "Auth:", so THE BAN does not treat it as a
///     header and never looks for the `2-of-3` sitting in plain sight.
///
/// Both blindnesses are correct in isolation — widening either one is what
/// would start flagging the ~180 N-of-M mentions that truthfully describe the
/// deployed v0.25 `VaultState`. The defect is caught by
/// `every_handler_pins_the_action_it_authorizes` instead, which asks what the
/// file OMITS rather than what it says.
#[test]
fn the_sameness_claim_is_invisible_to_the_pin_and_the_ban() {
    const SHIPPED: &str = "Same 2-of-3 auth as `pause` — flipping the switch off needs \
                           the same authority as flipping it on.";

    assert!(
        claims_in(&collapse_whitespace(SHIPPED)).is_empty(),
        "the pin is expected to be blind here — it names no action"
    );
    assert!(
        !is_auth_header_line(SHIPPED),
        "the ban is expected to be blind here — \"auth as\" is not a header"
    );
    assert_eq!(
        n_of_m_in(SHIPPED).as_deref(),
        Some("2-of-3"),
        "the stale arity really is present, which is what makes the blindness matter"
    );

    // And the two numbers it conflates really are different, which is the whole
    // reason a sameness claim cannot be allowed to stand unchecked.
    assert_ne!(
        DEFAULT_THRESHOLDS[gov_action::PAUSE as usize],
        DEFAULT_THRESHOLDS[gov_action::UNPAUSE as usize],
        "pause and unpause must differ — DEFAULT_THRESHOLDS calls it \"the whole asymmetry\""
    );
}
