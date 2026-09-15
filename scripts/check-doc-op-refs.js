#!/usr/bin/env node
/**
 * check-doc-op-refs — every `op://` reference in this repo's prose must still
 * resolve.
 *
 * WHY THIS EXISTS (2026-08-29, measured — not hypothesised). The 1Password
 * vault was renamed `agents` -> `agents-studio` on 2026-08-28. Three commands
 * in docs/MAINNET_LAUNCH.md still named `agents`, so a mainnet launch run from
 * that runbook dies at
 *
 *     [ERROR] could not read secret 'op://agents/agent.helius/Mainnet RPC URL':
 *     "agents" isn't a vault in this account.
 *
 * A runbook is executable text. Nobody runs it until the one day it matters,
 * which is the worst possible day to discover a stale credential path — so the
 * reference is checked by a command instead of by whoever last read the file.
 *
 * TWO FAILURE MODES, and the second is the one prose review misses:
 *
 *   1. A HARDCODED VAULT. `op://agents/...` is dead; `op://agents-studio/...`
 *      merely postpones the same outage to the next rename. mcritchie-studio's
 *      bin/lib/op_vaults.rb is the single source for lane -> vault, and it
 *      resolves through an override with a default. Prose does the same:
 *      op://${MCR_OP_VAULT_AGENT:-agents-studio}/...
 *
 *   2. THAT EXPANSION INSIDE SINGLE QUOTES. `op read 'op://${VAR:-x}/i/f'` is
 *      valid shell that reads perfectly to a human and asks 1Password for a
 *      vault literally named "${MCR_OP_VAULT_AGENT:-agents-studio}". The three
 *      lines this guard was written for were ALL single-quoted, so a
 *      search-and-replace of the vault name alone would have swapped one broken
 *      command for another. Every `op://` line in the runbook now uses double
 *      quotes, and this refuses a regression to single ones.
 *
 * Static by default (no network, no credentials). `--live` additionally
 * resolves each reference through the real `op`, which is the only thing that
 * catches a wrong FIELD name — how `op://.../agent.resend/api-key` was caught:
 * the field is `api key`, with a space.
 *
 *   node scripts/check-doc-op-refs.js
 *   node scripts/check-doc-op-refs.js --live
 *
 * IT IS NOW A LANE. .github/workflows/ci.yml (the repo's first workflow, added
 * 2026-08-30) runs `npm run check:doc-op-refs` in its `guards` job on every pull
 * request and every push to main/release/accepted. STATIC MODE ONLY there: `--live`
 * needs a real 1Password credential, which CI does not have and should not be given.
 * So a stale vault name is caught on a push; a wrong FIELD name still needs a
 * `--live` run by hand, which is a release step.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
// THE DEFAULT IS `studio-agents`, AND THE ORDER OF THOSE TWO WORDS MATTERS.
// It must match mcritchie-studio's bin/lib/op_vaults.rb, which is the single
// source for lane -> vault: LANES[:agent][:default_vault] == "studio-agents".
// This constant read `agents-studio` from 2026-08-29 until 2026-09-15 — a
// transposition, not a rename — so every prose command in this repo defaulted to
// a vault that does not exist on any machine, and `op` answers that with
// `"agents-studio" isn't a vault in this account`. The STATIC check could never
// catch it: it compares each reference against this constant, so the constant
// and the prose agreed with each other and disagreed with 1Password. Only
// `--live` reaches the real vault, and CI has no credential to run it.
const AGENT_VAULT_EXPANSION = "${MCR_OP_VAULT_AGENT:-studio-agents}";
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  ".worktrees",
  "dist",
]);
const PROSE = /\.(md|mdx)$/i;

// A reference runs from `op://` to the first shell/markdown terminator. Fields
// legitimately contain spaces ("Mainnet RPC URL"), so whitespace does NOT end
// one — only a quote, a backtick, a closing paren, or the end of the line.
const TERMINATORS = new Set(["`", "'", '"', ")", "\n"]);

function proseFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        proseFiles(path.join(dir, entry.name), out);
    } else if (PROSE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function referencesIn(file) {
  const text = fs.readFileSync(file, "utf8");
  const refs = [];
  let at = text.indexOf("op://");

  while (at !== -1) {
    let end = at;
    while (end < text.length && !TERMINATORS.has(text[end])) end += 1;
    refs.push({
      file: path.relative(ROOT, file),
      line: text.slice(0, at).split("\n").length,
      ref: text.slice(at, end),
      singleQuoted: text[at - 1] === "'",
    });
    at = text.indexOf("op://", end);
  }
  return refs;
}

function vaultOf(ref) {
  return ref.slice("op://".length).split("/")[0];
}

function main() {
  const live = process.argv.includes("--live");
  const refs = proseFiles(ROOT).flatMap(referencesIn);
  const problems = [];

  for (const r of refs) {
    const vault = vaultOf(r.ref);

    if (vault !== AGENT_VAULT_EXPANSION) {
      problems.push(
        `${r.file}:${r.line} names the vault literally as ${JSON.stringify(
          vault
        )}. ` +
          `Use op://${AGENT_VAULT_EXPANSION}/... — a literal breaks fleet-wide on the next ` +
          `rename, exactly as "agents" did on 2026-08-28. If the literal you see is ` +
          `"agents-studio", it is the 2026-09-15 transposition: the vault is "studio-agents".`
      );
      continue;
    }

    if (r.singleQuoted) {
      problems.push(
        `${r.file}:${r.line} wraps the reference in SINGLE quotes, where \${...} never ` +
          `expands — 1Password would be asked for a vault literally named ` +
          `"${AGENT_VAULT_EXPANSION}". Use double quotes.`
      );
    }
  }

  if (live && problems.length === 0) {
    // DERIVED from AGENT_VAULT_EXPANSION, never re-typed. A second literal of
    // the default is how the 2026-09-15 transposition survived its own fix: the
    // constant was corrected and this line still said "agents-studio", so
    // `--live` kept resolving against a vault that does not exist while the
    // static pass reported three references OK.
    const vault =
      process.env.MCR_OP_VAULT_AGENT ||
      AGENT_VAULT_EXPANSION.replace(/^\$\{[^:]+:-/, "").replace(/\}$/, "");
    for (const r of refs) {
      const resolved = r.ref.replace(AGENT_VAULT_EXPANSION, vault);
      try {
        execFileSync("op", ["read", resolved], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        console.log(`  ok   ${r.file}:${r.line}  ${resolved}`);
      } catch (error) {
        const detail = (error.stderr || "").toString().trim().split("\n")[0];
        problems.push(
          `${r.file}:${r.line} does not resolve: ${resolved}\n         ${detail}`
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `check-doc-op-refs: ${problems.length} problem(s) in ${refs.length} reference(s)\n`
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-doc-op-refs: ${refs.length} op:// reference(s) OK` +
      (live
        ? " (resolved against 1Password)"
        : " (static; add --live to resolve them)")
  );
}

main();
