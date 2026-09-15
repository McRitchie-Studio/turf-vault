/**
 * Guard: the crate version must not still claim the last RELEASED version while
 * `## [Unreleased]` carries work.
 *
 * WHY THIS EXISTS (2026-09-15, measured — not hypothesised). `accepted` carried the
 * v0.26 five-signer governance rewrite (73bdd85c) and the username registry
 * (f3edc881) while `programs/turf_vault/Cargo.toml` still read `version = "0.25.0"`
 * — the exact version CHANGELOG.md's newest dated heading already claimed, and the
 * version both clusters were running on chain.
 *
 * THAT IS DANGEROUS RATHER THAN UNTIDY, because `anchor idl build` stamps
 * `metadata.version` straight from that file. An IDL built from the NEW program was
 * therefore byte-labelled identically to one built from the OLD one, so a consumer
 * asking "which program is this?" got a PLAUSIBLE WRONG ANSWER instead of no answer.
 * Anchor account lists are POSITIONAL, so picking the wrong shape does not fail at
 * the call site: the program reads slot 2 as a different account type and rejects —
 * or a guard inspects the wrong account and reports a PASS. That second case already
 * happened once in this repo (`assert_entry_cosign_safe!` read a hard-coded index
 * that `governance` shifted). See /tasks/cargo-version-lies-about-program.
 *
 * WHAT THIS GUARD DOES *NOT* CLAIM. It cannot tell that the IDL changed — that would
 * need a build, which is the `program` lane's job and takes minutes. It asserts the
 * weaker, cheap, and exactly-violated property:
 *
 *     unreleased work on the tree  =>  the crate version is already AHEAD of the
 *                                      newest dated CHANGELOG release
 *
 * That is enough, because the failure mode is not "someone bumped it wrong", it is
 * "nobody bumped it at all" — and the tree announces unreleased work in prose long
 * before anyone thinks about the crate version.
 *
 * A VERSION IS STILL A DECLARATION, NEVER A MEASUREMENT. Passing this guard does not
 * make a version check safe to branch on: it is true only because someone wrote it
 * down. Every probe that selects an account shape stays STRUCTURAL — it asks the
 * chain for the account that actually differs (`scripts/tests/vault-console.test.js`,
 * "the program shape is detected structurally, never from a version string"), and
 * `bin/deploy` gates on the IDL's sha256, which is a measurement of bytes. This guard
 * keeps the label honest for humans and for `docs/CURRENT_DEPLOYMENT.md`; it does not
 * promote the label to a control.
 *
 * TWO HEADINGS NAMED "Unreleased" EXIST IN CHANGELOG.md. The live one is the bare
 * `## [Unreleased]` at the top; there is also a historical, DATED
 * `## [Unreleased] - 2026-05-18 (post-v0.11.0)` mid-file. The parser below matches
 * the bare form only, and reads release headings as `## [X.Y.Z] - ...`, so neither
 * can be mistaken for the other. A control below plants exactly that shape.
 *
 * TWO STATES ARE LEGAL, AND A RELEASE CUT IS THE SECOND ONE. Cutting a release in
 * this repo RENAMES `## [Unreleased]` to `## [X.Y.Z] - <date>`; it does not empty it.
 * Measured at 84aed504 (the v0.25.0 cut): ZERO bare `## [Unreleased]` headings
 * survived, and the crate correctly read the freshly cut `0.25.0`. So:
 *
 *     mid-cycle   bare [Unreleased] present, with content   crate > newest release
 *     just cut    no bare [Unreleased] at all               crate == newest release
 *
 * An earlier revision of this file asserted the real `[Unreleased]` body was non-empty
 * as though that were invariant. It is not — it is the mid-cycle state only. That
 * assertion reddened a CORRECT tree at every release cut (reproduced against
 * 84aed504: `pass 7, fail 1`), and said "the parser found the wrong heading" while
 * the parser was working perfectly. The trigger would have been cutting v0.26.0 — the very upgrade window
 * this change exists to enable. A guard that reddens exactly when you are doing the
 * thing it was written for is worse than no guard, so the control below no longer
 * asserts which state the tree is in.
 *
 * NOTE THAT ASSERTING THE HEADING MERELY *EXISTS* FIXES NOTHING: at a cut it does not
 * exist either. What the control actually has to do is prove the parser is WIRED to
 * the real file without predicting what it will find — so it compares the parser
 * against a SECOND, INDEPENDENT reading of the same bytes, and asserts capability
 * separately against a fixture, where a body is guaranteed to exist.
 *
 * IT CANNOT PASS VACUOUSLY. The predicate is exercised over synthetic CHANGELOGs
 * carrying the historical defect, the clean case, the just-released case and the real
 * release-cut shape, so the detector is proven to bite without needing the real tree
 * to be broken.
 *
 * Pure Node stdlib (node:test + node:assert), no dependency tree.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const CARGO_TOML = path.join(ROOT, "programs", "turf_vault", "Cargo.toml");
const CARGO_LOCK = path.join(ROOT, "Cargo.lock");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

// ── parsing ──────────────────────────────────────────────────────────────────

/** The `version` of the `[package]` table — not a dependency's, which also matches
 *  `version = "…"`. Anchored to the first table so a dependency bump cannot move it. */
