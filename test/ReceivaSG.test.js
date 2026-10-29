const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const artifacts = require("../shared/artifacts.json");

const DAY = 86400;
const S = (sgd) => BigInt(Math.round(sgd * 100)); // S$ → cents

describe("ReceivaSG prototype", function () {
  let suite, constants, einv;
  let c, a; // contracts, actor signers

  before(async () => {
    suite = await import("../shared/deploySuite.mjs");
    constants = await import("../shared/constants.mjs");
    einv = await import("../shared/einvoice.mjs");
  });

  beforeEach(async () => {
    const s = await ethers.getSigners();
    const keys = Object.keys(constants.ACTORS);
    a = {};
    keys.forEach((k, i) => (a[k] = s[i]));
    c = await suite.deployCore({ ethers, artifacts, admin: a.admin, bank: a.bank, treasury: a.treasury });
    const addresses = {};
    for (const k of keys) addresses[k] = a[k].address;
    await suite.seedDemo({ ethers, contracts: c, signers: a, addresses, chainNow: await time.latest(), seedMarket: true });
  });

  const note = (addr) => new ethers.Contract(addr, artifacts.ReceivableNote.abi, ethers.provider);

  async function submitMain(opts = {}) {
    const now = await time.latest();
    const days = opts.days ?? 90;
    const doc = einv.makeEInvoice({
      ref: opts.ref ?? "INV-2026-0412",
      supplier: constants.ACTORS.sme, buyer: constants.ACTORS.buyer,
      faceValueSgd: opts.sgd ?? 100_000, issueDate: now, dueDate: now + days * DAY,
      description: "Marine pump overhaul — 3 vessels",
    });
    const hash = einv.hashEInvoice(ethers, doc);
    await c.spv.connect(a.sme).submitInvoice(hash, doc.id, a.buyer.address, S(opts.sgd ?? 100_000), now + days * DAY);
    return { id: Number(await c.spv.invoiceCount()), hash, doc };
  }

  async function invest(who, id, sgd) {
    const out = await c.spv.outstandingCommitted(who.address);
    await c.tsgd.connect(who).approve(await c.spv.getAddress(), out + S(sgd));
    return c.spv.connect(who).commit(id, S(sgd));
  }

  async function offered(grade = 2) {
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, grade);
    return id;
  }

  // Press-release flow: Lion Gate S$50,000 + Lim & Pang S$48,000 = S$98,000
  async function fundMain() {
    const id = await offered(2); // A
    await c.spv.connect(a.sme).acceptOffer(id);
    await invest(a.investorA, id, 50_000);
    await invest(a.investorB, id, 48_000);
    return id;
  }

  it("seeds three background invoices and a DDEx listing", async () => {
    expect(await c.spv.invoiceCount()).to.equal(3n);
    expect((await c.spv.getInvoice(1)).status).to.equal(3n); // Listed
    const inv2 = await c.spv.getInvoice(2);
    expect(inv2.floorApplied).to.equal(true);
    expect(inv2.price).to.equal(S(34_000)); // 85% of S$40,000
    expect((await c.spv.getInvoice(3)).status).to.equal(4n); // Funded
    expect(await c.market.listingCount()).to.equal(1n);
  });

  it("prices the press-release example: S$100,000, 90 days, grade A → S$98,000", async () => {
    const id = await offered(2);
    const inv = await c.spv.getInvoice(id);
    expect(inv.price).to.equal(S(98_000));
    expect(inv.floorApplied).to.equal(false);
    expect(inv.status).to.equal(2n); // Offered
  });

  it("true sale on acceptance: Invoice NFT minted to the SPV and note series created", async () => {
    const id = await offered(2);
    await expect(c.spv.connect(a.sme).acceptOffer(id))
      .to.emit(c.spv, "NoticeOfAssignment").withArgs(id, a.buyer.address, await c.spv.getAddress());
    expect(await c.nft.ownerOf(id)).to.equal(await c.spv.getAddress());
    const inv = await c.spv.getInvoice(id);
    expect(inv.note).to.not.equal(ethers.ZeroAddress);
    expect(await note(inv.note).symbol()).to.equal(`RSN-${id}`);
  });

  it("pooled funding: cash stays with investors until the book fills, then settles atomically", async () => {
    const id = await offered(2);
    await c.spv.connect(a.sme).acceptOffer(id);
    const smeBefore = await c.tsgd.balanceOf(a.sme.address);
    const aBefore = await c.tsgd.balanceOf(a.investorA.address);

    await invest(a.investorA, id, 50_000);
    // no escrow: committed cash has not moved yet
    expect(await c.tsgd.balanceOf(a.investorA.address)).to.equal(aBefore);
    expect(await c.tsgd.balanceOf(await c.spv.getAddress())).to.equal(0n);

    const tx = invest(a.investorB, id, 48_000); // fills S$98,000
    await expect(tx).to.emit(c.spv, "AtomicSettlement").withArgs(id, a.sme.address, S(98_000), 2, S(100_000));

    expect(await c.tsgd.balanceOf(a.sme.address) - smeBefore).to.equal(S(98_000));
    expect(await c.tsgd.balanceOf(await c.spv.getAddress())).to.equal(0n); // no float
    const inv = await c.spv.getInvoice(id);
    expect(inv.status).to.equal(4n);
    const n = note(inv.note);
    expect(await n.totalSupply()).to.equal(S(100_000)); // 1 note = S$1 face
    expect(await n.balanceOf(a.investorA.address)).to.equal((S(50_000) * S(100_000)) / S(98_000));
  });

  it("maturity: buyer pays S$100,000, fee to treasury, rest distributed pro rata, notes retired", async () => {
    const id = await fundMain();
    const inv = await c.spv.getInvoice(id);
    const n = note(inv.note);
    const holdA = await n.balanceOf(a.investorA.address);
    const aBefore = await c.tsgd.balanceOf(a.investorA.address);
    const tBefore = await c.tsgd.balanceOf(a.treasury.address);

    await time.increase(90 * DAY);
    await c.tsgd.connect(a.buyer).approve(await c.spv.getAddress(), S(100_000));
    await expect(c.spv.connect(a.buyer).repay(id)).to.emit(c.spv, "BuyerPaid").withArgs(id, a.buyer.address, S(100_000), S(100));

    expect(await c.tsgd.balanceOf(a.treasury.address) - tBefore).to.equal(S(100));
    const gotA = (await c.tsgd.balanceOf(a.investorA.address)) - aBefore;
    expect(gotA).to.equal((S(99_900) * holdA) / S(100_000));
    expect(await n.totalSupply()).to.equal(0n);
    expect(await n.retired()).to.equal(true);
    expect((await c.nft.recordOf(id)).status).to.equal(5n); // Repaid
    expect(await c.tsgd.balanceOf(await c.spv.getAddress())).to.equal(0n);

    // investor return ≈ 1.94% over 90 days ≈ 7.9% annualised vs 1.92% T-bill
    const ret = Number(gotA - S(50_000)) / Number(S(50_000));
    expect(ret * 365 / 90).to.be.closeTo(0.0786, 0.001);
  });

  it("ERC-3643 compliance: notes cannot move to an unverified wallet", async () => {
    const id = await fundMain();
    const n = note((await c.spv.getInvoice(id)).note);
    expect(await n.canTransfer(a.investorA.address, a.unverified.address, 100)).to.equal(5);
    await expect(n.connect(a.investorA).transfer(a.unverified.address, 100))
      .to.be.revertedWithCustomError(n, "TransferNotCompliant").withArgs(5);
    // SMEs and buyers are verified but not eligible investors either
    await expect(n.connect(a.investorA).transfer(a.sme.address, 100))
      .to.be.revertedWithCustomError(n, "TransferNotCompliant").withArgs(5);
    // eligible → eligible works
    await n.connect(a.investorA).transfer(a.investorB.address, 100);
  });

  it("unverified wallet cannot invest even though it holds tSGD", async () => {
    const id = await offered(2);
    await c.spv.connect(a.sme).acceptOffer(id);
    await c.tsgd.connect(a.unverified).approve(await c.spv.getAddress(), S(10_000));
    await expect(c.spv.connect(a.unverified).commit(id, S(10_000)))
      .to.be.revertedWithCustomError(c.spv, "NotEligibleInvestor");
  });

  it("Lion Gate sells all its notes on DDEx to Lim & Pang, who is paid the full amount at maturity", async () => {
    const id = await fundMain();
    const n = note((await c.spv.getInvoice(id)).note);
    const lot = await n.balanceOf(a.investorA.address);
    await n.connect(a.investorA).approve(await c.market.getAddress(), lot);
    await c.market.connect(a.investorA).list(id, lot, S(50_340));
    const listingId = (await c.market.listingCount()) - 1n;

    // unverified buyer is blocked inside the note contract
    await c.tsgd.connect(a.unverified).approve(await c.market.getAddress(), S(50_340));
    await expect(c.market.connect(a.unverified).buy(listingId)).to.be.revertedWithCustomError(n, "TransferNotCompliant").withArgs(5);

    const aBefore = await c.tsgd.balanceOf(a.investorA.address);
    await c.tsgd.connect(a.investorB).approve(await c.market.getAddress(), S(50_340));
    await c.market.connect(a.investorB).buy(listingId);
    expect(await c.tsgd.balanceOf(a.investorA.address) - aBefore).to.equal(S(50_340));
    expect(await n.balanceOf(a.investorA.address)).to.equal(0n);
    expect(await n.balanceOf(a.investorB.address)).to.equal(S(100_000));

    await c.tsgd.connect(a.buyer).approve(await c.spv.getAddress(), S(100_000));
    const bBefore = await c.tsgd.balanceOf(a.investorB.address);
    await c.spv.connect(a.buyer).repay(id);
    expect(await c.tsgd.balanceOf(a.investorB.address) - bBefore).to.equal(S(99_900));
  });

  it("rejects the same e-invoice twice (double-pledge guard)", async () => {
    const { id, hash, doc } = await submitMain();
    const now = await time.latest();
    await expect(c.spv.connect(a.sme).submitInvoice(hash, doc.id, a.buyer.address, S(100_000), now + 90 * DAY))
      .to.be.revertedWithCustomError(c.spv, "DuplicateInvoice").withArgs(id);
  });

  it("prices CCC at 85% of face for 90 days, and never below the 85% minimum", async () => {
    const [p90] = await c.spv.quote(S(100_000), 6, 90 * DAY);
    expect(p90).to.equal(S(85_000));
    const [p30] = await c.spv.quote(S(100_000), 6, 30 * DAY);
    expect(p30).to.equal(S(95_000));
    const [p240, floored] = await c.spv.quote(S(40_000), 6, 240 * DAY);
    expect(p240).to.equal(S(34_000));
    expect(floored).to.equal(true);
  });

  it("enforces higher minimum tickets for higher grades", async () => {
    await c.tsgd.connect(a.investorA).approve(await c.spv.getAddress(), S(50_000));
    await expect(c.spv.connect(a.investorA).commit(1, S(5_000))) // invoice 1 is AAA
      .to.be.revertedWithCustomError(c.spv, "BelowMinimumTicket").withArgs(S(25_000));
  });

  it("settlement is all-or-nothing: one failed cash leg reverts everything", async () => {
    const id = await offered(2);
    await c.spv.connect(a.sme).acceptOffer(id);
    await invest(a.investorA, id, 50_000);
    await c.tsgd.connect(a.investorA).approve(await c.spv.getAddress(), 0); // Lion Gate pulls approval
    const smeBefore = await c.tsgd.balanceOf(a.sme.address);
    await expect(invest(a.investorB, id, 48_000)).to.be.revertedWithCustomError(c.spv, "SettlementFailed").withArgs(a.investorA.address);
    expect(await c.tsgd.balanceOf(a.sme.address)).to.equal(smeBefore);
    // ops removes the failed commitment, book reopens, and can be filled again
    await c.spv.connect(a.admin).removeCommitment(id, a.investorA.address);
    expect((await c.spv.getInvoice(id)).committed).to.equal(0n);
    await invest(a.investorB, id, 98_000);
    expect((await c.spv.getInvoice(id)).status).to.equal(4n);
  });

  it("default path: after due date + grace, recoveries are shared pro rata, no recourse to SME", async () => {
    const id = await fundMain();
    await expect(c.spv.connect(a.admin).settleDefault(id, 0)).to.be.revertedWithCustomError(c.spv, "NotYetInDefault");
    await time.increase(121 * DAY);
    await c.tsgd.connect(a.admin).approve(await c.spv.getAddress(), S(60_000));
    const aBefore = await c.tsgd.balanceOf(a.investorA.address);
    await c.spv.connect(a.admin).settleDefault(id, S(60_000));
    expect((await c.spv.getInvoice(id)).status).to.equal(6n);
    const gotA = (await c.tsgd.balanceOf(a.investorA.address)) - aBefore;
    expect(gotA).to.be.closeTo((S(60_000) * 5102040n) / 10000000n, 100n);
  });

  it("Invoice NFT is a non-transferable audit record", async () => {
    const id = await fundMain();
    await expect(c.nft.connect(a.admin).transferFrom(await c.spv.getAddress(), a.admin.address, id))
      .to.be.revertedWithCustomError(c.nft, "NonTransferable");
    const uri = await c.nft.tokenURI(id);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    expect(json.attributes[0].value).to.equal("INV-2026-0412");
  });

  it("only the SME that owns the invoice can accept the offer", async () => {
    const id = await offered(2);
    await expect(c.spv.connect(a.bgSme1).acceptOffer(id)).to.be.revertedWithCustomError(c.spv, "NotSupplier");
    await expect(c.spv.connect(a.sme).verifyAndGrade(id, 0)).to.be.reverted; // not a verifier
  });

  describe("counter-offers", () => {
    it("SME counters up to the next-better grade's price; ReceivaSG approves; the counter becomes the price", async () => {
      const id = await offered(1); // AA → S$98,400 for 90 days
      expect((await c.spv.getInvoice(id)).price).to.equal(S(98_400));
      const [min, max] = await c.spv.counterOfferRange(id);
      expect(min).to.equal(S(98_400) + 1n);
      expect(max).to.equal(S(98_750)); // AAA price for the same tenor
      await expect(c.spv.connect(a.sme).counterOffer(id, S(98_600)))
        .to.emit(c.spv, "CounterOffered").withArgs(id, S(98_400), S(98_600));
      // cannot accept while a counter is pending
      await expect(c.spv.connect(a.sme).acceptOffer(id)).to.be.revertedWithCustomError(c.spv, "CounterPending");
      await expect(c.spv.connect(a.admin).reviewCounter(id, true))
        .to.emit(c.spv, "CounterReviewed").withArgs(id, true, S(98_600));
      await c.spv.connect(a.sme).acceptOffer(id);
      await invest(a.investorA, id, 50_000);
      await invest(a.investorB, id, 48_600);
      expect((await c.spv.getInvoice(id)).status).to.equal(4n);
    });

    it("a rejected counter leaves the original offer standing", async () => {
      const id = await offered(1);
      await c.spv.connect(a.sme).counterOffer(id, S(98_700));
      await c.spv.connect(a.admin).reviewCounter(id, false);
      expect((await c.spv.getInvoice(id)).price).to.equal(S(98_400));
      expect(await c.spv.counterPrice(id)).to.equal(0n);
      await c.spv.connect(a.sme).acceptOffer(id);
    });

    it("rejects counters outside the allowed range", async () => {
      const id = await offered(1);
      await expect(c.spv.connect(a.sme).counterOffer(id, S(99_000)))
        .to.be.revertedWithCustomError(c.spv, "CounterOutOfRange").withArgs(S(98_400) + 1n, S(98_750));
      await expect(c.spv.connect(a.sme).counterOffer(id, S(98_000)))
        .to.be.revertedWithCustomError(c.spv, "CounterOutOfRange");
    });

    it("a CCC invoice can be countered up to the B price", async () => {
      const id = await offered(6); // CCC → S$85,000
      const [, max] = await c.spv.counterOfferRange(id);
      expect(max).to.equal(S(95_000)); // B: 5% per 90 days
      await c.spv.connect(a.sme).counterOffer(id, S(90_000));
      await c.spv.connect(a.admin).reviewCounter(id, true);
      expect((await c.spv.getInvoice(id)).price).to.equal(S(90_000));
    });

    it("AAA invoices have no room to counter", async () => {
      const id = await offered(0);
      await expect(c.spv.connect(a.sme).counterOffer(id, S(98_800))).to.be.revertedWithCustomError(c.spv, "CounterOutOfRange");
    });

    it("only the SME can counter and only ReceivaSG can review", async () => {
      const id = await offered(1);
      await expect(c.spv.connect(a.bgSme1).counterOffer(id, S(98_600))).to.be.revertedWithCustomError(c.spv, "NotSupplier");
      await c.spv.connect(a.sme).counterOffer(id, S(98_600));
      await expect(c.spv.connect(a.sme).reviewCounter(id, true)).to.be.reverted;
      await expect(c.spv.connect(a.admin).reviewCounter(id + 99, true)).to.be.reverted;
    });
  });
});
