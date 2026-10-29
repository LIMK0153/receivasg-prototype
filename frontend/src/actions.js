// Every user action in the prototype is one or more real contract transactions.
import { ethers } from "ethers";
import { ACTORS, DAY } from "../../shared/constants.mjs";

const tok = (u) => (u / 100).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (c) => `S$${(c / 100).toLocaleString("en-SG", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function makeActions(client) {
  const { read, addresses } = client;
  const spvAt = (s) => read.spv.connect(s);

  return {
    /** entry = an InvoiceNow inbox item: { doc, hash, buyerKey, dueTs } */
    submitInvoice: (actor, entry, labelSuffix = "for financing") =>
      client.send(actor, `${ACTORS[actor].short}: submit ${entry.doc.id} ${labelSuffix}`, (s) =>
        spvAt(s).submitInvoice(
          entry.hash,
          entry.doc.id,
          client.actors[entry.buyerKey],
          BigInt(Math.round(entry.doc.totals.payable * 100)),
          BigInt(entry.dueTs)
        )
      ),

    verifyAndGrade: (id, ref, grade, gradeName) =>
      client.send("admin", `ReceivaSG: verify ${ref} on InvoiceNow, grade ${gradeName}`, (s) => spvAt(s).verifyAndGrade(id, grade)),

    rejectInvoice: (id, ref, reason) =>
      client.send("admin", `ReceivaSG: reject ${ref}`, (s) => spvAt(s).rejectInvoice(id, reason)),

    acceptOffer: (actor, id, ref) =>
      client.send(actor, `${ACTORS[actor].short}: accept offer, sell ${ref} to the SPV`, (s) => spvAt(s).acceptOffer(id)),

    counterOffer: (actor, id, ref, cents) =>
      client.send(actor, `${ACTORS[actor].short}: counter-offer ${fmt(cents)} for ${ref}`, (s) => spvAt(s).counterOffer(id, BigInt(cents))),

    reviewCounter: (id, ref, approve) =>
      client.send("admin", `ReceivaSG: ${approve ? "approve" : "reject"} counter-offer on ${ref}`, (s) => spvAt(s).reviewCounter(id, approve)),

    declineOffer: (actor, id, ref) =>
      client.send(actor, `${ACTORS[actor].short}: decline offer for ${ref}`, (s) => spvAt(s).declineOffer(id)),

    /** approve tSGD (covering all open commitments) then commit */
    async invest(actor, id, cents, ref) {
      const outstanding = await read.spv.outstandingCommitted(client.actors[actor]);
      const allowance = await read.tsgd.allowance(client.actors[actor], addresses.spv);
      const need = outstanding + BigInt(cents);
      if (allowance < need) {
        await client.send(actor, `${ACTORS[actor].short}: approve SPV to draw ${fmt(Number(need))} tSGD at settlement`, (s) =>
          read.tsgd.connect(s).approve(addresses.spv, need)
        );
      }
      return client.send(actor, `${ACTORS[actor].short}: commit ${fmt(cents)} to ${ref}`, (s) => spvAt(s).commit(id, BigInt(cents)));
    },

    withdrawCommitment: (actor, id, ref) =>
      client.send(actor, `${ACTORS[actor].short}: withdraw commitment from ${ref}`, (s) => spvAt(s).withdrawCommitment(id)),

    async listNotes(actor, inv, amount, price) {
      const note = client.note(inv.note);
      const allowed = await note.allowance(client.actors[actor], addresses.market);
      if (allowed < BigInt(amount)) {
        await client.send(actor, `${ACTORS[actor].short}: approve DDEx to transfer ${inv.noteSymbol} tokens`, (s) =>
          note.connect(s).approve(addresses.market, BigInt(amount))
        );
      }
      return client.send(actor, `${ACTORS[actor].short}: list ${tok(amount)} ${inv.noteSymbol} tokens on DDEx at ${fmt(price)}`, (s) =>
        read.market.connect(s).list(inv.id, BigInt(amount), BigInt(price))
      );
    },

    cancelListing: (actor, listing) =>
      client.send(actor, `${ACTORS[actor].short}: cancel DDEx listing #${listing.id}`, (s) => read.market.connect(s).cancel(listing.id)),

    async buyListing(actor, listing, symbol) {
      const allowance = await read.tsgd.allowance(client.actors[actor], addresses.market);
      if (allowance < BigInt(listing.price)) {
        await client.send(actor, `${ACTORS[actor].short}: approve DDEx to draw ${fmt(listing.price)} tSGD`, (s) =>
          read.tsgd.connect(s).approve(addresses.market, BigInt(listing.price))
        );
      }
      return client.send(actor, `${ACTORS[actor].short}: buy ${tok(listing.amount)} ${symbol} tokens on DDEx`, (s) =>
        read.market.connect(s).buy(listing.id)
      );
    },

    transferNotes: (actor, inv, toKey, amount) =>
      client.send(actor, `${ACTORS[actor].short}: transfer ${inv.noteSymbol} tokens to ${ACTORS[toKey]?.short || toKey}`, (s) =>
        client.note(inv.note).connect(s).transfer(client.actors[toKey], BigInt(amount))
      ),

    async repay(actor, inv) {
      const allowance = await read.tsgd.allowance(client.actors[actor], addresses.spv);
      if (allowance < BigInt(inv.face)) {
        await client.send(actor, `${ACTORS[actor].short}: approve payment of ${fmt(inv.face)}`, (s) =>
          read.tsgd.connect(s).approve(addresses.spv, BigInt(inv.face))
        );
      }
      return client.send(actor, `${ACTORS[actor].short}: pay ${inv.ref} (${fmt(inv.face)}) to the SPV`, (s) => spvAt(s).repay(inv.id));
    },

    registerInvestor: (key, category) =>
      client.send("admin", `ReceivaSG: complete KYC for ${ACTORS[key].short}`, async (s) => {
        const { time } = await client.now();
        return read.registry
          .connect(s)
          .registerIdentity(client.actors[key], category, 702, BigInt(time + 365 * DAY), ethers.id(`kyc-record:${ACTORS[key].name}`));
      }),

    removeIdentity: (key) =>
      client.send("admin", `ReceivaSG: revoke KYC for ${ACTORS[key].short}`, (s) => read.registry.connect(s).removeIdentity(client.actors[key])),

    pauseNote: (inv, paused) =>
      client.send("admin", `ReceivaSG: ${paused ? "pause" : "resume"} transfers of ${inv.noteSymbol}`, (s) => spvAt(s).pauseNote(inv.id, paused)),

    removeCommitment: (id, investorKey) =>
      client.send("admin", `ReceivaSG: remove failed commitment from ${ACTORS[investorKey]?.short}`, (s) =>
        spvAt(s).removeCommitment(id, client.actors[investorKey])
      ),

    settleDefault: (inv, recovered) =>
      client.send("admin", `ReceivaSG: record default on ${inv.ref}, distribute ${fmt(recovered)} recovered`, async (s) => {
        if (recovered > 0) {
          const tx = await read.tsgd.connect(s).approve(addresses.spv, BigInt(recovered));
          await tx.wait();
        }
        return spvAt(s).settleDefault(inv.id, BigInt(recovered));
      }),

    fastForward: (days) => client.increaseTime(days * DAY),
    fastForwardSeconds: (secs) => client.increaseTime(Math.max(1, secs)),
  };
}
