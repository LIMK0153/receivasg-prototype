// Copies ABI + bytecode of the compiled contracts into shared/artifacts.json so the
// frontend (in-browser chain) and the deploy script use exactly the same build.
const fs = require("fs");
const path = require("path");

const NAMES = ["TokenisedSGD", "IdentityRegistry", "InvoiceNFT", "ReceivableNote", "ReceivaSPV", "DDExMarket"];
const out = {};
for (const name of NAMES) {
  const file = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  const a = JSON.parse(fs.readFileSync(file, "utf8"));
  out[name] = { abi: a.abi, bytecode: a.bytecode };
}
const dest = path.join(__dirname, "..", "shared", "artifacts.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`exported ${NAMES.length} contracts → shared/artifacts.json`);
