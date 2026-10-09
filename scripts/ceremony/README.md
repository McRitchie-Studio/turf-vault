# `scripts/ceremony/` — the 2026-09-15 Squads rotation, preserved

These four scripts ran the real membership ceremony on 2026-09-15, against both
clusters, with Mr. McRitchie's authorization. They are kept because the way they
handle a multisig is the reference for anything that touches one again — not
because they are still runnable.

## Read this before running any of them

**Their plans are DONE, and each will refuse on today's chain.** Every one
validates its intended change against live membership before building anything,
so a re-run reports what no longer matches and exits non-zero rather than
half-applying a completed ceremony. That refusal is the feature. Measured
2026-09-15, after the ceremony:

```text
$ node scripts/ceremony/squad-membership.js --cluster=mainnet
REFUSED — plan does not match live state:
  - admin BLSBw8 is ALREADY a member — add would fail
  - Xan 8K81 is NOT a member — remove would fail
```

**They are a record, not a toolkit.** For the live questions they used to answer,
reach for the committed tooling instead:

| Question | Command |
|----------|---------|
| Who is on each multisig right now, and can the agent act alone? | `node scripts/squad-inventory.js` |
| Upgrade the program through Squads | `node scripts/squad-upgrade.js --cluster=<devnet\|mainnet> <BUFFER>` |
| Did a Squads change touch the program's own `VaultState` signers? | `node scripts/check-signer-slots.js` |

## What each one is

| Script | What it did | The property worth copying |
|--------|-------------|----------------------------|
| `squad-membership.js` | The first pass: seated Mr. McRitchie's wallets plus the agent admin key, retired Xan and Mason, raised the threshold 2 → 3 | ONE atomic config transaction — if any action is invalid, none apply. Genesis-hash cluster guard. Dry run by default |
| `squad-finish.js` | Resumed a flow that was created but not executed | **It REFUSES to approve unless the on-chain actions read back match an expected plan.** Approving a config transaction you have not read back is how a multisig gets captured |
| `add-system-seat.js` | The second pass, cluster-parameterised: brought both multisigs to five seats, matching the `VaultState` signer list | It prints whether the agent reaches quorum in the resulting shape, and says so as `⚠ AGENT CAN ACT ALONE` |
| `blast-radius.js` | Read-only: proved the Squads change did NOT move the vault PDA, the program's upgrade authority, or `VaultState` | Verifying what a change did *not* touch is as much a part of a ceremony as verifying what it did |

## The 2026-10-08 governance rotation

Two scripts were added for task `rotate-mainnet-admin-key`, and like the four above
they refuse once their plan is done.

| Script | What it does | Notes |
|--------|--------------|-------|
| `rotate-admin-seat.js` | ONE config transaction per cluster: `removeMember(BLSBw8…)` + `addMember(4bKN…, mask 7)`, threshold unchanged. `--send` creates it, proposes it and casts the clean system seat's vote. `--approve --index --as=<role>` adds an agent vote, and `--execute --index` executes once it is Approved | Every mode reads the on-chain actions back against `scripts/lib/admin-seat-rotation.js` and refuses on any drift. BLSBw8 never signs, with one exception: `--allow-outgoing-signer`, used once for devnet #19's third vote on Mr. McRitchie's instruction. It covers devnet `--approve` only |
| `sweep-admin-tokens.js` | Empties and closes BLSBw8's SPL token accounts into an operator wallet, in one transaction paid by the governance seat | Refuses on any mint not on its canonical USDC/USDT list, or on a delegate or close authority. Reads BLSBw8 from the 1Password archive |
| `sweep-admin-seat.js` | Moves the SOL left on BLSBw8 to allow-listed destinations, fee-aware, leaving it at 0 or at rent-exempt | The dry run SIMULATES the unsigned transaction and loads no key. It lists SPL token accounts but never moves them |

## Three things they learned the hard way

All three are now encoded in `scripts/squad-upgrade.js` and its libraries, which
is the point of keeping these:

1. **Every step races the next.** The account or status the following call needs
   is not yet visible to the node when it builds. Devnet took four attempts by
   hand; mainnet ran clean once the script polled between steps. `settle()` in
   `squad-finish.js` is that fix, and `squad-upgrade.js` now polls after every
   write.
2. **The SDK is inconsistent about PublicKey vs Signer.** `configTransactionCreate`
   takes `creator`/`rentPayer` as **PublicKey**; `proposalCreate` and
   `proposalApprove` take **Signers**. The wrong one fails at build time with
   `pubkey.toBase58 is not a function`, which names nothing useful. Every call site
   in `squad-upgrade.js` now says which it wants.
3. **A signer with no SOL fails as** `Attempt to debit an account but found no
   record of a prior credit`, which also names nothing useful. Check the fee
   payer's balance before building, not after — `squad-upgrade.js` refuses with
   the number and the shortfall.

## Keys

Each script reads its signing key from 1Password at run time and never writes it
to disk. The field LABEL differs between items and that is not a typo to tidy:
the `solana.turf.system*` items spell it `private-key`; `solana.turf.governance`
and `agent.xan.solana` spell it `private key`, with a space.

```bash
op read "op://${MCR_OP_VAULT_AGENT:-studio-agents}/solana.turf.system.devnet/private-key"
```
