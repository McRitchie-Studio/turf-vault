/**
 * Guard: bin/release-check runs EXACTLY the gate lanes .github/workflows/ci.yml
 * runs — no fewer, and no more.
 *
 * WHY THIS EXISTS (2026-09-14). bin/release-check is what a local cert executes:
 * mcritchie-studio's config/release_repos.yml names it on the turf-vault row
 * (`release_check: bin/release-check`), so the hub's bin/fast-check and
 * bin/full-suite-check run THIS script as the whole gate for this repo. Before it
 * existed, that row spelled the four lanes out as a hub-side `&&` chain — a copy of
 * this repo's CI kept in another repo. Moving the definition here removes the copy,
 * but it does NOT by itself remove the duplication: the lanes are still written
 * twice, once in ci.yml and once in the script's LANES table.
 *
 * THE DUPLICATION IS DELIBERATE AND THIS FILE IS ITS PRICE. CI runs `guards` and
 * `program` as two parallel jobs with separate runners and a Rust-only cache; a
 * single job calling the script would serialise the sub-second Node lanes behind a
 * cold Rust compile and collapse four named steps into one log. So the two stay
 * separate and this test makes them agree — and, unlike the hub-side tripwire it
 * replaces, it needs no particular checkout on disk: it is pure `node:test`, so it
 * runs in CI's own `guards` lane (`npm run test:scripts`) on every push and PR, and
 * bin/release-check runs it too.
 *
 * DRIFT IN EITHER DIRECTION IS A REAL DEFECT, so both are asserted:
 *   * A lane in CI and not in the script = the local cert covers LESS than the
 *     verdict it is credited against. That is the direction that cost: it is how a
 *     builder certifies green against a gate that never ran the lane that would have
 *     failed.
 *   * A lane in the script and not in CI = a gate `accepted` is never held to. The
 *     script is what a builder runs before a PR; CI is what the PR is judged by.
 *     A lane only one of them has is a lane nobody can trust.
 *
 * IT READS COMMANDS, NOT PROSE. The workflow is comment-stripped and its `run:`
 * values (including block scalars) are extracted before anything is compared, so
 * rewording ci.yml's commentary — which argues at length about lanes it deliberately
 * does NOT run, `anchor build` and `-D warnings` among them — cannot move this
 * verdict. The extraction shape is the one scripts/tests/anchor-suite-lane.test.js
 * established in this repo for the same reason.
 *
 * IT CANNOT PASS VACUOUSLY. Two controls below fail if the machinery stops working:
 * one asserts the real ci.yml still yields the lanes this repo is known to run, and
 * one runs the whole comparison over a SYNTHETIC workflow carrying a planted
 * mismatch, a commented-out lane and a lane inside a block scalar — so the detector
 * is proven to bite without needing the real tree to be broken.
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
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_REL = "bin/release-check";
const SCRIPT = path.join(REPO_ROOT, SCRIPT_REL);
const CI_REL = ".github/workflows/ci.yml";
const CI = path.join(REPO_ROOT, CI_REL);

/**
 * WHAT COUNTS AS A GATE LANE — a command that can fail on this repo's code.
 *
 * `npm run <script>` (and the yarn spelling) is one: package.json is where this
 * repo's checks live. A bare `cargo <subcommand>` is one: check, clippy, test, fmt
 * all read the tree. An INFORMATIONAL invocation is not, and the flag is what tells
 * them apart — `cargo --version` and `rustup show active-toolchain` print a version
 * and cannot fail on a program change, so a `-` where a subcommand would be excludes
 * them. Setup steps (`npm ci`, `actions/*`) are not gate lanes either.
 */
const GATE_RE =
  /^(?:(?:npm|pnpm|yarn)\s+run\s+[\w:.-]+|(?:npm|pnpm|yarn)\s+test\b|cargo\s+[a-z][\w-]*)/;

/**
 * Remove YAML comments, quote-aware, preserving line numbers. A `#` inside quotes is
 * data; a `#` opens a comment only at line start or after whitespace.
 */
function stripComments(source) {
  return source.split("\n").map((raw, index) => {
    let out = "";
    let quote = null;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quote) {
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) break;
      out += ch;
    }
    return { number: index + 1, text: out };
  });
}

/** Every `run:` command in a workflow, including multi-line block scalars. */
function runCommands(source) {
  const commands = [];
  let block = null;
  for (const line of stripComments(source)) {
    if (block) {
      if (line.text.trim() === "") continue;
      const indent = line.text.length - line.text.trimStart().length;
      if (indent > block.indent) {
        commands.push({ number: line.number, text: line.text.trim() });
        continue;
      }
      block = null;
    }
    const match = line.text.match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const value = match[3].trim();
    const indent = match[1].length + (match[2] ? match[2].length : 0);
    if (/^[|>][+-]?\d*$/.test(value)) {
      block = { indent: indent };
      continue;
    }
    if (value) commands.push({ number: line.number, text: value });
  }
  return commands;
}

/** The gate lanes a workflow runs, in file order, de-duplicated. */
function ciLanes(source) {
  const seen = new Set();
  const lanes = [];
  for (const command of runCommands(source)) {
    if (!GATE_RE.test(command.text)) continue;
    if (seen.has(command.text)) continue;
    seen.add(command.text);
    lanes.push(command);
  }
  return lanes;
}

