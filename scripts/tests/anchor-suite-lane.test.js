/**
 * Guard: no CI lane RUNS the Anchor suite, and no CI lane even READS it.
 *
 * WHAT THIS PINS, AND WHY IT IS EXECUTABLE. docs/VERIFICATION_MATRIX.md and
 * README.md both publish the claim that nothing automatic executes
 * tests/turf_vault.ts. That claim was true when it was written and is true
 * today, but it is a claim about .github/workflows/ that lives in prose - so
 * the day someone wires a lane, the prose silently becomes a lie an operator
 * reads before a mainnet upgrade. This file turns the claim into a lane that
 * FAILS on that day and names the sections that must be rewritten.
 *
 * IT ASSERTS THE FACT, NOT THE PROSE. Every check below reads
 * .github/workflows/ and nothing else. Rewording a heading cannot redden the
 * fact tests; only wiring a lane can. (The one test that does read prose is
 * explicitly labelled a POINTER check - see below - and exists so this guard's
 * own citations cannot rot, which is the same disease it was written to treat.)
 *
 * IT PINS TWO FACTS, NOT ONE, AND THE SECOND IS THE FRAGILE ONE.
 *
 *   1. NO LANE RUNS THE SUITE - nothing invokes `anchor test` / ts-mocha.
 *   2. NO LANE READS THE SUITE - nothing subjects tests/turf_vault.ts to a
 *      TypeScript reader either. docs/VERIFICATION_MATRIX.md states this
 *      separately and far more specifically: "A syntax error in this file
 *      reaches `accepted` green."
 *
 * Fact 2 gets its own test because fact 1 does not imply it and cannot protect
 * it. `npm run lint` (Prettier) ALREADY EXISTS in package.json, and README.md
 * lists it under "Deliberately NOT in CI yet" with a stated unblock condition:
 * two scripts are unformatted. Clear those and wiring it is a ONE-LINE addition
 * to the `guards` lane. Measured 2026-09-08 against the checked-in tree:
 *
 *   prettier --file-info tests/turf_vault.ts
 *     -> { "ignored": false, "inferredParser": "typescript" }
 *   the `npm run lint` glob enumerates tests/turf_vault.ts, and reports it as
 *     already unformatted - so that lane would go red ON the suite file.
 *
 * So that one line would make the suite READ, while `## No Lane Runs This
 * Suite` stayed literally true. A guard pinning only fact 1 would sit green
 * while a published, specific claim rotted. Both are pinned, separately, with
 * separate failure messages.
 *
 * THE COMMENT STRIPPER IS LOAD-BEARING. `anchor` appears under
 * .github/workflows/ only inside comments explaining its ABSENCE, and a
 * trailing `# ... anchor test ...` comment sits inside the `run:` value a naive
 * scan reads. A guard that does not strip comments matches the prose explaining
 * why the lane does not exist and is green for the wrong reason. "control: the
 * comment stripper is load-bearing" below fails if stripComments() is blanked.
 *
 * IT CANNOT PASS VACUOUSLY. The real failure mode of a scanner like this is an
 * extractor that returns nothing and reports success. "control: the step
 * extractor sees the real lanes" asserts the extracted surface still contains
 * the four substantive steps this repo's CI runs.
 *
 * Pure Node stdlib (node:test + node:assert), no dependency tree - so it runs
 * in CI's `guards` lane, which deliberately installs nothing.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const WORKFLOWS_REL = ".github/workflows";
const SUITE_PATH = "tests/turf_vault.ts";

// Invocations that EXECUTE the suite. `anchor test` resolves through
// Anchor.toml's [scripts] test, which is ts-mocha over "tests/**/*.ts".
const SUITE_RUNNERS = [
  /\banchor\s+(?:run\s+)?test\b/i,
  /\bts-mocha\b/i,
  /\bmocha\b/i,
];

// Tools that PARSE TypeScript. The repo's TypeScript is migrations/deploy.ts
// and tests/turf_vault.ts; neither is prettier-ignored, and every reader wired
// here today would be invoked over a repo-wide glob. A lane deliberately scoped
// away from tests/ should narrow this guard rather than delete it.
const TS_READERS = [/\btsc\b/i, /\bprettier\b/i, /\beslint\b/i];

