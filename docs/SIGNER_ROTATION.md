# Signer Rotation — the v0.26 five-slot ceremony

**Status: LIVE procedure.** This is the current signer-rotation runbook.
`KEY_ROTATION.md` is the historical v0.20 incident plan for the retired Alex
Bot key and must not be executed as a rotation procedure.

**Nothing in this file is an agent's to run.** The rotation requires three of
Mr. McRitchie's own wallets on separate devices. That is the entire design: if
an agent could perform it, the change would not have fixed anything.

---

## Why the set is changing

`VaultState.signers` holds `{Alex Bot, Alex, Mason}` on both clusters. Alex Bot
and Mason read as two parties and are two costumes of one agent system —
`agent.alex.solana` and `agent.mason.solana` both sit in the `studio-agents`
1Password vault behind the same service account. At the pre-v0.26 structural
2-of-3, any agent with vault access therefore held every governance power the
program has, including `update_signers`: it could rotate the set and lock the
operator out of his own vault.

The end state is five slots, three required:

| slot | holder | reachable by an agent? |
|------|--------|------------------------|
| 1 | system wallet — one per environment (prod / qa / local) | yes |
| 2 | the agent's own identity | yes |
| 3 | Alex Phantom — the everyday third signature | no |
| 4 | Alex wallet two — independence from any single device | no |
| 5 | Alex cold — separate device, the doomsday key | no |

An agent reaches two. Two is never enough to govern and never enough to evict.
Mr. McRitchie reaches three, so he can govern — and evict a captured system —
alone on the day he needs to.

**Mason's slot is retired.** It read as a second person and was a second
costume.

**Five is the hard ceiling**, set by the account rather than by policy:
`VaultState` had exactly 64 reserved bytes and a pubkey is 32.

---

## The ceremony is two steps, and the order is not optional

`update_signers` requires `threshold` of the keys that AUTHORIZED a rotation to
survive it — the N-of-M generalization of the v0.20 both-cosigners rule. It
guarantees the vault is always left holding enough keys someone has just
demonstrated they can sign with, which is what a fat-fingered Phantom paste
would otherwise destroy permanently.

With three slots occupied and a threshold of three, ALL THREE authorizers must
survive. So the first rotation can only ADD:

### Step 1 — ADD (additive, nothing evicted)

```
{bot, alex, mason}  →  {bot, alex, mason, wallet-2, cold}
```

Signed by all three current keys. **Mason's key is needed one last time here**;
after step 2 it has no authority anywhere.

### Step 2 — EVICT (the point of the whole exercise)

```
{bot, alex, mason, wallet-2, cold}  →  {system, agent-bot, alex, wallet-2, cold}
```

Signed by **alex + wallet-2 + cold** — three keys no agent can reach. This is
the first moment Mr. McRitchie can act without the agent's cooperation, and it
exists only because step 1 widened the set first. A captured system can neither
block this transaction nor reverse it.

Both steps are exercised end to end, against a real validator, in
`tests/turf_vault.ts` ("rotation is ADDITIVE first" and "THE EVICTION").

---

## Before you start

The program must already be at v0.26 **and** `init_governance` must have been
called — every vault-authorized instruction requires the governance account.
See `RUNBOOK.md` → *v0.26 upgrade ordering*.

Pre-flight, read-only, needs no key:

```bash
cd /Users/alex/projects/turf-vault
node scripts/check-signer-slots.js --expect unrotated
```

It should print three occupied slots, two empty, and a 1515-byte account on
both clusters. That is the proof the upgrade changed nothing: the appended
`signers_ext` field still reads as the zeros it was carved from, so the vault
behaves exactly as v0.25 did.

---

## Running a step

```bash
node scripts/rotate-devnet-signers.js \
  --slots <pk1>,<pk2>,<pk3>,<pk4>,<pk5> \
  --signer keys/a.json --signer keys/b.json --signer keys/c.json
```

**It is a dry run until you add `--send`.** The dry run reads the current set
off chain, prints the diff slot by slot, names what would be evicted, and
re-checks every guard the program enforces — duplicates, gaps, set size, and
continuity — so a refusal names the problem in words instead of arriving as a
numbered error after you have signed.

**It is devnet-only by construction.** The program id is pinned and the mainnet
id is refused by name; `--cluster` and `--mainnet` are refused outright.
Mainnet rotation is a separate deliberate act with its own review, not a flag
on this script.

The first `--signer` is the fee payer. Order is otherwise irrelevant: the first
two ride as the instruction's named `admin` and `cosigner`, and any beyond that
ride as leading `remaining_accounts`, which is the wire shape
`instructions::governance::authorize` reads.

After `--send` the script reads the set back from chain and refuses to report
success unless every slot is exactly what was written.

---

## Post-flight

```bash
node scripts/check-signer-slots.js --cluster devnet --expect rotated
```

Exit code, not eyeballing. Then confirm the evicted keys are genuinely inert by
attempting a `pause` with them — it must fail `Unauthorized` (6000).

---

## Guards you will meet, and what each means

| error | meaning |
|---|---|
| `Unauthorized` 6000 | a signing key is not in the CURRENT set |
| `DuplicateSigner` 6014 | the same key appears twice — N signatures from one keypair is one signature |
| `SignerContinuityRequired` 6017 | fewer than `threshold` of the authorizing keys survive. To EVICT a key, sign with keys that are STAYING |
| `InsufficientSigners` 6046 | fewer distinct signatures than the threshold |
| `SignerSetTooSmall` 6052 | a gap (a live key after an empty slot), or a set smaller than some live threshold needs |
| `GovernanceFloorViolation` 6049 | an attempt to lower `update_signers`, `unpause`, or the threshold-setter below 3. This floor cannot be moved by any quorum — it is what stops the fix undoing itself |

---

## What this does not cover

- **Mainnet.** Same two steps, different tooling and its own review.
- **The emergency console.** A separate deliverable, with one hard rule: it
  must NOT be served by the Rails app. If the scenario is a captured system,
  a console that system serves is captured too — it can display anything and
  sign anything. It is a static page talking straight to a public RPC, holding
  no keys, needing nothing from the servers, the database, or any agent: a file
  that opens from a USB stick on a borrowed laptop. Sequence on the bad day:
  pause (2, instant) → evict slots 1 and 2 (3, unhurried) → unpause (3).
