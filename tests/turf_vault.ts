import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TurfVault } from "../target/types/turf_vault";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";

// Assert that `promise` REJECTS, with an error matching `pattern`.
//
// The two assertions live OUTSIDE the try/catch, and that placement is the
// whole point of this helper. The previous version put `expect.fail(...)` on
// the success path but INSIDE the try, so the AssertionError it threw fell
// straight into its own `catch (err)` one line below — and because the
// failure message interpolates `pattern` verbatim ("expected rejection
// matching /Unauthorized/i"), `err.toString()` CONTAINED the very literal the
// regex was looking for. The catch's assertion passed, the helper returned
// normally, and a call the program had HAPPILY ACCEPTED was reported as a
// passing rejection assertion. Every pattern in this suite is a bare literal,
// so every one of these call sites self-matched: the suite could still catch a
// rejection with the WRONG error, but never a guard that failed to refuse at
// all — the only failure mode these assertions exist to catch.
//
// Keep the assertions below the try/catch. An `expect` inside a try whose
// catch also asserts is how this class of blindness comes back.
const expectRejected = async (
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<void> => {
  let rejection: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err: any) {
    rejection = err;
    rejected = true;
  }
  expect(
    rejected,
    `expected rejection matching ${pattern}, but the call SUCCEEDED`
  ).to.equal(true);
  expect(String(rejection)).to.match(pattern);
};

// The helper above is the suite's ONLY negative-assertion primitive: 45 call
// sites route through it. It was inert for its entire life, so this block
// exercises the primitive itself. It needs no validator and no chain state —
// it is pure control flow — which is why it lives outside the matrix describe.
describe("expectRejected (the suite's own negative-assertion helper)", () => {
  const helperFails = async (fn: () => Promise<void>): Promise<string> => {
    try {
      await fn();
    } catch (err: any) {
      return String(err.message ?? err);
    }
    throw new Error("expectRejected reported a PASS where it should have FAILED");
  };

  // THE REGRESSION. `/Unauthorized/i` is deliberate: the previous helper built
  // its own failure message by interpolating the pattern ("expected rejection
  // matching /Unauthorized/i"), threw that message INSIDE the try, caught it
  // one line below, and matched it against the same pattern — which its own
  // text contained. A call the program had ACCEPTED passed as a refusal.
  it("FAILS when the call succeeds", async () => {
    const message = await helperFails(() =>
      expectRejected(Promise.resolve("the program accepted it"), /Unauthorized/i)
    );
    expect(message).to.match(/SUCCEEDED/);
  });

  it("passes when the call rejects with a matching error", async () => {
    await expectRejected(
      Promise.reject(new Error("AnchorError ... Error Code: Unauthorized")),
      /Unauthorized/i
    );
  });

  it("FAILS when the call rejects with a different error", async () => {
    await helperFails(() =>
      expectRejected(Promise.reject(new Error("ContestFull")), /Unauthorized/i)
    );
  });
});