// Bare mentions, for the stripper control only. These DO appear under
// .github/workflows/ - inside comments arguing why the lane is absent.
const SUITE_MENTIONS = [/\banchor\b/i, /\bts-mocha\b/i, /\bmocha\b/i];

// Sections that stop being true when a lane is wired. Cited in the failure
// messages, and verified to still exist by the POINTER test below.
const RUNS_SECTIONS = [
  ["docs/VERIFICATION_MATRIX.md", "## No Lane Runs This Suite"],
  ["docs/VERIFICATION_MATRIX.md", "### What it does not cover"],
  ["docs/VERIFICATION_MATRIX.md", "### Re-arming it"],
  ["README.md", "### Continuous integration"],
];
const READS_SECTIONS = [
  ["docs/VERIFICATION_MATRIX.md", "### What it does not cover"],
  ["README.md", "### Continuous integration"],
];

function workflowFiles() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => ({
      rel: WORKFLOWS_REL + "/" + name,
      source: fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8"),
    }));
}

/**
 * Remove YAML comments, quote-aware, preserving line numbers.
 *
 * LOAD-BEARING. A `#` inside quotes is data, not a comment, and a `#` must be
 * at line start or preceded by whitespace to open one.
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

/**
 * The executable surface: every `run:` command and every `uses:` action,
 * including multi-line block scalars (`run: |`).
 */
function executableSteps(lines) {
  const steps = [];
  let block = null;
  for (const line of lines) {
    if (block) {
      if (line.text.trim() === "") continue;
      const indent = line.text.length - line.text.trimStart().length;
      if (indent > block.indent) {
        steps.push({ number: line.number, text: line.text.trim() });
        continue;
      }
      block = null;
    }
    const match = line.text.match(/^(\s*)(-\s+)?(run|uses):\s*(.*)$/);
    if (!match) continue;
    const value = match[4].trim();
    const indent = match[1].length + (match[2] ? match[2].length : 0);
    if (/^[|>][+-]?\d*$/.test(value)) {
      block = { indent: indent };
      continue;
    }
    if (value) steps.push({ number: line.number, text: value });
  }
  return steps;
}

function packageScripts() {
  const file = path.join(REPO_ROOT, "package.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
}

function anchorTestScript() {
  const file = path.join(REPO_ROOT, "Anchor.toml");
  if (!fs.existsSync(file)) return null;
  const section = fs
    .readFileSync(file, "utf8")
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith("scripts]"));
  if (!section) return null;
  const match = section.match(/^\s*test\s*=\s*"((?:[^"\\]|\\.)*)"/m);
  return match ? match[1].replace(/\\"/g, '"') : null;
}

/**
 * Resolve one command into every command it actually causes to run:
 * `npm run <script>` / `yarn <script>` through package.json, and `anchor test`
 * through Anchor.toml. Returns the chain so a failure can show the whole path.
 */
function resolveChain(command) {
  const chain = [{ label: null, text: command }];
  const scripts = packageScripts();

  const npmRun = command.match(
    /\b(?:npm|pnpm)\s+(?:run|run-script)\s+([\w:.-]+)/i
  );
  const npmBare = command.match(/\b(?:npm|pnpm)\s+(test|start)\b/i);
  const yarnRun = command.match(/\byarn\s+(?:run\s+)?([\w:.-]+)/i);
  const name =
    (npmRun && npmRun[1]) ||
    (npmBare && npmBare[1]) ||
    (yarnRun && yarnRun[1]) ||
    null;

  if (name && Object.prototype.hasOwnProperty.call(scripts, name)) {
    chain.push({ label: "package.json scripts." + name, text: scripts[name] });
  }

  if (chain.some((link) => /\banchor\s+(?:run\s+)?test\b/i.test(link.text))) {
    const anchorScript = anchorTestScript();
    if (anchorScript) {
      chain.push({ label: "Anchor.toml [scripts] test", text: anchorScript });
    }
  }

  return chain;
}

