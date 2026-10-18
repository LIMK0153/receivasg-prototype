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
    const keys = ["admin", "bank", "treasury", "sme", "buyer", "investorA", "investorB", "investorC", "unverified", "bgSme1", "bgSme2", "bgBuyer1", "bgBuyer2", "bgBuyer3"];
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

  async function fundMain() {
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2); // A
    await c.spv.connect(a.sme).acceptOffer(id);
    await invest(a.investorA, id, 50_000);
    await invest(a.investorB, id, 30_000);
    await invest(a.investorC, id, 18_000);
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
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    const inv = await c.spv.getInvoice(id);
    expect(inv.price).to.equal(S(98_000));
    expect(inv.floorApplied).to.equal(false);
    expect(inv.status).to.equal(2n); // Offered
  });

  it("true sale on acceptance: Invoice NFT minted to the SPV and note series created", async () => {
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    await expect(c.spv.connect(a.sme).acceptOffer(id))
      .to.emit(c.spv, "NoticeOfAssignment").withArgs(id, a.buyer.address, await c.spv.getAddress());
    expect(await c.nft.ownerOf(id)).to.equal(await c.spv.getAddress());
    const inv = await c.spv.getInvoice(id);
    expect(inv.note).to.not.equal(ethers.ZeroAddress);
    expect(await note(inv.note).symbol()).to.equal(`RSN-${id}`);
  });

  it("pooled funding: cash stays with investors until the book fills, then settles atomically", async () => {
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    await c.spv.connect(a.sme).acceptOffer(id);
    const smeBefore = await c.tsgd.balanceOf(a.sme.address);
    const aBefore = await c.tsgd.balanceOf(a.investorA.address);

    await invest(a.investorA, id, 50_000);
    await invest(a.investorB, id, 30_000);
    // no escrow: committed cash has not moved yet
    expect(await c.tsgd.balanceOf(a.investorA.address)).to.equal(aBefore);
    expect(await c.tsgd.balanceOf(await c.spv.getAddress())).to.equal(0n);

    const tx = invest(a.investorC, id, 18_000); // fills S$98,000
    await expect(tx).to.emit(c.spv, "AtomicSettlement").withArgs(id, a.sme.address, S(98_000), 3, S(100_000));

    expect(await c.tsgd.balanceOf(a.sme.address) - smeBefore).to.equal(S(98_000));
    expect(await c.tsgd.balanceOf(await c.spv.getAddress())).to.equal(0n); // no float
    const inv = await c.spv.getInvoice(id);
    expect(inv.status).to.equal(4n);
    const n = note(inv.note);
    expect(await n.totalSupply()).to.equal(S(100_000)); // 1 note = S$1 face
    // Investor A paid S$50,000 for 50,000/98,000 of the face value
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
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    await c.spv.connect(a.sme).acceptOffer(id);
    await c.tsgd.connect(a.unverified).approve(await c.spv.getAddress(), S(10_000));
    await expect(c.spv.connect(a.unverified).commit(id, S(10_000)))
      .to.be.revertedWithCustomError(c.spv, "NotEligibleInvestor");
  });

  it("secondary trade on DDEx is atomic DvP and changes who gets paid at maturity", async () => {
    const id = await fundMain();
    const n = note((await c.spv.getInvoice(id)).note);
    const lot = await n.balanceOf(a.investorC.address);
    await n.connect(a.investorC).approve(await c.market.getAddress(), lot);
    await c.market.connect(a.investorC).list(id, lot, S(18_200));
    const listingId = (await c.market.listingCount()) - 1n;

    // unverified buyer is blocked inside the note contract
    await c.tsgd.connect(a.unverified).approve(await c.market.getAddress(), S(18_200));
    await expect(c.market.connect(a.unverified).buy(listingId)).to.be.revertedWithCustomError(n, "TransferNotCompliant").withArgs(5);

    const cBefore = await c.tsgd.balanceOf(a.investorC.address);
    await c.tsgd.connect(a.investorB).approve(await c.market.getAddress(), S(18_200));
    await c.market.connect(a.investorB).buy(listingId);
    expect(await c.tsgd.balanceOf(a.investorC.address) - cBefore).to.equal(S(18_200));
    expect(await n.balanceOf(a.investorC.address)).to.equal(0n);

    await c.tsgd.connect(a.buyer).approve(await c.spv.getAddress(), S(100_000));
    const bBefore = await c.tsgd.balanceOf(a.investorB.address);
    await c.spv.connect(a.buyer).repay(id);
    const bHold = (S(30_000) * S(100_000)) / S(98_000) + lot;
    expect(await c.tsgd.balanceOf(a.investorB.address) - bBefore).to.be.closeTo((S(99_900) * bHold) / S(100_000), 2n);
  });

  it("rejects the same e-invoice twice (double-pledge guard)", async () => {
    const { id, hash, doc } = await submitMain();
    const now = await time.latest();
    await expect(c.spv.connect(a.sme).submitInvoice(hash, doc.id, a.buyer.address, S(100_000), now + 90 * DAY))
      .to.be.revertedWithCustomError(c.spv, "DuplicateInvoice").withArgs(id);
  });

  it("applies the 85% minimum financing percentage", async () => {
    const [price, floorApplied] = await c.spv.quote(S(40_000), 6, 240 * DAY);
    expect(price).to.equal(S(34_000));
    expect(floorApplied).to.equal(true);
    const [p2, f2] = await c.spv.quote(S(40_000), 6, 90 * DAY);
    expect(p2).to.equal(S(37_200)); // 7% discount, above floor
    expect(f2).to.equal(false);
  });

  it("enforces higher minimum tickets for higher grades", async () => {
    await c.tsgd.connect(a.investorC).approve(await c.spv.getAddress(), S(5_000));
    await expect(c.spv.connect(a.investorC).commit(1, S(5_000))) // invoice 1 is AAA
      .to.be.revertedWithCustomError(c.spv, "BelowMinimumTicket").withArgs(S(25_000));
  });

  it("settlement is all-or-nothing: one failed cash leg reverts everything", async () => {
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    await c.spv.connect(a.sme).acceptOffer(id);
    await invest(a.investorA, id, 50_000);
    await invest(a.investorB, id, 30_000);
    await c.tsgd.connect(a.investorA).approve(await c.spv.getAddress(), 0); // A pulls approval
    const smeBefore = await c.tsgd.balanceOf(a.sme.address);
    await expect(invest(a.investorC, id, 18_000)).to.be.revertedWithCustomError(c.spv, "SettlementFailed").withArgs(a.investorA.address);
    expect(await c.tsgd.balanceOf(a.sme.address)).to.equal(smeBefore);
    // ops removes the failed commitment, book reopens, and can be filled again
    await c.spv.connect(a.admin).removeCommitment(id, a.investorA.address);
    expect((await c.spv.getInvoice(id)).committed).to.equal(S(30_000));
    await invest(a.investorB, id, 68_000);
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
    const { id } = await submitMain();
    await c.spv.connect(a.admin).verifyAndGrade(id, 2);
    await expect(c.spv.connect(a.bgSme1).acceptOffer(id)).to.be.revertedWithCustomError(c.spv, "NotSupplier");
    await expect(c.spv.connect(a.sme).verifyAndGrade(id, 0)).to.be.reverted; // not a verifier
  });
});