function crateVersion(toml) {
  const pkg = toml.split(/^\[/m)[1]; // text of the first table: `package]\n…`
  assert.ok(/^package\]/.test(pkg), "Cargo.toml's first table is no longer [package]");
  const m = pkg.match(/^\s*version\s*=\s*"([^"]+)"/m);
  assert.ok(m, "no version key in Cargo.toml's [package] table");
  return m[1];
}

/** The locked version of the workspace member itself. */
function lockedVersion(lock, name) {
  const m = lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`));
  assert.ok(m, `Cargo.lock has no [[package]] entry for ${name}`);
  return m[1];
}

/** Newest DATED release heading, e.g. `## [0.25.0] - 2026-06-10` -> "0.25.0".
 *  `[Unreleased]` never matches, dated or not, because it is not a version triple. */
function latestReleased(changelog) {
  const m = changelog.match(/^## \[(\d+\.\d+\.\d+)\]\s+-\s+\d{4}-\d{2}-\d{2}/m);
  assert.ok(m, "CHANGELOG.md carries no dated release heading");
  return m[1];
}

/** Body of the LIVE `## [Unreleased]` section — the bare heading, never the dated
 *  historical one — up to the next `## ` heading. "" when there is no such section. */
function unreleasedBody(changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * The same section read a DIFFERENT way: split the file on its `## ` headings and pick
 * the section whose heading line is exactly `[Unreleased]`. Shares no code path with
 * `unreleasedBody` above, so agreement between the two is real evidence that neither
 * is silently returning nothing. (It skips the dated historical heading for free: that
 * heading line is not exactly `[Unreleased]`.)
 */
function unreleasedBodyBySplit(changelog) {
  for (const section of changelog.split(/^## /m)) {
    const nl = section.indexOf("\n");
    if (nl === -1) continue;
    if (section.slice(0, nl).trim() === "[Unreleased]") return section.slice(nl + 1).trim();
  }
  return "";
}

/** `## ` headings naming Unreleased in a form `unreleasedBody` cannot match — anything
 *  but the live `## [Unreleased]` or the dated historical `## [Unreleased] - <date>`.
 *  A near-miss is SILENT: both readings return "", so they AGREE and `refusal` takes
 *  its nothing-unreleased branch while the tree carries the defect this guards. */
function strayUnreleasedHeadings(changelog) {
  return changelog
    .split("\n")
    .filter((l) => /^## .*[Uu]nreleased/.test(l))
    .filter((l) => !/^## \[Unreleased\]$/.test(l) && !/^## \[Unreleased\] - \d{4}-\d{2}-\d{2}/.test(l));
}

function semverParts(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(m, `not a semver triple: ${v}`);
  return m.slice(1, 4).map(Number);
}

/** true when a > b */
function isAhead(a, b) {
  const [x, y, z] = semverParts(a);
  const [p, q, r] = semverParts(b);
  return x !== p ? x > p : y !== q ? y > q : z > r;
}

// ── the predicate, over any pair of documents ────────────────────────────────

/**
 * Returns a refusal string, or null when the pair is consistent. Split out from the
 * real-tree test so the controls below can run it over planted documents.
 */
function refusal(version, changelog) {
  const released = latestReleased(changelog);
  if (unreleasedBody(changelog) === "") {
    // Nothing unreleased: the crate may legitimately still name the last release.
    return isAhead(released, version)
      ? `crate version ${version} is BEHIND the newest release ${released}`
      : null;
  }
  if (version === released) {
    return (
      `programs/turf_vault/Cargo.toml still declares ${version}, which is the ` +
      `version CHANGELOG.md already released — while [Unreleased] carries work. ` +
      `anchor idl build stamps metadata.version from that file, so an IDL built ` +
      `from this tree would be labelled identically to the released program. Bump ` +
      `the crate version (and Cargo.lock) to the version this work will ship as.`
    );
  }
  if (!isAhead(version, released)) {
    return `crate version ${version} is not ahead of the newest release ${released}`;
  }
  return null;
}

// ── the real tree ────────────────────────────────────────────────────────────

test("the crate version is ahead of the newest release while work is unreleased", () => {
  const version = crateVersion(fs.readFileSync(CARGO_TOML, "utf8"));
  const changelog = fs.readFileSync(CHANGELOG, "utf8");
  assert.equal(refusal(version, changelog), null);
});

test("Cargo.lock's own entry agrees with Cargo.toml", () => {
  // `cargo check --locked` is the authoritative check and would refuse the mismatch
  // too — but only after a Rust compile, on the other CI job. This names it in the
  // sub-second Node lane, where a bump that forgot the lockfile is one edit away.
  const version = crateVersion(fs.readFileSync(CARGO_TOML, "utf8"));
  const locked = lockedVersion(fs.readFileSync(CARGO_LOCK, "utf8"), "turf_vault");
  assert.equal(locked, version, "Cargo.lock names a different turf_vault version than Cargo.toml");
});

test("the guard is WIRED to the real file — two independent readings agree", () => {
  // If `unreleasedBody` silently returned "" forever, `refusal` would always take the
  // empty branch and the main invariant would never be enforced. This catches that
  // WITHOUT predicting which lifecycle state the tree is in: mid-cycle both readings
  // return the same body, and at a release cut both return "". A parser broken in the
  // way that matters disagrees with the independent reading the moment a section
  // exists — which is the only moment the disagreement could cost anything.
  const changelog = fs.readFileSync(CHANGELOG, "utf8");
  assert.match(latestReleased(changelog), /^\d+\.\d+\.\d+$/, "no dated release heading in the shipped CHANGELOG");
  assert.equal(
    unreleasedBody(changelog),
    unreleasedBodyBySplit(changelog),
    "the two readings of the live [Unreleased] section disagree — one of them is broken"
  );
  assert.deepEqual(
    strayUnreleasedHeadings(changelog),
    [],
    "a heading names Unreleased in a form the parser cannot match — measured 2026-09-15: with " +
      "`## Unreleased` or `## [Unreleased] (next: …)` and the crate un-bumped, this file ran 9/9 GREEN"
  );
});

test("both readings CAN find a body — capability, independent of the tree's state", () => {
  // The half the wiring control above deliberately does not assert. Proven against a
  // fixture, where a section is guaranteed to exist, so it holds at a release cut too.
  const fixture = changelogFixture("### Added\n\n- A real entry.");
  assert.match(unreleasedBody(fixture), /A real entry\./);
  assert.match(unreleasedBodyBySplit(fixture), /A real entry\./);
  assert.equal(unreleasedBody(fixture), unreleasedBodyBySplit(fixture));
});

// ── controls: the detector must bite ─────────────────────────────────────────

const RELEASED_SECTIONS = [
  "## [0.25.0] - 2026-06-10",
  "",
  "Admin-authorized username flows.",
  "",
  // The historical DATED Unreleased heading that really sits mid-file. It must not
  // be mistaken for the live section, in either direction.
  "## [Unreleased] - 2026-05-18 (post-v0.11.0)",
  "",
  "A historical section that happens to be named Unreleased.",
  "",
  "## [0.11.0] - 2026-05-18",
  "",
  "Older work.",
].join("\n");

function changelogFixture(unreleased) {
  return ["# Changelog", "", "## [Unreleased]", "", unreleased, "", RELEASED_SECTIONS].join("\n");
}

test("the historical defect is REFUSED", () => {
  // Exactly the 2026-09-15 tree: unreleased governance work, crate still 0.25.0.
  const r = refusal("0.25.0", changelogFixture("### Added\n\n- The five-signer governance rewrite."));
  assert.ok(r, "the planted defect was not detected");
  assert.match(r, /still declares 0\.25\.0/);
  assert.match(r, /anchor idl build stamps metadata\.version/);
});

test("a bumped crate version PASSES with the same unreleased work", () => {
  assert.equal(
    refusal("0.26.0", changelogFixture("### Added\n\n- The five-signer governance rewrite.")),
    null
  );
});

test("an empty [Unreleased] PASSES while the crate names the last release", () => {
  // The moment after a release: nothing unreleased, so 0.25.0 is the honest label.
  assert.equal(refusal("0.25.0", changelogFixture("")), null);
});

test("a crate version BEHIND the newest release is refused either way", () => {
  assert.match(refusal("0.24.0", changelogFixture("")), /BEHIND the newest release 0\.25\.0/);
  assert.match(refusal("0.24.0", changelogFixture("- work")), /not ahead of the newest release/);
});

test("a RELEASE CUT passes — the heading is renamed away, not emptied", () => {
  // The shape measured at 84aed504, and the state the earlier control got wrong: the
  // live section is GONE (renamed to the dated heading) and the crate names the
  // freshly cut version. This must be a clean pass, through `refusal` and not merely
  // through the parser, because cutting v0.26.0 is the next thing anyone does here.
  const cut = ["# Changelog", "", RELEASED_SECTIONS].join("\n");
  assert.equal(unreleasedBody(cut), "", "a renamed-away section must read as nothing unreleased");
  assert.equal(unreleasedBodyBySplit(cut), "");
  assert.equal(latestReleased(cut), "0.25.0");
  assert.equal(refusal("0.25.0", cut), null, "a correct release cut was REFUSED");

  // The dated historical `## [Unreleased] - 2026-05-18` heading is inside that
  // fixture, so this doubles as the proof it is never mistaken for the live section —
  // picking it up would make the empty-section branch unreachable on the real file.
  assert.match(RELEASED_SECTIONS, /^## \[Unreleased\] - 2026-05-18/m);

  // A near-miss FORM reaches that same empty branch from a tree that is NOT at a cut and
  assert.deepEqual(strayUnreleasedHeadings(cut), [], "the dated historical heading is legal");
  for (const bad of ["## Unreleased", "## [Unreleased] (next: v0.26)"]) {
    const planted = ["# Changelog", "", bad, "", "- work", "", RELEASED_SECTIONS].join("\n");
    assert.equal(refusal("0.25.0", planted), null, "precondition: the near-miss passes vacuously");
    assert.equal(strayUnreleasedHeadings(planted).length, 1, `not named: ${bad}`);
  }
});
