/**
 * WHO PAYS THE PROPOSAL RENT — measured against the SDK, not against a stub
 * (2026-09-13, Carl's review of PR 31).
 *
 * THE DEFECT THIS EXISTS FOR. `scripts/squad-upgrade.js` passed
 * `rentPayer: alexBot` to `multisig.rpc.proposalCreate` and three documents said
 * the bot therefore paid, so the humans needed no SOL. At the LOCKED version
 * (@sqds/multisig 2.1.4) that helper ACCEPTS `rentPayer`, pushes it into the
 * signer list, and hands the transaction builder no rentPayer at all
 * (lib/index.js:8209-8217) — so the instruction resolved
 * `rent_payer = rentPayer ?? creator`, and the creator is now a HUMAN. The value
 * was accepted and discarded.
 *
 * WHY THE EXISTING TESTS COULD NOT SEE IT, which is the lesson worth keeping:
 * squad-upgrade-flow.test.js stubs the SDK, so its stub recorded `rentPayer`
 * faithfully and modelled a behaviour the SDK does not have;
 * squad-upgrade-signers.test.js asserted a regex over the script's source, which
 * only proves the string is in the file. Both were green. So this file asks the
 * REAL SDK what account ends up paying, the way a reviewer would.
 *
 * SELF-SKIPS WHEN node_modules IS ABSENT, deliberately and loudly: CI's `guards`
 * lane installs nothing (see .github/workflows/ci.yml), and the same precedent is
 * documented for the runtime-dependent case in mainnet-config.test.js. Run it
 * where the dependency tree exists:
 *
 *   npm run test:scripts                       # skips if node_modules is absent
 *   NODE_PATH=<repo>/node_modules npm run test:scripts   # from a worktree
 *
 * No network and no real keys: the keypairs are generated in the test, and the
 * only "connection" is a recorder that captures the transaction and sends nothing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

let multisig;
let web3;
try {
  multisig = require("@sqds/multisig");
  web3 = require("@solana/web3.js");
} catch {
  multisig = null;
}

const SKIP = multisig
  ? false
  : "@sqds/multisig is not installed here — run with NODE_PATH=<repo>/node_modules to grade the SDK's real behaviour";

const MULTISIG_PDA = "4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX";

// The proposalCreate instruction's account order (generated client, 2.1.4):
// 0 multisig · 1 proposal · 2 creator · 3 rent_payer · 4 system_program.
const RENT_PAYER_INDEX = 3;

function keys() {
  const bot = web3.Keypair.generate();
  const human = web3.Keypair.generate();
  return { bot, human };
}

test(
  "the built instruction charges the account named as rentPayer",
  { skip: SKIP },
  () => {
    const { bot, human } = keys();

    const ix = multisig.instructions.proposalCreate({
      multisigPda: new web3.PublicKey(MULTISIG_PDA),
      transactionIndex: 42n,
      creator: human.publicKey,
      rentPayer: bot.publicKey,
    });

    const rent = ix.keys[RENT_PAYER_INDEX];
    assert.equal(
      rent.pubkey.toBase58(),
      bot.publicKey.toBase58(),
      "the instruction's rent_payer is not the bot, so a human pays the proposal account rent"
    );
    assert.ok(
      rent.isSigner && rent.isWritable,
      "the rent payer must sign and be writable, or it cannot pay"
    );
    assert.equal(
      ix.keys[2].pubkey.toBase58(),
      human.publicKey.toBase58(),
      "the creator is still the human"
    );
  }
);

test(
  "omitting rentPayer charges the CREATOR — the default this script must not take",
  { skip: SKIP },
  () => {
    const { human } = keys();

    const ix = multisig.instructions.proposalCreate({
      multisigPda: new web3.PublicKey(MULTISIG_PDA),
      transactionIndex: 42n,
      creator: human.publicKey,
    });

    assert.equal(
      ix.keys[RENT_PAYER_INDEX].pubkey.toBase58(),
      human.publicKey.toBase58(),
      "the control failed: if the default did NOT charge the creator, the assertion above proves nothing"
    );
  }
);

test(
  "multisig.rpc.proposalCreate DISCARDS rentPayer at the locked version",
  { skip: SKIP },
  async () => {
    const { bot, human } = keys();
    const captured = [];

    // A recorder, not a connection: it answers the two calls the helper makes and
    // keeps the transaction instead of sending it.
    const connection = {
      async getLatestBlockhash() {
        return {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 1,
        };
      },
      async sendTransaction(tx) {
        captured.push(tx);
        return "RECORDED";
      },
    };

    await multisig.rpc.proposalCreate({
      connection,
      feePayer: bot,
      rentPayer: bot,
      multisigPda: new web3.PublicKey(MULTISIG_PDA),
      transactionIndex: 42n,
      creator: human,
    });

    assert.equal(
      captured.length,
      1,
      "the helper sent nothing; this measurement is void"
    );
    const message = captured[0].message;
    const accounts = message.staticAccountKeys.map((k) => k.toBase58());
    const ix = message.compiledInstructions[0];
    const rent = accounts[ix.accountKeyIndexes[RENT_PAYER_INDEX]];

    assert.equal(
      rent,
      human.publicKey.toBase58(),
      "rpc.proposalCreate now honours rentPayer. That is GOOD NEWS and a decision to re-take: " +
        "squad-upgrade.js builds the instruction itself precisely because this version did not, " +
        "and the comment there cites this measurement. Re-read it before simplifying the script."
    );
  }
);
