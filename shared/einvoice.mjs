// Simplified Peppol BIS Billing 3.0 (UBL) e-invoice, as it would arrive at ReceivaSG
// through InvoiceNow. Only the hash of this document goes on-chain.

export function makeEInvoice({ ref, supplier, buyer, faceValueSgd, issueDate, dueDate, description, buyerApproved = true }) {
  const gstRate = 9;
  const net = Math.round((faceValueSgd / (1 + gstRate / 100)) * 100) / 100;
  const gst = Math.round((faceValueSgd - net) * 100) / 100;
  return {
    customizationID: "urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:sg:3.0",
    profileID: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
    id: ref,
    issueDate: isoDate(issueDate),
    dueDate: isoDate(dueDate),
    currency: "SGD",
    supplier: { name: supplier.name, uen: supplier.uen, peppolId: `0195:SGUEN${supplier.uen}` },
    buyer: { name: buyer.name, uen: buyer.uen, peppolId: `0195:SGUEN${buyer.uen}` },
    lines: [{ description, net, gstRate, gst }],
    totals: { taxExclusive: net, tax: gst, payable: faceValueSgd },
    paymentTerms: `Net ${Math.round((dueDate - issueDate) / 86400)} days`,
    // Peppol Invoice Response (buyer approval) received via the InvoiceNow network
    buyerResponse: buyerApproved ? { code: "AP", meaning: "Accepted by buyer" } : { code: "UQ", meaning: "Under query" },
  };
}

/** keccak256 of the canonical JSON document. */
export function hashEInvoice(ethers, doc) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(doc)));
}

function isoDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