describe("turf_vault verification matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TurfVault as Program<TurfVault>;
  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const DECIMALS = 6;
  const MAX_CURRENCIES = 16;
  const DEFAULT_SEASON_ID = 1;
  const DEFAULT_SEED_SCHEDULE = [25, 19, 14, 10, 7];
  const QUEST_SEEDS = [12, 18, 45, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const DEFAULT_PUBKEY = new PublicKey("11111111111111111111111111111111");

  let signer2: Keypair;
  let signer3: Keypair;
  let treasury: Keypair;
  let stranger: Keypair;
  let user1: Keypair;
  let user2: Keypair;

  let usdcMint: PublicKey;
  let usdtMint: PublicKey;
  let bonusMint: PublicKey;

  let vaultStatePda: PublicKey;
  let governancePda: PublicKey;
  let usdcOpRevPda: PublicKey;
  let usdtOpRevPda: PublicKey;
  let bonusOpRevPda: PublicKey;
  let defaultSeasonPda: PublicKey;

  let adminUsdcAta: PublicKey;
  let signer2UsdcAta: PublicKey;
  let treasuryUsdcAta: PublicKey;
  let treasuryUsdtAta: PublicKey;
  let wrongTreasuryUsdtAta: PublicKey;
  let user1UsdcAta: PublicKey;
  let user1UsdtAta: PublicKey;
  let user1BonusAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let user2UsdtAta: PublicKey;

  let paidContest: ContestFixture;
  let bonusContest: ContestFixture;

  type ContestFixture = {
    id: Buffer;
    contestPda: PublicKey;
    prizePoolPda: PublicKey;
  };

  const amount = (tokens: number): number => tokens * 10 ** DECIMALS;
  const bn = (value: number | string): anchor.BN => new anchor.BN(value);
  const now = (): number => Math.floor(Date.now() / 1000);

  // THE CLOCK THE PROGRAM ACTUALLY READS.
  //
  // Every lock/conclusion gate in the program compares against
  // `Clock::get()?.unix_timestamp` — the on-chain Clock sysvar — while `now()`
  // above is the client's wall clock. On solana-test-validator the two are NOT
  // the same: the chain clock is derived from slot production and was measured
  // running a stable 1-2 SECONDS BEHIND wall clock (2026-09-06, sampled over
  // 70s on a fresh validator).
  //
  // That matters because "a lock that has already passed" used to be expressed
  // as `now() - 1` — a ONE-SECOND margin against a TWO-SECOND skew. On-chain
  // the lock then sat in the FUTURE, the contest stayed open, and the refusals
  // these tests exist to assert were simply not applicable: the entry was
  // accepted, the 1-of-3 amend was allowed, and settlement refused with
  // ContestNotLocked. Whether a run went green came down to how many
  // round-trips elapsed between creating the contest and asserting on it, which
  // is why the failure was intermittent rather than constant.
  //
  // Read the sysvar the program reads, and use a margin that swamps the drift.
  const chainNow = async (): Promise<number> => {
    const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    if (!info) throw new Error("Clock sysvar unavailable");
    // Clock layout: slot u64 | epoch_start_timestamp i64 | epoch u64 |
    // leader_schedule_epoch u64 | unix_timestamp i64 (byte offset 32).
    return Number(info.data.readBigInt64LE(32));
  };

  // A timestamp that is UNAMBIGUOUSLY in the on-chain past.
  const chainPast = async (marginSeconds = 60): Promise<number> =>
    (await chainNow()) - marginSeconds;
  const tokenAmount = async (account: PublicKey): Promise<number> =>
    Number((await getAccount(connection, account)).amount);

  const bytes = (value: string, length: number): number[] => {
    const out = Buffer.alloc(length);
    out.write(value, 0, "utf8");
    return Array.from(out);
  };

  const username = (value: string): number[] => bytes(value, 32);
  const reason = (value: string): number[] => bytes(value, 64);
  const sourceRef = (value: string): number[] => bytes(value, 64);
  const sourceRefHash = (ref: number[]): number[] =>
    Array.from(createHash("sha256").update(Buffer.from(ref)).digest());

  const decodeFixedBytes = (value: number[] | Uint8Array): string =>
    Buffer.from(value).toString("utf8").replace(/\0+$/, "");

  const contestId = (slug: string): Buffer =>
    createHash("sha256").update(slug).digest();

  // EXTRA COSIGNERS RIDE IN remainingAccounts, LEADING — the wire shape
  // `instructions::governance::authorize` reads. The count is
  // `threshold - named signers`, so an instruction whose named signers already
  // satisfy its threshold needs none of this and its call site is unchanged.
  const cosigners = (...keypairs: Keypair[]) =>
    keypairs.map((k) => ({
      pubkey: k.publicKey,
      isSigner: true,
      isWritable: false,
    }));

  // The mint-cap window the chain clock is currently in. `mint_entry_token`
  // takes it as an argument because it is a PDA seed, and the program pins it
  // against its own clock — so a caller cannot name an empty window to dodge
  // the cap.
  const MINT_WINDOW_SECONDS = 86_400;
  const currentWindow = async (): Promise<number> =>
    Math.floor((await chainNow()) / MINT_WINDOW_SECONDS);

  const i64Le = (value: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(value));
    return buf;
  };

  const u32Le = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };

  const feeSchedule = (
    fees: Record<number, number> = { 0: amount(9) }
  ): anchor.BN[] => {
    const values = Array.from({ length: MAX_CURRENCIES }, () => bn(0));
    for (const [idx, value] of Object.entries(fees)) {
      values[Number(idx)] = bn(value);
    }
    return values;
  };

  const deriveVault = (): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    )[0];

  const deriveGovernance = (): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("governance")],
      program.programId
    )[0];

  const deriveMintWindow = (windowIndex: number): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("mint_window"), i64Le(windowIndex)],
      program.programId
    )[0];

  const deriveOpRev = (mint: PublicKey): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("op_rev"), mint.toBuffer()],
      program.programId
    )[0];

  const deriveContest = (id: Buffer): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("contest"), id],
      program.programId
    )[0];

  const derivePrizePool = (id: Buffer): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("prize_pool"), id],
      program.programId
    )[0];

  const deriveEntry = (
    id: Buffer,
    wallet: PublicKey,
    entryNum: number
  ): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), id, wallet.toBuffer(), u32Le(entryNum)],
      program.programId
    )[0];

  // THE REGISTRY KEY. The username lowercased and zero-padded to 32 bytes —
  // the same bytes `canonical_username_key` produces on chain, and the same
  // ones `scripts/lib/username-key.js` produces for Rails. It is an argument
  // rather than something the program derives because Anchor needs the seed
  // where `#[derive(Accounts)]` expands; the handler re-derives it and refuses
  // a mismatch (`UsernameKeyMismatch`).
  const nameKey = (value: string): number[] => username(value.toLowerCase());

  // THE RAW-KEY DERIVATION, and it is what a NEGATIVE test about `name_key`
  // has to use. `username_record` is declared
  // `seeds = [b"username", name_key.as_ref()]`, and Anchor checks account
  // constraints BEFORE the handler body runs — so a test that passes a bad
  // `name_key` alongside a record derived from the GOOD one never reaches the
  // guard it is trying to assert: `ConstraintSeeds` fires first, and the only
  // thing proved is that Anchor validates seeds.
  //
  // Derive from the key ACTUALLY BEING PASSED and the seeds constraint is
  // satisfied, so the refusal comes from `handle_set_username` itself —
  // `validate_username` then `require_canonical_key`. Measured 2026-09-15 on
  // the first automated run of these cases: both were asserting
  // `UsernameInvalidChars` / `UsernameKeyMismatch` against an error that read
  // `AnchorError caused by account: username_record`.
  const deriveUsernameRecordForKey = (key: number[]): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("username"), Buffer.from(key)],
      program.programId
    )[0];

  const deriveUsernameRecord = (value: string): PublicKey =>
    deriveUsernameRecordForKey(nameKey(value));

  const deriveUser = (wallet: PublicKey): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user"), wallet.toBuffer()],
      program.programId
    )[0];

  const deriveSeason = (seasonId: number): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("season"), u32Le(seasonId)],
      program.programId
    )[0];

  const deriveEntryToken = (hash: number[]): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("entry_token"), Buffer.from(hash)],
      program.programId
    )[0];

  const deriveSeedGrant = (
    wallet: PublicKey,
    kind: number,
    invitee: PublicKey
  ): PublicKey =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("seed_grant"),
        wallet.toBuffer(),
        Buffer.from([kind]),
        invitee.toBuffer(),
      ],
      program.programId
    )[0];

  const statusName = (status: any): string => Object.keys(status)[0];

  const fund = async (wallet: PublicKey, sol = 5): Promise<void> => {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: wallet,
        lamports: sol * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
  };

  const ata = async (
    mint: PublicKey,
    owner: PublicKey,
    initialAmount = 0
  ): Promise<PublicKey> => {
    const account = await getOrCreateAssociatedTokenAccount(
      connection,
      admin.payer,
      mint,
      owner
    );
    if (initialAmount > 0) {
      await mintTo(
        connection,
        admin.payer,
        mint,
        account.address,
        admin.publicKey,
        initialAmount
      );
    }
    return account.address;
  };

  const createUser = async (
    wallet: PublicKey,
    name: string,
    payer = admin.publicKey
  ): Promise<PublicKey> => {
    const userPda = deriveUser(wallet);
    await program.methods
      .createUserAccount(wallet, username(name) as any, nameKey(name) as any)
      .accountsStrict({
        payer,
        userAccount: userPda,
        usernameRecord: deriveUsernameRecord(name),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return userPda;
  };

  /// `set_username`, with the registry accounts it now carries. Pass the name
  /// being GIVEN UP as `previous` on a real rename; `null` when the canonical
  /// key does not change, or when the account predates the registry.
  const setUsernameFor = (
    wallet: Keypair,
    name: string,
    previous: string | null = null
  ) =>
    program.methods
      .setUsername(username(name) as any, nameKey(name) as any)
      .accountsStrict({
        wallet: wallet.publicKey,
        userAccount: deriveUser(wallet.publicKey),
        usernameRecord: deriveUsernameRecord(name),
        previousUsernameRecord: previous
          ? deriveUsernameRecord(previous)
          : null,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

  const createSeason = async (
    seasonId: number,
    name = "World Cup 2026"
  ): Promise<PublicKey> => {
    const seasonPda = deriveSeason(seasonId);
    await program.methods
      .createSeason(
        seasonId,
        bytes(name, 32) as any,
        DEFAULT_SEED_SCHEDULE.map((n) => bn(n)) as any,
        QUEST_SEEDS.map((n) => bn(n)) as any,
        bn(now())
      )
      .accountsStrict({
        admin: admin.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
        season: seasonPda,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(cosigners(signer2, signer3))
      .signers([signer2, signer3])
      .rpc();
    return seasonPda;
  };

  const createContest = async (
    slug: string,
    options: {
      fees?: Record<number, number>;
      maxEntries?: number;
      payouts?: number[];
      prizePool?: number;
      lockTimestamp?: number;
      payer?: PublicKey;
      creator?: PublicKey;
      creatorTokenAccount?: PublicKey;
      signers?: Keypair[];
    } = {}
  ): Promise<ContestFixture> => {
    const id = contestId(slug);
    const contestPda = deriveContest(id);
    const prizePoolPda = derivePrizePool(id);
    const prizePool = options.prizePool ?? amount(0);
    const payouts = options.payouts ?? (prizePool > 0 ? [prizePool] : []);

    await program.methods
      .createContest(
        Array.from(id) as any,
        DEFAULT_SEASON_ID,
        feeSchedule(options.fees) as any,
        options.maxEntries ?? 5,
        payouts.map((p) => bn(p)) as any,
        bn(prizePool),
        bn(options.lockTimestamp ?? 0)
      )
      .accountsStrict({
        payer: options.payer ?? admin.publicKey,
        creator: options.creator ?? admin.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
        contest: contestPda,
        prizePool: prizePoolPda,
        payoutMint: usdcMint,
        creatorTokenAccount: options.creatorTokenAccount ?? adminUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers(options.signers ?? [])
      .rpc();

    return { id, contestPda, prizePoolPda };
  };

  const enterPaid = async (
    contest: ContestFixture,
    user: Keypair,
    userAccount: PublicKey,
    userTokenAccount: PublicKey,
    currencyMint: PublicKey,
    opRevAta: PublicKey,
    currencyIdx: number,
    entryNum: number
  ): Promise<PublicKey> => {
    const entryPda = deriveEntry(contest.id, user.publicKey, entryNum);
    await program.methods
      .enterContest(entryNum, currencyIdx)
      .accountsStrict({
        payer: admin.publicKey,
        user: user.publicKey,
        userAccount,
        vaultState: vaultStatePda,
        governance: governancePda,
        contest: contest.contestPda,
        contestEntry: entryPda,
        currencyMint,
        userTokenAccount,
        opRevAta,
        season: defaultSeasonPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    return entryPda;
  };

  const mintEntryToken = async (
    owner: PublicKey,
    refText: string
  ): Promise<{ pda: PublicKey; ref: number[]; hash: number[] }> => {
    const ref = sourceRef(refText);
    const hash = sourceRefHash(ref);
    const pda = deriveEntryToken(hash);
    const windowIndex = await currentWindow();
    await program.methods
      .mintEntryToken(0, ref as any, hash as any, bn(windowIndex))
      .accountsStrict({
        admin: admin.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
        mintWindow: deriveMintWindow(windowIndex),
        userWallet: owner,
        entryToken: pda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { pda, ref, hash };
  };

  // `signer` omitted => the provider wallet (a vault signer) signs implicitly.
  // Pass a Keypair to burn AS someone else, which is how the auth case proves a
  // stranger is refused.
  const burnEntryToken = async (
    token: { pda: PublicKey; hash: number[] },
    signer?: Keypair
  ): Promise<void> => {
    // BURN_ENTRY_TOKEN is 3-of-N since v0.26, so two cosigners always ride
    // along. When `signer` names someone else, that key LEADS the collected
    // set — so an outsider fails on MEMBERSHIP (Unauthorized), which is the
    // distinction the auth test is actually asserting, rather than failing on
    // a count it could never have reached anyway.
    await program.methods
      .burnEntryToken(token.hash as any)
      .accountsStrict({
        admin: signer ? signer.publicKey : admin.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
        entryToken: token.pda,
      })
      .remainingAccounts(cosigners(signer2, signer3))
      .signers(signer ? [signer, signer2, signer3] : [signer2, signer3])
      .rpc();
  };

  const enterWithToken = async (
    contest: ContestFixture,
    user: Keypair,
    userAccount: PublicKey,
    entryToken: PublicKey,
    entryNum: number
  ): Promise<PublicKey> => {
    const entryPda = deriveEntry(contest.id, user.publicKey, entryNum);
    await program.methods
      .enterContestWithToken(entryNum)
      .accountsStrict({
        payer: admin.publicKey,
        user: user.publicKey,
        userAccount,
        vaultState: vaultStatePda,
        governance: governancePda,
        contest: contest.contestPda,
        contestEntry: entryPda,
        entryToken,
        season: defaultSeasonPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    return entryPda;
  };

  const lockContestNow = async (contest: ContestFixture): Promise<void> => {
    await program.methods
      .setContestLockTime(bn(await chainPast()))
      .accountsStrict({
        admin: admin.publicKey,
        cosigner: signer2.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
        contest: contest.contestPda,
      })
      .signers([signer2])
      .rpc();
  };

  before(async () => {
    signer2 = Keypair.generate();
    signer3 = Keypair.generate();
    treasury = Keypair.generate();
    stranger = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    for (const wallet of [signer2, signer3, treasury, stranger, user1, user2]) {
      await fund(wallet.publicKey, 10);
    }

    usdcMint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      DECIMALS
    );
    usdtMint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      DECIMALS
    );
    bonusMint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      DECIMALS
    );

    vaultStatePda = deriveVault();
    governancePda = deriveGovernance();
    usdcOpRevPda = deriveOpRev(usdcMint);
    usdtOpRevPda = deriveOpRev(usdtMint);
    bonusOpRevPda = deriveOpRev(bonusMint);
    defaultSeasonPda = deriveSeason(DEFAULT_SEASON_ID);

    adminUsdcAta = await ata(usdcMint, admin.publicKey, amount(1_000));
    signer2UsdcAta = await ata(usdcMint, signer2.publicKey, amount(100));
    treasuryUsdcAta = await ata(usdcMint, treasury.publicKey);
    treasuryUsdtAta = await ata(usdtMint, treasury.publicKey);
    wrongTreasuryUsdtAta = await ata(usdtMint, user2.publicKey);
    user1UsdcAta = await ata(usdcMint, user1.publicKey, amount(100));
    user1UsdtAta = await ata(usdtMint, user1.publicKey, amount(100));
    user1BonusAta = await ata(bonusMint, user1.publicKey, amount(50));
    user2UsdcAta = await ata(usdcMint, user2.publicKey, amount(100));
    user2UsdtAta = await ata(usdtMint, user2.publicKey, amount(100));
  });

  describe("initialize", () => {
    it("creates VaultState and pins signers, treasury, USDC slot 0, and USDT slot 1", async () => {
      await program.methods
        .initialize(
          [admin.publicKey, signer2.publicKey, signer3.publicKey],
          2,
          treasury.publicKey
        )
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          payoutMint: usdcMint,
          secondCurrencyMint: usdtMint,
          payoutOpRevAta: usdcOpRevPda,
          secondOpRevAta: usdtOpRevPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.signers.map((s: PublicKey) => s.toBase58())).to.deep.equal([
        admin.publicKey.toBase58(),
        signer2.publicKey.toBase58(),
        signer3.publicKey.toBase58(),
      ]);
      expect(vault.threshold).to.equal(2);
      expect(vault.paused).to.equal(0);
      expect(vault.payoutMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(vault.treasuryAuthority.toBase58()).to.equal(
        treasury.publicKey.toBase58()
      );
      expect(vault.acceptedCurrencies[0].mint.toBase58()).to.equal(
        usdcMint.toBase58()
      );
      expect(vault.acceptedCurrencies[0].opRevAta.toBase58()).to.equal(
        usdcOpRevPda.toBase58()
      );
      expect(vault.acceptedCurrencies[0].active).to.equal(1);
      expect(vault.acceptedCurrencies[1].mint.toBase58()).to.equal(
        usdtMint.toBase58()
      );
      expect(vault.acceptedCurrencies[1].opRevAta.toBase58()).to.equal(
        usdtOpRevPda.toBase58()
      );
      expect(vault.acceptedCurrencies[1].active).to.equal(1);

      // The two appended signer slots must read as EMPTY on a freshly
      // initialized vault — the same thing the live devnet and mainnet vaults
      // read today, which is what makes the v0.26 upgrade behaviour-neutral
      // until a rotation actually runs.
      expect(
        vault.signersExt.map((s: PublicKey) => s.toBase58())
      ).to.deep.equal([DEFAULT_PUBKEY.toBase58(), DEFAULT_PUBKEY.toBase58()]);
    });

    it("bootstraps the governance table with the shipped defaults", async () => {
      // BOOTSTRAP_THRESHOLD is 2, and `admin` is one of them — the second
      // signature rides in remainingAccounts. It is safe at two only because
      // this instruction takes NO ARGUMENTS: it can install the shipped
      // defaults and nothing else.
      await program.methods
        .initGovernance()
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(cosigners(signer2))
        .signers([signer2])
        .rpc();

      const gov = await program.account.governanceConfig.fetch(governancePda);
      // The agreed table, asserted on chain rather than only in Rust.
      expect(gov.thresholds[0]).to.equal(3); // settle_contest
      expect(gov.thresholds[5]).to.equal(2); // pause
      expect(gov.thresholds[6]).to.equal(3); // unpause
      expect(gov.thresholds[7]).to.equal(3); // update_signers
      expect(gov.thresholds[9]).to.equal(2); // close_contest
      expect(gov.thresholds[12]).to.equal(1); // mint within cap
      expect(gov.thresholds[13]).to.equal(3); // mint above cap
      expect(gov.thresholds[14]).to.equal(3); // burn_entry_token
      expect(gov.mintWindowSeconds.toNumber()).to.equal(MINT_WINDOW_SECONDS);
      expect(gov.mintWindowCap).to.be.greaterThan(0);
    });

    it("refuses a second bootstrap, so a retuned table cannot be reset", async () => {
      await expectRejected(
        program.methods
          .initGovernance()
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(cosigners(signer2))
          .signers([signer2])
          .rpc(),
        /already in use/i
      );
    });
  });

  describe("user accounts and usernames", () => {
    it("permissionless payer creates wallet user accounts", async () => {
      const user1Pda = await createUser(user1.publicKey, "user-one");
      const user2Pda = await createUser(user2.publicKey, "user-two");

      const account1 = await program.account.userAccount.fetch(user1Pda);
      const account2 = await program.account.userAccount.fetch(user2Pda);
      expect(account1.wallet.toBase58()).to.equal(user1.publicKey.toBase58());
      expect(account1.seeds.toNumber()).to.equal(0);
      expect(account1.entries).to.equal(0);
      expect(decodeFixedBytes(account1.username)).to.equal("user-one");
      expect(account2.wallet.toBase58()).to.equal(user2.publicKey.toBase58());
    });

    it("enforces username owner, charset, length, and reserved-prefix rules", async () => {
      const user1Pda = deriveUser(user1.publicKey);

      // A rename hands back the name it leaves: `previous` is the old name's
      // record, and the program CLOSES it, refunding the rent to the wallet.
      await setUsernameFor(user1, "renamed-user", "user-one");

      const renamed = await program.account.userAccount.fetch(user1Pda);
      expect(decodeFixedBytes(renamed.username)).to.equal("renamed-user");
      expect(renamed.usernameRegistered).to.equal(1);

      await expectRejected(
        program.methods
          .setUsername(username("hacked") as any, nameKey("hacked") as any)
          .accountsStrict({
            wallet: user2.publicKey,
            userAccount: user1Pda,
            usernameRecord: deriveUsernameRecord("hacked"),
            previousUsernameRecord: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([user2])
          .rpc(),
        /ConstraintSeeds|Unauthorized|seeds/i
      );
      await expectRejected(
        setUsernameFor(user1, "admin-tom", "renamed-user"),
        /UsernameReserved/i
      );
      await expectRejected(
        setUsernameFor(user1, "ab", "renamed-user"),
        /UsernameTooShort/i
      );
      // `xan` is the prefix added with the registry: an operator identity is
      // not claimable, and the rule is a PREFIX rule like every other entry.
      await expectRejected(
        setUsernameFor(user1, "xan", "renamed-user"),
        /UsernameReserved/i
      );
      await expectRejected(
        setUsernameFor(user1, "xanadu", "renamed-user"),
        /UsernameReserved/i
      );

      const invalid = new Array(32).fill(0);
      invalid[0] = 0x68;
      invalid[1] = 0x01;
      invalid[2] = 0x69;
      await expectRejected(
        program.methods
          .setUsername(invalid as any, invalid as any)
          .accountsStrict({
            wallet: user1.publicKey,
            userAccount: user1Pda,
            // Derived from the INVALID key itself, not from an unrelated name.
            // See `deriveUsernameRecordForKey`: a record derived from anything
            // else fails `ConstraintSeeds` first and the charset guard below
            // never runs.
            usernameRecord: deriveUsernameRecordForKey(invalid),
            previousUsernameRecord: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc(),
        /UsernameInvalidChars/i
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // THE REGISTRY. Every assertion below is a REFUSAL, deliberately: the
    // feature's whole value is the calls it rejects. A suite that only proved
    // the happy path would be green against a program with the lock removed.
    // ──────────────────────────────────────────────────────────────────────

    it("REFUSES a second wallet claiming a name another account already holds", async () => {
      // THE ASSERTION THIS FEATURE EXISTS FOR, in Mr. McRitchie's own framing:
      // "I have a turf user, another user should be stopped because it's
      // already taken."
      const user1Pda = deriveUser(user1.publicKey);
      const held = decodeFixedBytes(
        (await program.account.userAccount.fetch(user1Pda)).username
      );

      await expectRejected(
        setUsernameFor(user2, held, "user-two"),
        /UsernameAlreadyClaimed/i
      );

      // Case is not a way around it — the key is the lowercased form, so
      // "RENAMED-USER" is the SAME name.
      await expectRejected(
        setUsernameFor(user2, held.toUpperCase(), "user-two"),
        /UsernameAlreadyClaimed/i
      );

      // A fresh signup cannot take it either: `create_user_account` claims
      // the record in the same transaction, so there is no window where an
      // account displays a name it does not hold.
      const newcomer = Keypair.generate();
      await fund(newcomer.publicKey);
      await expectRejected(
        program.methods
          .createUserAccount(
            newcomer.publicKey,
            username(held) as any,
            nameKey(held) as any
          )
          .accountsStrict({
            payer: admin.publicKey,
            userAccount: deriveUser(newcomer.publicKey),
            usernameRecord: deriveUsernameRecord(held),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /UsernameAlreadyClaimed/i
      );

      // CONTROL: the holder is untouched and a DIFFERENT name still works, so
      // the refusals above are the lock firing rather than the instruction
      // being broken for everyone.
      const after = await program.account.userAccount.fetch(user1Pda);
      expect(decodeFixedBytes(after.username)).to.equal(held);
      await setUsernameFor(user2, "user-two-b", "user-two");
    });

    it("REFUSES a rename that tries to keep the name it is leaving", async () => {
      // Omit the old record and you would hold two names for ~0.0015 SOL,
      // repeatable. `username_registered` is what makes the omission provable.
      await expectRejected(
        setUsernameFor(user2, "user-two-c", null),
        /UsernameRecordMissing/i
      );
      // Handing back a record that is not the CURRENT name's is refused too.
      await expectRejected(
        setUsernameFor(user2, "user-two-c", "user-one"),
        /UsernameRecordNameMismatch|AccountNotInitialized/i
      );

      // And when it IS handed back, the old name really is released — proved
      // by another wallet taking it, which is only possible if the record was
      // closed rather than left behind.
      await setUsernameFor(user2, "user-two-c", "user-two-b");
      const spare = Keypair.generate();
      await fund(spare.publicKey);
      await createUser(spare.publicKey, "user-two-b");
    });

    it("REFUSES a name_key that is not the canonical form of the username", async () => {
      // The key under test is the UNCANONICALIZED one — `username()` keeps the
      // capitals, where `nameKey()` would fold them — so the record has to be
      // derived from those same bytes. Derived from the canonical key instead
      // (what `deriveUsernameRecord("Mixed-Case")` returns) the seeds
      // constraint refuses first and `require_canonical_key` is never reached.
      const nonCanonicalKey = username("Mixed-Case");
      await expectRejected(
        program.methods
          .setUsername(username("Mixed-Case") as any, nonCanonicalKey as any)
          .accountsStrict({
            wallet: user1.publicKey,
            userAccount: deriveUser(user1.publicKey),
            usernameRecord: deriveUsernameRecordForKey(nonCanonicalKey),
            previousUsernameRecord: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc(),
        /UsernameKeyMismatch/i
      );
    });

    it("REFUSES anyone claiming a name the vault has reserved", async () => {
      // THE BLOCKED LIST, and it is the same mechanism as uniqueness: a
      // reservation is simply a record the vault owns.
      const blocked = "blocked-name";

      // One signature is not enough — the floor is three, and it holds even on
      // a governance table written before these actions existed.
      await expectRejected(
        program.methods
          .reserveUsername(nameKey(blocked) as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: null,
            vaultState: vaultStatePda,
            governance: governancePda,
            usernameRecord: deriveUsernameRecord(blocked),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /InsufficientSigners/i
      );

      await program.methods
        .reserveUsername(nameKey(blocked) as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          usernameRecord: deriveUsernameRecord(blocked),
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const record = await program.account.usernameRecord.fetch(
        deriveUsernameRecord(blocked)
      );
      // THE DISTINCTION, ON CHAIN: a reservation is owned by the vault PDA,
      // a player-held name by a wallet. One field, no side table.
      expect(record.owner.toBase58()).to.equal(vaultStatePda.toBase58());

      // And now nobody can take it — not by rename, not by signup.
      await expectRejected(
        setUsernameFor(user1, blocked, "renamed-user"),
        /UsernameAlreadyClaimed/i
      );
      const squatter = Keypair.generate();
      await fund(squatter.publicKey);
      await expectRejected(
        program.methods
          .createUserAccount(
            squatter.publicKey,
            username(blocked) as any,
            nameKey(blocked) as any
          )
          .accountsStrict({
            payer: admin.publicKey,
            userAccount: deriveUser(squatter.publicKey),
            usernameRecord: deriveUsernameRecord(blocked),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /UsernameAlreadyClaimed/i
      );
    });

    it("REFUSES releasing a name the vault does not hold, or paying rent anywhere but the treasury", async () => {
      // A player's record must never be closable through the reservation path.
      await expectRejected(
        program.methods
          .releaseReservedUsername(nameKey("renamed-user") as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            treasury: treasury.publicKey,
            usernameRecord: deriveUsernameRecord("renamed-user"),
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /UsernameNotReserved/i
      );

      // Rent goes to the pinned treasury, not to whoever called it.
      await expectRejected(
        program.methods
          .releaseReservedUsername(nameKey("blocked-name") as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            treasury: stranger.publicKey,
            usernameRecord: deriveUsernameRecord("blocked-name"),
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /InvalidRentDestination/i
      );

      // Released, the name returns to the pool — which is what releasing MEANS.
      await program.methods
        .releaseReservedUsername(nameKey("blocked-name") as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          treasury: treasury.publicKey,
          usernameRecord: deriveUsernameRecord("blocked-name"),
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const claimant = Keypair.generate();
      await fund(claimant.publicKey);
      await createUser(claimant.publicKey, "blocked-name");
    });

    it("overwrite_username renames a user who does NOT sign, at three signatures", async () => {
      const squatter = Keypair.generate();
      await fund(squatter.publicKey);
      const squatterPda = await createUser(squatter.publicKey, "squatted");

      // One signature cannot reach it. This is what makes removing the user's
      // consent safe: the agent system holds two of five slots and no more.
      await expectRejected(
        program.methods
          .overwriteUsername(username("evicted") as any, nameKey("evicted") as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: null,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: squatter.publicKey,
            userAccount: squatterPda,
            usernameRecord: deriveUsernameRecord("evicted"),
            previousUsernameRecord: deriveUsernameRecord("squatted"),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /InsufficientSigners/i
      );

      // A stranger's signature is not a vault signature.
      await expectRejected(
        program.methods
          .overwriteUsername(username("evicted") as any, nameKey("evicted") as any)
          .accountsStrict({
            admin: stranger.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: squatter.publicKey,
            userAccount: squatterPda,
            usernameRecord: deriveUsernameRecord("evicted"),
            previousUsernameRecord: deriveUsernameRecord("squatted"),
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([stranger, signer2, signer3])
          .rpc(),
        /Unauthorized/i
      );

      // THREE, AND THE SQUATTER NEVER SIGNS. `squatter` is absent from
      // `.signers([...])` entirely — that is the whole point of the
      // instruction, and what the old `admin_set_username` could not do.
      await program.methods
        .overwriteUsername(username("evicted") as any, nameKey("evicted") as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          userWallet: squatter.publicKey,
          userAccount: squatterPda,
          usernameRecord: deriveUsernameRecord("evicted"),
          previousUsernameRecord: deriveUsernameRecord("squatted"),
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const account = await program.account.userAccount.fetch(squatterPda);
      expect(decodeFixedBytes(account.username)).to.equal("evicted");

      // The vacated name is FREE again — Mr. McRitchie's accepted behaviour.
      // Locking it is one more transaction at the same quorum:
      // `reserve_username`.
      const nextHolder = Keypair.generate();
      await fund(nextHolder.publicKey);
      await createUser(nextHolder.publicKey, "squatted");
    });

    it("overwrite_username waives the reserved prefix but never the charset bar", async () => {
      // This is where the deleted `admin_set_username`'s only real job now
      // lives — at three signatures instead of one.
      const house = Keypair.generate();
      await fund(house.publicKey);
      const housePda = await createUser(house.publicKey, "house-account");

      // A lone wallet still cannot.
      await expectRejected(
        setUsernameFor(house, "turf", "house-account"),
        /UsernameReserved/i
      );

      const overwrite = (name: string, previous: string) =>
        program.methods
          .overwriteUsername(username(name) as any, nameKey(name) as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: house.publicKey,
            userAccount: housePda,
            usernameRecord: deriveUsernameRecord(name),
            previousUsernameRecord: deriveUsernameRecord(previous),
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc();

      await expectRejected(overwrite("ab", "house-account"), /UsernameTooShort/i);
      await overwrite("turf", "house-account");

      const account = await program.account.userAccount.fetch(housePda);
      expect(decodeFixedBytes(account.username)).to.equal("turf");
    });

    it("backfill_username_record ratifies only what the account already says", async () => {
      // Permissionless because it has NO DISCRETION: name and owner both come
      // from the account's own fields. Every account in this suite was created
      // after the registry, so the reachable case here is the idempotent one.
      const holder = Keypair.generate();
      await fund(holder.publicKey);
      const holderPda = await createUser(holder.publicKey, "backfill-me");

      // A key that is not this account's own name is refused — the caller
      // cannot point the instruction at a name of their choosing.
      await expectRejected(
        program.methods
          .backfillUsernameRecord(nameKey("something-else") as any)
          .accountsStrict({
            payer: stranger.publicKey,
            userWallet: holder.publicKey,
            userAccount: holderPda,
            usernameRecord: deriveUsernameRecord("something-else"),
            systemProgram: SystemProgram.programId,
          })
          .signers([stranger])
          .rpc(),
        /UsernameKeyMismatch/i
      );

      // Run by a wallet with no relationship to the user at all, and
      // idempotent — a retried migration job is safe.
      await program.methods
        .backfillUsernameRecord(nameKey("backfill-me") as any)
        .accountsStrict({
          payer: stranger.publicKey,
          userWallet: holder.publicKey,
          userAccount: holderPda,
          usernameRecord: deriveUsernameRecord("backfill-me"),
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();

      const account = await program.account.userAccount.fetch(holderPda);
      expect(account.usernameRegistered).to.equal(1);
    });
  });

  describe("seasons and seed grants", () => {
    it("creates immutable season seed and quest schedules", async () => {
      defaultSeasonPda = await createSeason(DEFAULT_SEASON_ID);
      const season = await program.account.season.fetch(defaultSeasonPda);
      expect(season.seasonId).to.equal(DEFAULT_SEASON_ID);
      expect(decodeFixedBytes(season.name)).to.equal("World Cup 2026");
      expect(
        season.seedSchedule.map((s: anchor.BN) => s.toNumber())
      ).to.deep.equal(DEFAULT_SEED_SCHEDULE);
      expect(
        season.questSeeds.map((s: anchor.BN) => s.toNumber())
      ).to.deep.equal(QUEST_SEEDS);
    });

    it("rejects duplicate and non-signer season creation", async () => {
      await expectRejected(
        program.methods
          .createSeason(
            DEFAULT_SEASON_ID,
            bytes("Duplicate", 32) as any,
            DEFAULT_SEED_SCHEDULE.map((n) => bn(n)) as any,
            QUEST_SEEDS.map((n) => bn(n)) as any,
            bn(now())
          )
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            season: defaultSeasonPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /already in use|AccountAlreadyInitialized|custom program error: 0x0/i
      );

      const seasonPda = deriveSeason(999);
      await expectRejected(
        program.methods
          .createSeason(
            999,
            bytes("Unauthorized", 32) as any,
            DEFAULT_SEED_SCHEDULE.map((n) => bn(n)) as any,
            QUEST_SEEDS.map((n) => bn(n)) as any,
            bn(now())
          )
          .accountsStrict({
            admin: stranger.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            season: seasonPda,
            systemProgram: SystemProgram.programId,
          })
          // Two REAL signers ride along, so the count is satisfied and the
          // only thing left to fail is the stranger's MEMBERSHIP — which is
          // what this case is actually about. Without them the call would be
          // refused for being one signature short and the assertion would
          // pass without ever testing membership at all.
          .remainingAccounts(cosigners(signer2, signer3))
          .signers([stranger, signer2, signer3])
          .rpc(),
        /Unauthorized/i
      );
    });

    it("grants bounded idempotent quest seeds", async () => {
      const userPda = deriveUser(user1.publicKey);
      const before = await program.account.userAccount.fetch(userPda);
      const grantPda = deriveSeedGrant(user1.publicKey, 0, DEFAULT_PUBKEY);

      await program.methods
        .grantSeeds(bn(12), 0, DEFAULT_PUBKEY)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          userWallet: user1.publicKey,
          userAccount: userPda,
          inviteeUserAccount: null,
          seedGrant: grantPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const after = await program.account.userAccount.fetch(userPda);
      expect(after.seeds.toNumber() - before.seeds.toNumber()).to.equal(12);

      await expectRejected(
        program.methods
          .grantSeeds(bn(12), 0, DEFAULT_PUBKEY)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: user1.publicKey,
            userAccount: userPda,
            inviteeUserAccount: null,
            seedGrant: grantPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /already in use|custom program error: 0x0|AccountAlreadyInitialized/i
      );

      // THE INVITE BONUS IS PAYABLE ONLY ONCE THE FRIEND ACTUALLY ENTERED.
      // That is the quest's own rule, and since v0.26 the program enforces it
      // rather than trusting the caller: `invitee_user_account.entries > 0`.
      // So the friend has to enter something first — which is what makes the
      // grant below legitimate and the two attempts after it farmed.
      const inviteContest = await createContest("invite-friend-entered", {
        fees: { 0: amount(1) },
      });
      await enterPaid(
        inviteContest,
        user2,
        deriveUser(user2.publicKey),
        user2UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );

      const inviteGrantPda = deriveSeedGrant(
        user1.publicKey,
        2,
        user2.publicKey
      );
      await program.methods
        .grantSeeds(bn(45), 2, user2.publicKey)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          userWallet: user1.publicKey,
          userAccount: userPda,
          inviteeUserAccount: deriveUser(user2.publicKey),
          seedGrant: inviteGrantPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // v0.26 — THE INVITE FARM IS CLOSED. The once-only guard used to be
      // seeded on a caller-chosen Pubkey, so "once per invited friend" was
      // really "once per 32-byte NUMBER" and a single signature could mint
      // seeds without bound. An invitee must now be a wallet with a real
      // UserAccount that has ENTERED a contest.
      const madeUpFriend = Keypair.generate().publicKey;
      await expectRejected(
        program.methods
          .grantSeeds(bn(45), 2, madeUpFriend)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: user1.publicKey,
            userAccount: userPda,
            inviteeUserAccount: null,
            seedGrant: deriveSeedGrant(user1.publicKey, 2, madeUpFriend),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /SeedGrantInviteeNotRegistered/i
      );

      // A wallet that HAS an account but has never entered is refused too —
      // otherwise the farm costs one rent-exempt account instead of nothing.
      const neverEntered = Keypair.generate();
      await fund(neverEntered.publicKey, 1);
      const neverEnteredPda = await createUser(
        neverEntered.publicKey,
        "never-entered"
      );
      await expectRejected(
        program.methods
          .grantSeeds(bn(45), 2, neverEntered.publicKey)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: user1.publicKey,
            userAccount: userPda,
            inviteeUserAccount: neverEnteredPda,
            seedGrant: deriveSeedGrant(
              user1.publicKey,
              2,
              neverEntered.publicKey
            ),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /SeedGrantInviteeNotRegistered/i
      );

      await expectRejected(
        program.methods
          .grantSeeds(bn(1_001), 1, DEFAULT_PUBKEY)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            userWallet: user1.publicKey,
            userAccount: userPda,
            inviteeUserAccount: null,
            seedGrant: deriveSeedGrant(user1.publicKey, 1, DEFAULT_PUBKEY),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /SeedGrantAmountInvalid/i
      );
    });
  });

  describe("governance and currency registry", () => {
    // The four keypairs standing in for Mr. McRitchie's personal wallets.
    // They never pay a fee — an extra cosigner only signs — so they need no
    // funding.
    const wallet4 = Keypair.generate();
    const wallet5 = Keypair.generate();

    const rotate = (
      slots: PublicKey[],
      lead: Keypair | anchor.Wallet,
      second: Keypair,
      extras: Keypair[]
    ) =>
      program.methods
        .updateSigners(
          [
            ...slots,
            ...Array(5 - slots.length).fill(DEFAULT_PUBKEY),
          ].slice(0, 5) as any
        )
        .accountsStrict({
          admin: (lead as any).publicKey,
          cosigner: second.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(...extras))
        .signers(
          [
            ...(lead instanceof Keypair ? [lead] : []),
            second,
            ...extras,
          ]
        );

    it("rotation is ADDITIVE first: continuity holds every authorizer at 3-of-3", async () => {
      // THE FIRST STEP OF THE CEREMONY. The vault holds three keys and
      // UPDATE_SIGNERS needs three, so all three must authorize — and
      // continuity then requires all three to SURVIVE. The first rotation can
      // therefore only ADD, which is exactly the intended shape: widen to five
      // now, evict later from a position where the operator no longer needs
      // the keys he is evicting.
      await rotate(
        [
          admin.publicKey,
          signer2.publicKey,
          signer3.publicKey,
          wallet4.publicKey,
          wallet5.publicKey,
        ],
        admin,
        signer2,
        [signer3]
      ).rpc();

      const vault = await program.account.vaultState.fetch(vaultStatePda);
      // THE APPEND, READ BACK OFF THE CHAIN. The original three slots are
      // untouched at their original offsets and the two new keys land in
      // `signers_ext` — the field carved out of what used to be `_reserved`.
      expect(vault.signers.map((k: PublicKey) => k.toBase58())).to.deep.equal([
        admin.publicKey.toBase58(),
        signer2.publicKey.toBase58(),
        signer3.publicKey.toBase58(),
      ]);
      expect(
        vault.signersExt.map((k: PublicKey) => k.toBase58())
      ).to.deep.equal([
        wallet4.publicKey.toBase58(),
        wallet5.publicKey.toBase58(),
      ]);

      // And every slot — including the two that live in the appended field —
      // now authorizes. A key in `signers_ext` that did not work would mean
      // something outside `all_signers()` is still reading `signers` alone.
      await program.methods
        .pause(reason("five-slot set is live") as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: wallet5.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .signers([wallet5])
        .rpc();
      expect(
        (await program.account.vaultState.fetch(vaultStatePda)).paused
      ).to.equal(1);

      await program.methods
        .unpause()
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: wallet4.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(wallet5))
        .signers([wallet4, wallet5])
        .rpc();
      expect(
        (await program.account.vaultState.fetch(vaultStatePda)).paused
      ).to.equal(0);
    });

    it("THE EVICTION: three personal wallets remove the agent-reachable slots", async () => {
      // THE SECOND STEP, AND THE POINT OF THE WHOLE TASK. `admin` and
      // `signer2` stand in for the two keys one agent system can reach — the
      // server identity and the bot identity, both readable from the same
      // 1Password vault. Here the three PERSONAL wallets authorize alone and
      // drop both of them. No agent-reachable key signs this transaction, so
      // a captured system can neither block it nor reverse it.
      await rotate(
        [signer3.publicKey, wallet4.publicKey, wallet5.publicKey],
        signer3,
        wallet4,
        [wallet5]
      ).rpc();

      const vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.signers.map((k: PublicKey) => k.toBase58())).to.deep.equal([
        signer3.publicKey.toBase58(),
        wallet4.publicKey.toBase58(),
        wallet5.publicKey.toBase58(),
      ]);
      // Left-packed: the emptied slots read back as the default key.
      expect(
        vault.signersExt.map((k: PublicKey) => k.toBase58())
      ).to.deep.equal([DEFAULT_PUBKEY.toBase58(), DEFAULT_PUBKEY.toBase58()]);

      // The evicted keys are now strangers. This is the assertion the finding
      // was about: two keys one agent holds are no longer enough for anything.
      await expectRejected(
        program.methods
          .pause(reason("evicted keys try to act") as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
          })
          .signers([signer2])
          .rpc(),
        /Unauthorized/i
      );

      // Restore the suite's working set, by the same two-step route — which is
      // itself the proof that the ceremony is reversible in both directions.
      await rotate(
        [
          signer3.publicKey,
          wallet4.publicKey,
          wallet5.publicKey,
          admin.publicKey,
          signer2.publicKey,
        ],
        signer3,
        wallet4,
        [wallet5]
      ).rpc();
      await rotate(
        [admin.publicKey, signer2.publicKey, signer3.publicKey],
        admin,
        signer2,
        [signer3]
      ).rpc();

      const restored = await program.account.vaultState.fetch(vaultStatePda);
      expect(
        restored.signers.map((k: PublicKey) => k.toBase58())
      ).to.deep.equal([
        admin.publicKey.toBase58(),
        signer2.publicKey.toBase58(),
        signer3.publicKey.toBase58(),
      ]);
    });

    it("two signatures cannot rotate the signer set", async () => {
      // THE HEADLINE REGRESSION. Before v0.26 `update_signers` was
      // structurally 2-of-3 and `validate_multisig` never read the threshold
      // field — so the two agent-reachable keys could rotate the operator out
      // of his own vault. This call is exactly that attempt.
      await expectRejected(
        program.methods
          .updateSigners([
            admin.publicKey,
            signer2.publicKey,
            Keypair.generate().publicKey,
            DEFAULT_PUBKEY,
            DEFAULT_PUBKEY,
          ] as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
          })
          .signers([signer2])
          .rpc(),
        /InsufficientSigners/i
      );
    });

    it("the update_signers floor cannot be lowered, even by a full quorum", async () => {
      // Without an immovable floor the fix undoes itself: three signatures
      // lower `update_signers` to two, and the two agent-reachable keys walk
      // in the next day. `SET_GOVERNANCE` is itself floored for the same
      // reason — otherwise the floor could be lowered by lowering its guard.
      for (const action of [7 /* update_signers */, 6 /* unpause */, 16 /* set_governance */]) {
        await expectRejected(
          program.methods
            .setActionThreshold(action, 2)
            .accountsStrict({
              admin: admin.publicKey,
              vaultState: vaultStatePda,
              governance: governancePda,
            })
            .remainingAccounts(cosigners(signer2, signer3))
            .signers([signer2, signer3])
            .rpc(),
          /GovernanceFloorViolation/i
        );
      }
    });

    it("retunes a threshold that has no floor, and the new number takes effect", async () => {
      // The reversibility that makes every shipped default a cheap choice
      // rather than a commitment. close_contest ships at 2; move it to 3 and
      // the very next close must bring a third signature.
      await program.methods
        .setActionThreshold(9 /* close_contest */, 3)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer2, signer3))
        .signers([signer2, signer3])
        .rpc();
      expect(
        (await program.account.governanceConfig.fetch(governancePda))
          .thresholds[9]
      ).to.equal(3);

      // ...and back, so the rest of the suite runs against the shipped table.
      await program.methods
        .setActionThreshold(9, 2)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer2, signer3))
        .signers([signer2, signer3])
        .rpc();
      expect(
        (await program.account.governanceConfig.fetch(governancePda))
          .thresholds[9]
      ).to.equal(2);
    });

    it("pause is genuinely retunable to ONE signature, on chain", async () => {
      // THE REVIEW FINDING, ASSERTED. `pause` used to declare `admin` AND
      // `cosigner` as mandatory `Signer` accounts, so the account struct
      // enforced a floor of 2 that no stored table could lower.
      // `set_action_threshold(PAUSE, 1)` was ACCEPTED, `threshold_for`
      // returned 1, the on-chain log and every doc said 1 — and a lone signer
      // was still rejected. On the brake, discovered during an incident.
      //
      // Retuning it and then actually pausing with ONE signature is the only
      // assertion that distinguishes a fixed instruction from a documented one.
      await program.methods
        .setActionThreshold(5 /* pause */, 1)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer2, signer3))
        .signers([signer2, signer3])
        .rpc();

      await program.methods
        .pause(reason("one-signature brake") as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: null,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .rpc();
      expect(
        (await program.account.vaultState.fetch(vaultStatePda)).paused
      ).to.equal(1);

      // THE ASYMMETRY SURVIVES THE RETUNE. unpause is floored at 3, so even
      // with pause down at one, a captured system still cannot lift its own
      // brake. Two signatures are refused on the count.
      await expectRejected(
        program.methods
          .unpause()
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
          })
          .signers([signer2])
          .rpc(),
        /InsufficientSigners/i
      );

      await program.methods
        .unpause()
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();
      expect(
        (await program.account.vaultState.fetch(vaultStatePda)).paused
      ).to.equal(0);

      // Back to the shipped 2 for the rest of the suite.
      await program.methods
        .setActionThreshold(5, 2)
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer2, signer3))
        .signers([signer2, signer3])
        .rpc();
      expect(
        (await program.account.governanceConfig.fetch(governancePda))
          .thresholds[5]
      ).to.equal(2);
    });

    it("refuses a threshold no signer set could satisfy", async () => {
      // Storing a threshold above the number of keys that exist would brick
      // the action — and for update_signers it would brick the only way back.
      await expectRejected(
        program.methods
          .setActionThreshold(0 /* settle_contest */, 5)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
          })
          .remainingAccounts(cosigners(signer2, signer3))
          .signers([signer2, signer3])
          .rpc(),
        /ThresholdExceedsSignerSet/i
      );
    });

    it("rejects duplicate, gapped, undersized, and continuity-breaking rotations", async () => {
      const three = (extra: Keypair[] = [signer3]) => ({
        admin: admin.publicKey,
        cosigner: signer2.publicKey,
        vaultState: vaultStatePda,
        governance: governancePda,
      });

      // A duplicated key silently shrinks the effective set: one holder would
      // cast two of the three votes.
      await expectRejected(
        program.methods
          .updateSigners([
            admin.publicKey,
            admin.publicKey,
            signer3.publicKey,
            DEFAULT_PUBKEY,
            DEFAULT_PUBKEY,
          ] as any)
          .accountsStrict(three())
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /DuplicateSigner/i
      );

      // A GAP — a live key after an empty slot. It would WORK, because
      // `all_signers()` skips defaults, and that is exactly why it is refused:
      // it would make "how many signers does this vault have" depend on which
      // reader you ask.
      await expectRejected(
        program.methods
          .updateSigners([
            admin.publicKey,
            signer2.publicKey,
            DEFAULT_PUBKEY,
            signer3.publicKey,
            DEFAULT_PUBKEY,
          ] as any)
          .accountsStrict(three())
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /SignerSetTooSmall/i
      );

      // A set too small for a live threshold would brick every 3-of-N action.
      await expectRejected(
        program.methods
          .updateSigners([
            admin.publicKey,
            signer2.publicKey,
            DEFAULT_PUBKEY,
            DEFAULT_PUBKEY,
            DEFAULT_PUBKEY,
          ] as any)
          .accountsStrict(three())
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /SignerSetTooSmall/i
      );

      // Continuity: a rotation to three keys none of which just signed leaves
      // nobody who has DEMONSTRATED they can sign — the fat-fingered-paste
      // case, which bricks governance permanently.
      await expectRejected(
        program.methods
          .updateSigners([
            Keypair.generate().publicKey,
            Keypair.generate().publicKey,
            Keypair.generate().publicKey,
            DEFAULT_PUBKEY,
            DEFAULT_PUBKEY,
          ] as any)
          .accountsStrict(three())
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /SignerContinuityRequired/i
      );
    });

    it("registers and deactivates a currency without reclaiming its slot", async () => {
      await program.methods
        .registerCurrency(1)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          mint: bonusMint,
          opRevAta: bonusOpRevPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      let vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.acceptedCurrencies[2].mint.toBase58()).to.equal(
        bonusMint.toBase58()
      );
      expect(vault.acceptedCurrencies[2].opRevAta.toBase58()).to.equal(
        bonusOpRevPda.toBase58()
      );
      expect(vault.acceptedCurrencies[2].active).to.equal(1);

      bonusContest = await createContest("bonus-before-deactivate", {
        fees: { 2: amount(4) },
        prizePool: amount(4),
        payouts: [amount(4)],
      });

      await expectRejected(
        program.methods
          .registerCurrency(1)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            mint: bonusMint,
            opRevAta: bonusOpRevPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /already in use|CurrencyAlreadyRegistered|custom program error: 0x0/i
      );

      await program.methods
        .deactivateCurrency(2)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.acceptedCurrencies[2].mint.toBase58()).to.equal(
        bonusMint.toBase58()
      );
      expect(vault.acceptedCurrencies[2].active).to.equal(0);

      await expectRejected(
        createContest("inactive-currency-create", {
          fees: { 2: amount(1) },
          prizePool: amount(1),
          payouts: [amount(1)],
        }),
        /CurrencyNotActive/i
      );
    });
  });

  describe("contest lifecycle and entries", () => {
    it("creates a contest with per-currency fees, payout tiers, prize pool, and lock timestamp", async () => {
      const adminBefore = await tokenAmount(adminUsdcAta);
      paidContest = await createContest("matrix-paid-contest", {
        fees: { 0: amount(9), 1: amount(7) },
        maxEntries: 5,
        prizePool: amount(40),
        payouts: [amount(40)],
        lockTimestamp: 0,
      });

      const contest = await program.account.contest.fetch(
        paidContest.contestPda
      );
      expect(contest.entryFeeByCurrency[0].toNumber()).to.equal(amount(9));
      expect(contest.entryFeeByCurrency[1].toNumber()).to.equal(amount(7));
      expect(contest.prizePool.toNumber()).to.equal(amount(40));
      expect(contest.lockTimestamp.toNumber()).to.equal(0);
      expect(statusName(contest.status)).to.equal("open");
      expect(await tokenAmount(paidContest.prizePoolPda)).to.equal(amount(40));
      expect(adminBefore - (await tokenAmount(adminUsdcAta))).to.equal(
        amount(40)
      );
    });

    it("rejects invalid payout tiers and zero-fee zero-prize contests", async () => {
      await expectRejected(
        createContest("invalid-payout-sum", {
          fees: { 0: amount(9) },
          prizePool: amount(40),
          payouts: [amount(39)],
        }),
        /InvalidPayoutTiers/i
      );

      await expectRejected(
        createContest("no-fees-no-prize", {
          fees: {},
          prizePool: 0,
          payouts: [],
        }),
        /FeeAndPrizeBothZero/i
      );
    });

    it("accepts USDC and USDT entries by moving user ATA funds to op_rev", async () => {
      const user1Pda = deriveUser(user1.publicKey);
      const user2Pda = deriveUser(user2.publicKey);
      const user1Before = await program.account.userAccount.fetch(user1Pda);
      const user1UsdcBefore = await tokenAmount(user1UsdcAta);
      const opUsdcBefore = await tokenAmount(usdcOpRevPda);

      const user1Entry = await enterPaid(
        paidContest,
        user1,
        user1Pda,
        user1UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );

      const user1After = await program.account.userAccount.fetch(user1Pda);
      const entry1 = await program.account.contestEntry.fetch(user1Entry);
      expect(user1UsdcBefore - (await tokenAmount(user1UsdcAta))).to.equal(
        amount(9)
      );
      expect((await tokenAmount(usdcOpRevPda)) - opUsdcBefore).to.equal(
        amount(9)
      );
      expect(
        user1After.seeds.toNumber() - user1Before.seeds.toNumber()
      ).to.equal(25);
      expect(user1After.entries - user1Before.entries).to.equal(1);
      expect(entry1.currencyIdx).to.equal(0);
      expect(statusName(entry1.status)).to.equal("active");

      const user2Before = await program.account.userAccount.fetch(user2Pda);
      const user2UsdtBefore = await tokenAmount(user2UsdtAta);
      const opUsdtBefore = await tokenAmount(usdtOpRevPda);

      await enterPaid(
        paidContest,
        user2,
        user2Pda,
        user2UsdtAta,
        usdtMint,
        usdtOpRevPda,
        1,
        1
      );

      const user2After = await program.account.userAccount.fetch(user2Pda);
      const contest = await program.account.contest.fetch(
        paidContest.contestPda
      );
      expect(user2UsdtBefore - (await tokenAmount(user2UsdtAta))).to.equal(
        amount(7)
      );
      expect((await tokenAmount(usdtOpRevPda)) - opUsdtBefore).to.equal(
        amount(7)
      );
      expect(
        user2After.seeds.toNumber() - user2Before.seeds.toNumber()
      ).to.equal(19);
      expect(contest.currentEntries).to.equal(2);
      expect(contest.entryFees[0].toNumber()).to.equal(amount(9));
      expect(contest.entryFees[1].toNumber()).to.equal(amount(7));
    });

    it("rejects inactive currency, insufficient funds, full contest, and lock gate entries", async () => {
      await expectRejected(
        enterPaid(
          bonusContest,
          user1,
          deriveUser(user1.publicKey),
          user1BonusAta,
          bonusMint,
          bonusOpRevPda,
          2,
          0
        ),
        /CurrencyNotActive/i
      );

      const broke = Keypair.generate();
      await fund(broke.publicKey);
      const brokePda = await createUser(broke.publicKey, "broke-user");
      const brokeUsdc = await ata(usdcMint, broke.publicKey, 0);
      await expectRejected(
        enterPaid(
          paidContest,
          broke,
          brokePda,
          brokeUsdc,
          usdcMint,
          usdcOpRevPda,
          0,
          2
        ),
        /insufficient funds|0x1|custom program error/i
      );

      const maxContest = await createContest("max-entry-contest", {
        fees: { 0: amount(1) },
        maxEntries: 1,
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      await enterPaid(
        maxContest,
        user1,
        deriveUser(user1.publicKey),
        user1UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );
      await expectRejected(
        enterPaid(
          maxContest,
          user2,
          deriveUser(user2.publicKey),
          user2UsdcAta,
          usdcMint,
          usdcOpRevPda,
          0,
          0
        ),
        /ContestFull/i
      );

      const lockedContest = await createContest("locked-entry-contest", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
        lockTimestamp: await chainPast(),
      });
      await expectRejected(
        enterPaid(
          lockedContest,
          user1,
          deriveUser(user1.publicKey),
          user1UsdcAta,
          usdcMint,
          usdcOpRevPda,
          0,
          0
        ),
        /ContestLocked/i
      );
    });

    it("enforces set_contest_lock_time and set_contest_conclusion_time rules", async () => {
      const timingContest = await createContest("timing-contest", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      const lockAt = now() + 120;
      const conclusionAt = lockAt + 120;

      await program.methods
        .setContestLockTime(bn(lockAt))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: timingContest.contestPda,
        })
        .signers([signer2])
        .rpc();

      await expectRejected(
        program.methods
          .setContestConclusionTime(bn(lockAt - 1))
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: null,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: timingContest.contestPda,
          })
          .rpc(),
        /InvalidTimestamp/i
      );

      await program.methods
        .setContestConclusionTime(bn(conclusionAt))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: timingContest.contestPda,
        })
        .signers([signer2])
        .rpc();

      await expectRejected(
        program.methods
          .setContestConclusionTime(bn(conclusionAt + 60))
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: null,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: timingContest.contestPda,
          })
          .rpc(),
        // AMENDING an already-set conclusion escalates to 3. One signature is
        // now short of the count, where in v0.25 it was short of a cosigner.
        /InsufficientSigners/i
      );

      await program.methods
        .setContestConclusionTime(bn(conclusionAt + 60))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: timingContest.contestPda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const postLockContest = await createContest("post-lock-amend-contest", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
        lockTimestamp: await chainPast(),
      });
      await expectRejected(
        program.methods
          .setContestLockTime(bn(now() + 300))
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: null,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: postLockContest.contestPda,
          })
          .rpc(),
        // RE-OPENING a passed lock escalates to 3 — the results-known vector.
        /InsufficientSigners/i
      );
      await program.methods
        .setContestLockTime(bn(now() + 300))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: postLockContest.contestPda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();
    });
  });

  describe("entry tokens and pause controls", () => {
    it("mints idempotent token-entry vouchers and consumes one without charging currency", async () => {
      const tokenContest = await createContest("token-entry-contest", {
        fees: { 0: amount(9) },
        prizePool: amount(9),
        payouts: [amount(9)],
      });
      const opBefore = await tokenAmount(usdcOpRevPda);
      const userBefore = await program.account.userAccount.fetch(
        deriveUser(user1.publicKey)
      );
      const token = await mintEntryToken(
        user1.publicKey,
        "stripe-session-token-entry"
      );

      await expectRejected(
        program.methods
          .mintEntryToken(
            0,
            token.ref as any,
            token.hash as any,
            bn(await currentWindow())
          )
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            mintWindow: deriveMintWindow(await currentWindow()),
            userWallet: user1.publicKey,
            entryToken: token.pda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /already in use|custom program error: 0x0|AccountAlreadyInitialized/i
      );

      const entryPda = await enterWithToken(
        tokenContest,
        user1,
        deriveUser(user1.publicKey),
        token.pda,
        0
      );
      const entry = await program.account.contestEntry.fetch(entryPda);
      const consumed = await program.account.entryTokenAccount.fetch(token.pda);
      const userAfter = await program.account.userAccount.fetch(
        deriveUser(user1.publicKey)
      );
      expect(entry.currencyIdx).to.equal(255);
      expect(consumed.consumed).to.equal(true);
      expect((await tokenAmount(usdcOpRevPda)) - opBefore).to.equal(0);
      expect(userAfter.seeds.toNumber() - userBefore.seeds.toNumber()).to.equal(
        25
      );

      await expectRejected(
        enterWithToken(
          tokenContest,
          user1,
          deriveUser(user1.publicKey),
          token.pda,
          1
        ),
        /EntryTokenAlreadyConsumed/i
      );

      const wrongOwnerToken = await mintEntryToken(
        user1.publicKey,
        "wrong-owner-token"
      );
      await expectRejected(
        enterWithToken(
          tokenContest,
          user2,
          deriveUser(user2.publicKey),
          wrongOwnerToken.pda,
          0
        ),
        /EntryTokenWrongOwner/i
      );
    });

    // ── burn_entry_token: the operator claw-back ─────────────────────────
    //
    // The property under test is that a burn STICKS. Rails derives what a user
    // is owed from the on-chain token COUNT, so a burn that removed the account
    // would re-read as owed and be re-minted by the next sweep. Everything here
    // is ultimately checking that the account survives while its spending power
    // does not.
    it("burns an unspent voucher as a tombstone the account survives", async () => {
      const token = await mintEntryToken(user1.publicKey, "burn-me-plain");
      const before = await program.account.entryTokenAccount.fetch(token.pda);
      expect(before.consumed).to.equal(false);
      expect(before.source).to.equal(0);

      await burnEntryToken(token);

      // NOT closed. This is the whole design: `getAccountInfo` must still find
      // it, or Rails' owed math re-opens the debt this burn just settled.
      const info = await provider.connection.getAccountInfo(token.pda);
      expect(info, "a burned token must NOT be closed — the count is load-bearing")
        .to.not.equal(null);

      const after = await program.account.entryTokenAccount.fetch(token.pda);
      expect(after.consumed, "consumed is what blocks the spend").to.equal(true);
      expect(after.consumedAt).to.not.equal(null);
      // source = OPERATOR(0) | BURNED_FLAG(0x80). The provenance half survives
      // in the low 7 bits so the audit trail still says where the token came
      // from.
      expect(after.source, "the burn flag rides in source's high bit").to.equal(128);
      expect(after.source & 0x7f, "provenance must survive the burn").to.equal(0);
      expect(after.owner.toBase58()).to.equal(user1.publicKey.toBase58());
    });

    it("a burned voucher can no longer fund an entry", async () => {
      const burnContest = await createContest("burned-token-contest", {
        fees: { 0: amount(3) },
        prizePool: amount(3),
        payouts: [amount(3)],
      });
      const token = await mintEntryToken(user1.publicKey, "burn-then-try-entry");
      await burnEntryToken(token);

      // The point of the feature. `consumed` is the guard
      // enter_contest_with_token already carried, which is exactly why the burn
      // sets it rather than introducing a new field the old accounts lack.
      await expectRejected(
        enterWithToken(
          burnContest,
          user1,
          deriveUser(user1.publicKey),
          token.pda,
          0
        ),
        /EntryTokenAlreadyConsumed/i
      );
    });

    it("refuses a double burn and refuses to burn a SPENT voucher", async () => {
      const doubleContest = await createContest("double-burn-contest", {
        fees: { 0: amount(2) },
        prizePool: amount(2),
        payouts: [amount(2)],
      });

      // Double burn. Rejected by its OWN guard, not by the consumed guard —
      // a burn sets consumed itself, so without the flag check a re-burn would
      // be accepted and would overwrite consumedAt, destroying the record of
      // when the burn actually happened.
      const twice = await mintEntryToken(user1.publicKey, "burn-me-twice");
      await burnEntryToken(twice);
      const stampedAt = (
        await program.account.entryTokenAccount.fetch(twice.pda)
      ).consumedAt;
      await expectRejected(burnEntryToken(twice), /EntryTokenAlreadyBurned/i);
      expect(
        (await program.account.entryTokenAccount.fetch(twice.pda)).consumedAt!.toString(),
        "a refused re-burn must not move the original burn timestamp"
      ).to.equal(stampedAt!.toString());

      // Spent, then burned. Burning a token that already funded a real entry
      // would rewrite the history of an entry that exists and stands.
      const spent = await mintEntryToken(user1.publicKey, "spend-then-burn");
      await enterWithToken(
        doubleContest,
        user1,
        deriveUser(user1.publicKey),
        spent.pda,
        0
      );
      await expectRejected(burnEntryToken(spent), /EntryTokenAlreadyConsumed/i);
    });

    it("only a vault signer may burn, and the hash must name the token", async () => {
      const token = await mintEntryToken(user1.publicKey, "burn-auth-checks");

      // A stranger holding no vault seat cannot destroy a user's property.
      await expectRejected(burnEntryToken(token, stranger), /Unauthorized/i);

      // The fat-finger guard: the account and the ref hash must agree, so an
      // INCONSISTENT pair is rejected. Note the limit of what this covers — a
      // SELF-CONSISTENT pair (another token plus that token's own hash) passes
      // both the seeds check and the handler's assert and burns that token, so
      // the binding is not a targeting control and no case here asserts one.
      const other = await mintEntryToken(user1.publicKey, "burn-wrong-hash-target");
      await expectRejected(
        program.methods
          .burnEntryToken(other.hash as any)
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            entryToken: token.pda,
          })
          .rpc(),
        /ConstraintSeeds|EntryTokenSeedMismatch|seeds constraint/i
      );

      // ...and the token the mismatched call named is untouched.
      expect(
        (await program.account.entryTokenAccount.fetch(token.pda)).consumed
      ).to.equal(false);
      expect(
        (await program.account.entryTokenAccount.fetch(other.pda)).consumed
      ).to.equal(false);
    });

    it("pause blocks paid and token entries only; unpause restores both", async () => {
      const pauseContest = await createContest("pause-contest", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
        maxEntries: 4,
      });

      await program.methods
        .pause(reason("local verification pause") as any)
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      let vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.paused).to.equal(1);

      await expectRejected(
        enterPaid(
          pauseContest,
          user1,
          deriveUser(user1.publicKey),
          user1UsdcAta,
          usdcMint,
          usdcOpRevPda,
          0,
          0
        ),
        /VaultPaused/i
      );

      const pausedToken = await mintEntryToken(
        user1.publicKey,
        "paused-token-mint-still-allowed"
      );
      await expectRejected(
        enterWithToken(
          pauseContest,
          user1,
          deriveUser(user1.publicKey),
          pausedToken.pda,
          1
        ),
        /VaultPaused/i
      );

      await expectRejected(
        program.methods
          .pause(reason("bad cosigner") as any)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: stranger.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
          })
          .signers([stranger])
          .rpc(),
        /Unauthorized/i
      );

      await program.methods
        .unpause()
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      vault = await program.account.vaultState.fetch(vaultStatePda);
      expect(vault.paused).to.equal(0);

      await enterPaid(
        pauseContest,
        user1,
        deriveUser(user1.publicKey),
        user1UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );
      await enterWithToken(
        pauseContest,
        user1,
        deriveUser(user1.publicKey),
        pausedToken.pda,
        1
      );
    });
  });

  describe("settlement, cancellation, closeout, and treasury", () => {
    it("settles a locked contest from prize_pool to winner ATA with 2-of-3", async () => {
      await lockContestNow(paidContest);

      const user1Pda = deriveUser(user1.publicKey);
      const user2Pda = deriveUser(user2.publicKey);
      const user1Entry = deriveEntry(paidContest.id, user1.publicKey, 0);
      const user2Entry = deriveEntry(paidContest.id, user2.publicKey, 1);
      const user1Before = await program.account.userAccount.fetch(user1Pda);
      const prizePoolBefore = await tokenAmount(paidContest.prizePoolPda);
      const user1AtaBefore = await tokenAmount(user1UsdcAta);

      await program.methods
        .settleContest([
          {
            wallet: user1.publicKey,
            entryNum: 0,
            rank: 1,
            payout: bn(amount(40)),
          },
          { wallet: user2.publicKey, entryNum: 1, rank: 2, payout: bn(0) },
        ])
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: paidContest.contestPda,
          prizePool: paidContest.prizePoolPda,
          payoutMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          // SETTLE_CONTEST is 3-of-N, and `admin` + `cosigner` are only two —
          // so one extra cosigner LEADS the winner triples. The program splits
          // at exactly `threshold - 2`, a boundary both sides read off the
          // stored table rather than guessing from the payload length.
          ...cosigners(signer3),
          { pubkey: user1Pda, isSigner: false, isWritable: true },
          { pubkey: user1Entry, isSigner: false, isWritable: true },
          { pubkey: user1UsdcAta, isSigner: false, isWritable: true },
          { pubkey: user2Pda, isSigner: false, isWritable: true },
          { pubkey: user2Entry, isSigner: false, isWritable: true },
          { pubkey: user2UsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([signer2, signer3])
        .rpc();

      const contest = await program.account.contest.fetch(
        paidContest.contestPda
      );
      const user1After = await program.account.userAccount.fetch(user1Pda);
      const entry = await program.account.contestEntry.fetch(user1Entry);
      expect(statusName(contest.status)).to.equal("settled");
      expect(
        prizePoolBefore - (await tokenAmount(paidContest.prizePoolPda))
      ).to.equal(amount(40));
      expect((await tokenAmount(user1UsdcAta)) - user1AtaBefore).to.equal(
        amount(40)
      );
      expect(
        user1After.totalWon.toNumber() - user1Before.totalWon.toNumber()
      ).to.equal(amount(40));
      expect(user1After.wins - user1Before.wins).to.equal(1);
      expect(user1After.cashes - user1Before.cashes).to.equal(1);
      expect(statusName(entry.status)).to.equal("won");
      expect(entry.payout.toNumber()).to.equal(amount(40));
    });

    it("rejects unsafe settlement variants", async () => {
      const unlockedContest = await createContest("settle-before-lock", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      await expectRejected(
        program.methods
          .settleContest([])
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: unlockedContest.contestPda,
            prizePool: unlockedContest.prizePoolPda,
            payoutMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /ContestNotLocked/i
      );

      const duplicateContest = await createContest("settle-duplicate-entry", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      await lockContestNow(duplicateContest);
      await expectRejected(
        program.methods
          .settleContest([
            { wallet: user1.publicKey, entryNum: 0, rank: 1, payout: bn(0) },
            { wallet: user1.publicKey, entryNum: 0, rank: 2, payout: bn(0) },
          ])
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: duplicateContest.contestPda,
            prizePool: duplicateContest.prizePoolPda,
            payoutMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /DuplicateEntry/i
      );

      const badDestinationContest = await createContest(
        "settle-bad-destination",
        {
          fees: { 0: amount(1) },
          prizePool: amount(1),
          payouts: [amount(1)],
        }
      );
      await enterPaid(
        badDestinationContest,
        user1,
        deriveUser(user1.publicKey),
        user1UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );
      await lockContestNow(badDestinationContest);
      await expectRejected(
        program.methods
          .settleContest([
            {
              wallet: user1.publicKey,
              entryNum: 0,
              rank: 1,
              payout: bn(amount(1)),
            },
          ])
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            contest: badDestinationContest.contestPda,
            prizePool: badDestinationContest.prizePoolPda,
            payoutMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts([
            ...cosigners(signer3),
            {
              pubkey: deriveUser(user1.publicKey),
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: deriveEntry(badDestinationContest.id, user1.publicKey, 0),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: user2UsdcAta, isSigner: false, isWritable: true },
          ])
          .signers([signer2, signer3])
          .rpc(),
        /InvalidPayoutDestination/i
      );
    });

    it("cancels open contests by refunding prize pool while preserving op_rev", async () => {
      const cancelContest = await createContest("cancel-contest", {
        fees: { 0: amount(2) },
        prizePool: amount(8),
        payouts: [amount(8)],
      });
      const adminBefore = await tokenAmount(adminUsdcAta);
      const opBefore = await tokenAmount(usdcOpRevPda);
      await enterPaid(
        cancelContest,
        user1,
        deriveUser(user1.publicKey),
        user1UsdcAta,
        usdcMint,
        usdcOpRevPda,
        0,
        0
      );

      await program.methods
        .cancelContest()
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: cancelContest.contestPda,
          prizePool: cancelContest.prizePoolPda,
          payoutMint: usdcMint,
          creatorTokenAccount: adminUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const contest = await program.account.contest.fetch(
        cancelContest.contestPda
      );
      expect(statusName(contest.status)).to.equal("cancelled");
      expect((await tokenAmount(adminUsdcAta)) - adminBefore).to.equal(
        amount(8)
      );
      expect((await tokenAmount(usdcOpRevPda)) - opBefore).to.equal(amount(2));
    });

    it("closes finalized contests and dust-sweeps prize pool to USDC op_rev", async () => {
      const dustContest = await createContest("dust-close-contest", {
        fees: {},
        prizePool: 1,
        payouts: [1],
      });
      await lockContestNow(dustContest);
      await program.methods
        .settleContest([])
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: dustContest.contestPda,
          prizePool: dustContest.prizePoolPda,
          payoutMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      const opBefore = await tokenAmount(usdcOpRevPda);
      await program.methods
        .closeContest()
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          treasury: treasury.publicKey,
          contest: dustContest.contestPda,
          prizePool: dustContest.prizePoolPda,
          payoutMint: usdcMint,
          opRevUsdcAta: usdcOpRevPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer2))
        .signers([signer2])
        .rpc();

      expect(await connection.getAccountInfo(dustContest.contestPda)).to.equal(
        null
      );
      expect(
        await connection.getAccountInfo(dustContest.prizePoolPda)
      ).to.equal(null);
      expect((await tokenAmount(usdcOpRevPda)) - opBefore).to.equal(1);

      const openContest = await createContest("close-open-reject", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      await expectRejected(
        program.methods
          .closeContest()
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            treasury: treasury.publicKey,
            contest: openContest.contestPda,
            prizePool: openContest.prizePoolPda,
            payoutMint: usdcMint,
            opRevUsdcAta: usdcOpRevPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer2))
          .signers([signer2])
          .rpc(),
        /ContestNotSettled/i
      );

      // v0.26: the rent must land on the PINNED treasury, and naming any
      // other account is refused — the whole point of the change is that the
      // destination is not the caller's to choose.
      const rentThief = await createContest("close-rent-thief", {
        fees: { 0: amount(1) },
        prizePool: amount(1),
        payouts: [amount(1)],
      });
      await lockContestNow(rentThief);
      await program.methods
        .settleContest([])
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          contest: rentThief.contestPda,
          prizePool: rentThief.prizePoolPda,
          payoutMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      await expectRejected(
        program.methods
          .closeContest()
          .accountsStrict({
            admin: admin.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            treasury: stranger.publicKey,
            contest: rentThief.contestPda,
            prizePool: rentThief.prizePoolPda,
            payoutMint: usdcMint,
            opRevUsdcAta: usdcOpRevPda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer2))
          .signers([signer2])
          .rpc(),
        /InvalidRentDestination/i
      );

      // And the honest close CREDITS the treasury rather than the caller.
      const treasuryBefore = await connection.getBalance(treasury.publicKey);
      await program.methods
        .closeContest()
        .accountsStrict({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          treasury: treasury.publicKey,
          contest: rentThief.contestPda,
          prizePool: rentThief.prizePoolPda,
          payoutMint: usdcMint,
          opRevUsdcAta: usdcOpRevPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer2))
        .signers([signer2])
        .rpc();
      expect(
        await connection.getBalance(treasury.publicKey)
      ).to.be.greaterThan(treasuryBefore);
    });

    it("sweeps operator revenue only to pinned treasury ATA", async () => {
      await expectRejected(
        program.methods
          .sweepOperatorRevenue(bn(0))
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            currencyMint: usdtMint,
            opRevAta: usdtOpRevPda,
            treasuryAta: wrongTreasuryUsdtAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /TreasuryAuthorityMismatch/i
      );

      const treasuryBefore = await tokenAmount(treasuryUsdcAta);
      const opBefore = await tokenAmount(usdcOpRevPda);
      expect(opBefore).to.be.greaterThan(0);

      await program.methods
        .sweepOperatorRevenue(bn(0))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          currencyMint: usdcMint,
          opRevAta: usdcOpRevPda,
          treasuryAta: treasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();

      expect(await tokenAmount(usdcOpRevPda)).to.equal(0);
      expect((await tokenAmount(treasuryUsdcAta)) - treasuryBefore).to.equal(
        opBefore
      );

      await expectRejected(
        program.methods
          .sweepOperatorRevenue(bn(0))
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            currencyMint: usdcMint,
            opRevAta: usdcOpRevPda,
            treasuryAta: treasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /EmptyRevenueAccount/i
      );

      const usdtTreasuryBefore = await tokenAmount(treasuryUsdtAta);
      const usdtOpBefore = await tokenAmount(usdtOpRevPda);
      await program.methods
        .sweepOperatorRevenue(bn(amount(3)))
        .accountsStrict({
          admin: admin.publicKey,
          cosigner: signer2.publicKey,
          vaultState: vaultStatePda,
          governance: governancePda,
          currencyMint: usdtMint,
          opRevAta: usdtOpRevPda,
          treasuryAta: treasuryUsdtAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(cosigners(signer3))
        .signers([signer2, signer3])
        .rpc();
      expect(usdtOpBefore - (await tokenAmount(usdtOpRevPda))).to.equal(
        amount(3)
      );
      expect(
        (await tokenAmount(treasuryUsdtAta)) - usdtTreasuryBefore
      ).to.equal(amount(3));
    });

    it("rejects a full currency registry", async () => {
      for (let slot = 3; slot < MAX_CURRENCIES; slot++) {
        const mint = await createMint(
          connection,
          admin.payer,
          admin.publicKey,
          null,
          DECIMALS
        );
        await program.methods
          .registerCurrency(1)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            mint,
            opRevAta: deriveOpRev(mint),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc();
      }

      const overflowMint = await createMint(
        connection,
        admin.payer,
        admin.publicKey,
        null,
        DECIMALS
      );
      await expectRejected(
        program.methods
          .registerCurrency(1)
          .accountsStrict({
            admin: admin.publicKey,
            cosigner: signer2.publicKey,
            vaultState: vaultStatePda,
            governance: governancePda,
            mint: overflowMint,
            opRevAta: deriveOpRev(overflowMint),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts(cosigners(signer3))
          .signers([signer2, signer3])
          .rpc(),
        /CurrencyRegistryFull/i
      );
    });
  });
});
