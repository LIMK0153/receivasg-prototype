// Deploys the ReceivaSG contract suite and seeds the demo data.
// Used by: Hardhat tests, scripts/deploy.js (local node / Sepolia), and the
// frontend's in-browser sandbox chain — so all three run identical logic.

import { ACTORS, DAY } from "./constants.mjs";
import { makeEInvoice, hashEInvoice } from "./einvoice.mjs";

export const cents = (sgd) => BigInt(Math.round(sgd * 100));

export async function deployCore({ ethers, artifacts, admin, bank, treasury, log = () => {} }) {
  const deploy = async (name, signer, ...args) => {
    const factory = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    const address = await c.getAddress();
    log({ kind: "deploy", name, address, hash: c.deploymentTransaction()?.hash });
    return c;
  };
  const adminAddr = await admin.getAddress();
  const bankAddr = await bank.getAddress();
  const treasuryAddr = await treasury.getAddress();

  const tsgd = await deploy("TokenisedSGD", bank, bankAddr);
  const registry = await deploy("IdentityRegistry", admin, adminAddr);
  const nft = await deploy("InvoiceNFT", admin, adminAddr);
  const noteImpl = await deploy("ReceivableNote", admin);
  const spv = await deploy(
    "ReceivaSPV", admin,
    adminAddr, await tsgd.getAddress(), await registry.getAddress(), await nft.getAddress(), await noteImpl.getAddress(), treasuryAddr
  );
  const wire = await nft.setSPV(await spv.getAddress());
  await wire.wait();
  log({ kind: "tx", label: "InvoiceNFT.setSPV — SPV is the only minter", hash: wire.hash });
  const market = await deploy("DDExMarket", admin, await tsgd.getAddress(), await spv.getAddress());

  return { tsgd, registry, nft, noteImpl, spv, market };
}

export async function addressesOf(contracts) {
  const out = {};
  for (const [k, c] of Object.entries(contracts)) out[k] = await c.getAddress();
  return out;
}

/**
 * Seeds identities, tSGD balances and three background invoices so the marketplace,
 * portfolios and secondary market are populated before the live demo starts.
 *
 * @param signers   ethers Signers keyed by actor id (admin, bank required; others optional)
 * @param addresses wallet address keyed by actor id (all actors)
 * @param chainNow  current chain timestamp (seconds)
 * @param seedMarket whether to create the background invoices (needs bgSme1, bgSme2, investorA/B/C signers)
 */
export async function seedDemo({ ethers, contracts, signers, addresses, chainNow, seedMarket = true, log = () => {} }) {
  const { tsgd, registry, spv, market } = contracts;
  const send = async (label, txPromise) => {
    const tx = await txPromise;
    const r = await tx.wait();
    log({ kind: "tx", label, hash: r.hash, gas: r.gasUsed?.toString() });
    return r;
  };

  // 1 ── KYC/AML identities (only a hash of the off-chain record goes on-chain)
  const expiry = BigInt(chainNow + 365 * DAY);
  const ids = [
    ["sme", 1], ["bgSme1", 1], ["bgSme2", 1],
    ["buyer", 2], ["bgBuyer1", 2], ["bgBuyer2", 2], ["bgBuyer3", 2],
    ["investorA", 3], ["investorB", 4], ["investorC", 3],
  ];
  const reg = registry.connect(signers.admin);
  for (const [actor, category] of ids) {
    await send(
      `Register identity: ${ACTORS[actor].name}`,
      reg.registerIdentity(addresses[actor], category, 702, expiry, ethers.id(`kyc-record:${ACTORS[actor].name}`))
    );
  }

  // 2 ── Tokenised SGD deposits
  const balances = { investorA: 500_000, investorB: 1_000_000, investorC: 150_000, buyer: 500_000, unverified: 50_000, admin: 100_000 };
  const bank = tsgd.connect(signers.bank);
  for (const [actor, sgd] of Object.entries(balances)) {
    await send(`Credit S$${sgd.toLocaleString("en-SG")} tSGD → ${ACTORS[actor].name}`, bank.mint(addresses[actor], cents(sgd)));
  }

  if (!seedMarket) return { mainInvoiceId: null };

  // 3 ── Background invoices so the marketplace isn't empty
  const spvAddr = await spv.getAddress();
  const invest = async (actor, id, sgd) => {
    const s = signers[actor];
    const who = await s.getAddress();
    const outstanding = await spv.outstandingCommitted(who);
    await send(`${ACTORS[actor].short}: approve tSGD`, tsgd.connect(s).approve(spvAddr, outstanding + cents(sgd)));
    await send(`${ACTORS[actor].short}: commit S$${sgd.toLocaleString("en-SG")} to invoice #${id}`, spv.connect(s).commit(id, cents(sgd)));
  };
  const originate = async ({ smeKey, buyerKey, ref, sgd, days, grade, description }) => {
    const doc = makeEInvoice({
      ref, supplier: ACTORS[smeKey], buyer: ACTORS[buyerKey], faceValueSgd: sgd,
      issueDate: chainNow, dueDate: chainNow + days * DAY, description,
    });
    const hash = hashEInvoice(ethers, doc);
    const s = spv.connect(signers[smeKey]);
    const r = await send(`${ACTORS[smeKey].short}: submit ${ref}`, s.submitInvoice(hash, ref, addresses[buyerKey], cents(sgd), BigInt(chainNow + days * DAY)));
    const id = Number(await spv.invoiceCount());
    await send(`ReceivaSG: verify & grade ${ref}`, spv.connect(signers.admin).verifyAndGrade(id, grade));
    await send(`${ACTORS[smeKey].short}: accept offer (true sale) ${ref}`, s.acceptOffer(id));
    return id;
  };

  const id1 = await originate({ smeKey: "bgSme1", buyerKey: "bgBuyer1", ref: "KP-2026-1187", sgd: 250_000, days: 120, grade: 0, description: "Precision-machined valve assemblies" });
  await invest("investorB", id1, 150_000);

  const id2 = await originate({ smeKey: "bgSme2", buyerKey: "bgBuyer3", ref: "TFF-2026-0342", sgd: 40_000, days: 240, grade: 6, description: "Chilled produce supply contract, Q4" });
  await invest("investorA", id2, 5_000);

  const id3 = await originate({ smeKey: "bgSme1", buyerKey: "bgBuyer2", ref: "KP-2026-1203", sgd: 80_000, days: 120, grade: 3, description: "Structural steel brackets" });
  await invest("investorA", id3, 40_000);
  const inv3 = await spv.getInvoice(id3);
  const remaining = Number(inv3.price - inv3.committed) / 100;
  await invest("investorC", id3, remaining); // fills the book → atomic settlement

  // Jasmine lists part of her position on the (simulated) DDEx secondary market
  const noteAddr = await spv.noteOf(id3);
  const note = new ethers.Contract(noteAddr, contracts.noteImpl.interface, signers.investorC);
  const lot = cents(10_000); // S$10,000 face of notes
  await send("Jasmine Koh: approve notes for DDEx", note.approve(await market.getAddress(), lot));
  await send("Jasmine Koh: list S$10,000 face on DDEx at S$9,880", market.connect(signers.investorC).list(id3, lot, cents(9_880)));

  return { backgroundIds: [id1, id2, id3] };
}