/**
 * The lanes the script will really run — asked of the SCRIPT, not read out of its
 * source. `--list` prints its LANES table verbatim, so a lane the table declares but
 * the runner never reaches (or the reverse) cannot hide behind a text match.
 */
function scriptLanes() {
  const out = execFileSync(SCRIPT, ["--list"], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function readCi() {
  return fs.readFileSync(CI, "utf8");
}

test("bin/release-check exists and is executable", () => {
  assert.ok(
    fs.existsSync(SCRIPT),
    [
      "",
      `${SCRIPT_REL} is gone. mcritchie-studio's config/release_repos.yml names it on`,
      "the turf-vault row, so the hub's bin/fast-check and bin/full-suite-check have",
      "nothing to run and every local cert for this repo fails COULD NOT RUN.",
      "",
    ].join("\n")
  );

  const mode = fs.statSync(SCRIPT).mode;
  assert.ok(
    (mode & 0o111) !== 0,
    [
      "",
      `${SCRIPT_REL} has lost its executable bit (mode ${(
        mode & 0o777
      ).toString(8)}).`,
      "The hub spawns it as a command, not through an interpreter, so it would die",
      "EACCES — a cert failure that looks nothing like its cause.",
      "",
    ].join("\n")
  );
});

test("every gate lane CI runs is a lane bin/release-check runs", () => {
  const declared = scriptLanes();
  const missing = ciLanes(readCi()).filter(
    (lane) => !declared.includes(lane.text)
  );

  assert.deepEqual(
    missing.map((lane) => `${CI_REL}:${lane.number}  ${lane.text}`),
    [],
    [
      "",
      `CI runs lane(s) that ${SCRIPT_REL} does not:`,
      "",
      missing.map((lane) => `  ${lane.text}`).join("\n"),
      "",
      "The local cert therefore covers LESS than the CI verdict it is credited",
      `against. Add each one to the LANES table in ${SCRIPT_REL} — verbatim, so this`,
      "comparison stays exact and a changed flag cannot slip through.",
      "",
    ].join("\n")
  );
});

test("bin/release-check runs no gate lane CI does not", () => {
  const onCi = ciLanes(readCi()).map((lane) => lane.text);
  const extra = scriptLanes().filter((lane) => !onCi.includes(lane));

  assert.deepEqual(
    extra,
    [],
    [
      "",
      `${SCRIPT_REL} runs lane(s) ${CI_REL} does not:`,
      "",
      extra.map((lane) => `  ${lane}`).join("\n"),
      "",
      "A lane only the script has is a gate `accepted` is never held to: a builder",
      "pays for it locally and nothing enforces it on the branch that ships. Either",
      "wire it into ci.yml's `guards` or `program` job, or take it out of the table.",
      "",
    ].join("\n")
  );
});

test("control: the ci.yml reader still sees this repo's real lanes", () => {
  const lanes = ciLanes(readCi()).map((lane) => lane.text);

  assert.ok(
    lanes.length >= 4,
    [
      "",
      `Only ${
        lanes.length
      } gate lane(s) extracted from ${CI_REL}: ${JSON.stringify(lanes)}`,
      "",
      "This repo runs four. An extractor that returns little or nothing makes the two",
      "comparisons above pass by finding nothing to compare — the failure mode a",
      "scanner like this actually has. Fix the reader, or update this count",
      "deliberately if CI genuinely changed shape.",
      "",
    ].join("\n")
  );

  for (const expected of [
    "check:doc-op-refs",
    "test:scripts",
    "cargo check",
    "cargo clippy",
  ]) {
    assert.ok(
      lanes.some((lane) => lane.includes(expected)),
      `${CI_REL} no longer appears to run ${expected} — re-derive this control before trusting the lanes above`
    );
  }
});

test("control: the comparison bites on a planted mismatch", () => {
  // A SYNTHETIC workflow, never the real one, so this control proves the detector
  // without needing the tree to be broken. It carries the three shapes that have to
  // be handled correctly: a commented-out lane (must be invisible), a lane inside a
  // block scalar (must be seen), and an informational `cargo --version` (must not be
  // mistaken for a gate).
  const synthetic = [
    "jobs:",
    "  guards:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      # - run: npm run lint   # deliberately not a lane yet",
    "      - run: npm run check:doc-op-refs",
    "      - run: |",
    "          cargo fmt --all -- --check",
    "      - run: cargo --version",
  ].join("\n");

  const lanes = ciLanes(synthetic).map((lane) => lane.text);

  assert.deepEqual(
    lanes,
    ["npm run check:doc-op-refs", "cargo fmt --all -- --check"],
    "the extractor must see the block-scalar lane, skip the commented-out one, and " +
      "not mistake `cargo --version` for a gate"
  );

  const declared = ["npm run check:doc-op-refs"];
  const missing = lanes.filter((lane) => !declared.includes(lane));
  assert.deepEqual(
    missing,
    ["cargo fmt --all -- --check"],
    "a lane CI runs and the script does not must be reported as missing — if this is " +
      "empty, the comparison the two tests above perform cannot fail"
  );
});