function findOffenders(patterns) {
  const offenders = [];
  for (const workflow of workflowFiles()) {
    const steps = executableSteps(stripComments(workflow.source));
    for (const step of steps) {
      const chain = resolveChain(step.text);
      const matched = patterns.find((pattern) =>
        chain.some((link) => pattern.test(link.text))
      );
      if (matched) {
        offenders.push({ file: workflow.rel, line: step.number, chain });
      }
    }
  }
  return offenders;
}

function describe(offenders) {
  return offenders
    .map((hit) => {
      const lines = [`  ${hit.file}:${hit.line}`];
      for (const link of hit.chain) {
        lines.push(
          link.label
            ? `      -> ${link.label}: ${link.text}`
            : `      ${link.text}`
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

function sectionList(sections) {
  return sections.map(([file, heading]) => `  ${file}  ${heading}`).join("\n");
}

test("no CI lane runs the Anchor suite", () => {
  const offenders = findOffenders(SUITE_RUNNERS);
  assert.equal(
    offenders.length,
    0,
    [
      "",
      `A workflow step now RUNS ${SUITE_PATH}. That is good news for this repo`,
      "and bad news for its documentation: prose written while it was true is",
      "now false, and an operator reads that prose before a mainnet upgrade.",
      "",
      describe(offenders),
      "",
      "Rewrite these in the SAME change, then update this guard:",
      sectionList(RUNS_SECTIONS),
      "",
      'docs/VERIFICATION_MATRIX.md "### Re-arming it" says it explicitly:',
      'delete the whole "## No Lane Runs This Suite" SECTION, not just the',
      '"### Re-arming it" sub-subsection, and rewrite the bullets under',
      '"### What it does not cover" that rest on it.',
      "",
    ].join("\n")
  );
});

test("no CI lane even reads the Anchor suite", () => {
  const offenders = findOffenders(TS_READERS);
  assert.equal(
    offenders.length,
    0,
    [
      "",
      `A workflow step now subjects ${SUITE_PATH} to a TypeScript reader.`,
      "",
      describe(offenders),
      "",
      "This is a SEPARATE fact from whether a lane RUNS the suite, and it has",
      "its own published claim. docs/VERIFICATION_MATRIX.md states, under",
      '"### What it does not cover":',
      "",
      "    **No lane even reads the suite.** ... A syntax error in this file",
      "    reaches `accepted` green.",
      "",
      "If the step above parses the suite, that sentence is now false even",
      'though "## No Lane Runs This Suite" may still be true. Rewrite:',
      sectionList(READS_SECTIONS),
      "",
      "If the lane is genuinely scoped away from tests/, narrow TS_READERS or",
      "the scope check here rather than deleting the test.",
      "",
    ].join("\n")
  );
});

test("control: the comment stripper is load-bearing", () => {
  const workflows = workflowFiles();
  assert.ok(
    workflows.length > 0,
    `no workflow files found under ${WORKFLOWS_REL}/ - this guard is inert`
  );

  const raw = [];
  const stripped = [];
  for (const workflow of workflows) {
    const strippedText = stripComments(workflow.source)
      .map((line) => line.text)
      .join("\n");
    for (const pattern of SUITE_MENTIONS) {
      if (pattern.test(workflow.source)) raw.push(`${workflow.rel} ${pattern}`);
      if (pattern.test(strippedText)) {
        stripped.push(`${workflow.rel} ${pattern}`);
      }
    }
  }

  assert.ok(
    raw.length > 0,
    [
      "",
      `No suite token appears anywhere under ${WORKFLOWS_REL}/, not even in a`,
      "comment. The stripper then removes nothing, and the two fact tests above",
      "would pass whether or not it works. Point SUITE_MENTIONS at a token the",
      "workflows really do carry, or retire this control deliberately.",
      "",
    ].join("\n")
  );

  assert.deepEqual(
    stripped,
    [],
    [
      "",
      "A suite token survived comment stripping:",
      "",
      stripped.map((hit) => `  ${hit}`).join("\n"),
      "",
      "Either stripComments() stopped working - in which case the two fact",
      "tests above are matching prose rather than commands and this control is",
      "doing its job - or a workflow gained a real, uncommented reference to",
      "the suite, which the fact tests should have caught first.",
      "",
    ].join("\n")
  );
});

test("control: the step extractor sees the real lanes", () => {
  const steps = [];
  for (const workflow of workflowFiles()) {
    for (const step of executableSteps(stripComments(workflow.source))) {
      steps.push(step.text);
    }
  }

  // The four substantive steps README.md and docs/VERIFICATION_MATRIX.md name.
  // An extractor that silently returned nothing would make every scan above
  // pass vacuously; this is what stops that.
  const expected = [
    /\bcargo check\b/,
    /\bcargo clippy\b/,
    /\bnpm run check:doc-op-refs\b/,
    /\bnpm run test:scripts\b/,
  ];
  const missing = expected.filter(
    (pattern) => !steps.some((step) => pattern.test(step))
  );

  assert.deepEqual(
    missing,
    [],
    [
      "",
      "The step extractor no longer sees CI's substantive steps:",
      "",
      missing.map((pattern) => `  ${pattern}`).join("\n"),
      "",
      `It extracted ${steps.length} step(s) in total. If CI genuinely dropped a`,
      "step, update this control AND the CI tables in README.md and",
      "docs/VERIFICATION_MATRIX.md. If CI still runs it, executableSteps() is",
      "broken and every scan in this file is passing vacuously.",
      "",
    ].join("\n")
  );
});

test("premise: the suite is reachable by a repo-wide TypeScript reader", () => {
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, SUITE_PATH)),
    `${SUITE_PATH} is gone - this whole guard is about that file`
  );

  const ignoreFile = path.join(REPO_ROOT, ".prettierignore");
  const entries = fs.existsSync(ignoreFile)
    ? fs
        .readFileSync(ignoreFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];

  const suiteDir = SUITE_PATH.split("/")[0];
  const excluded = entries.filter((entry) => {
    const bare = entry.replace(/^\/+/, "").replace(/\/+$/, "");
    return (
      bare === suiteDir || bare === SUITE_PATH || bare === suiteDir + "/**"
    );
  });

  assert.deepEqual(
    excluded,
    [],
    [
      "",
      `.prettierignore now excludes ${SUITE_PATH}:`,
      "",
      excluded.map((entry) => `  ${entry}`).join("\n"),
      "",
      'That weakens "no CI lane even reads the Anchor suite" above: wiring',
      "`npm run lint` would no longer read the suite, so the reader test would",
      "no longer be the tripwire it is documented to be. Re-derive TS_READERS",
      "against whatever readers remain, and say so in",
      'docs/VERIFICATION_MATRIX.md "### What it does not cover".',
      "",
    ].join("\n")
  );
});

test("pointer: the sections this guard cites still exist", () => {
  // The ONLY prose-reading test here, and deliberately separate from the facts.
  // Rewording a heading must not redden a fact - the fact has not changed - but
  // it MUST redden something, or this guard's failure messages quietly start
  // citing headings that no longer exist. That is the same stale-pointer
  // disease this guard was written to treat.
  const cited = [...RUNS_SECTIONS, ...READS_SECTIONS];
  const seen = new Set();
  const missing = [];

  for (const [file, heading] of cited) {
    const key = file + " " + heading;
    if (seen.has(key)) continue;
    seen.add(key);

    const full = path.join(REPO_ROOT, file);
    if (!fs.existsSync(full)) {
      missing.push(`${file} (file not found)  ${heading}`);
      continue;
    }
    const found = fs
      .readFileSync(full, "utf8")
      .split("\n")
      .some((line) => line.trim() === heading);
    if (!found) missing.push(`${file}  ${heading}`);
  }

  assert.deepEqual(
    missing,
    [],
    [
      "",
      "This guard's failure messages cite headings that no longer exist:",
      "",
      missing.map((entry) => `  ${entry}`).join("\n"),
      "",
      "The FACTS above are unaffected - a reword changes no lane. But a guard",
      "that names a section an operator cannot find is the next stale pointer.",
      "Update RUNS_SECTIONS / READS_SECTIONS in this file to the new headings.",
      "",
    ].join("\n")
  );
});
