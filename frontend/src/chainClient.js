// Connects the UI to a chain. Two modes:
//  - "sandbox": boots the in-browser EVM, deploys the real contracts and seeds demo data.
//  - "wallet":  uses window.ethereum (e.g. MetaMask) against contracts already deployed
//               to Sepolia / a Hardhat node by scripts/deploy.js.
import { ethers } from "ethers";
import { SandboxChain } from "./sandboxChain.js";
import artifacts from "../../shared/artifacts.json";
import { deployCore, seedDemo, addressesOf } from "../../shared/deploySuite.mjs";
import { ACTORS, COMPLIANCE_CODES, GRADES, STATUS } from "../../shared/constants.mjs";

export const ACTOR_KEYS = Object.keys(ACTORS);

// One interface containing every contract's errors (deduplicated), for decoding reverts.
const seenFrag = new Set();
const combined = new ethers.Interface(
  Object.values(artifacts)
    .flatMap((a) => a.abi.filter((f) => f.type === "error" || f.type === "event"))
    .filter((f) => {
      const sig = `${f.type}:${f.name}(${f.inputs.map((i) => i.type).join(",")})`;
      if (seenFrag.has(sig)) return false;
      seenFrag.add(sig);
      return true;
    })
);
// Events are decoded with the emitting contract's own ABI (ERC-20 and ERC-721 Transfer share a topic).
const ifaceByName = Object.fromEntries(Object.entries(artifacts).map(([k, a]) => [k, new ethers.Interface(a.abi)]));

const ERROR_TEXT = {
  NotRegisteredSME: () => "This wallet is not registered as an SME supplier.",
  BuyerNotRegistered: () => "The buyer on this invoice is not a registered corporate buyer.",
  DuplicateInvoice: (a) => `This e-invoice has already been submitted to ReceivaSG (invoice #${a[0]}). The same receivable cannot be financed twice.`,
  InvalidTenor: () => "The due date must be between 7 and 365 days away.",
  InvalidAmount: () => "Enter an amount greater than zero.",
  WrongStatus: (a) => `This invoice is currently "${STATUS[Number(a[0])]}", so that action isn't available.`,
  NotSupplier: () => "Only the SME that issued this invoice can do that.",
  NotEligibleInvestor: () => "Blocked by compliance: this wallet is not a KYC-verified accredited or institutional investor.",
  BelowMinimumTicket: (a) => `Below the minimum ticket for this grade (S$${(Number(a[0]) / 100).toLocaleString("en-SG")}).`,
  ExceedsRemaining: (a) => `Only S$${(Number(a[0]) / 100).toLocaleString("en-SG", { minimumFractionDigits: 2 })} is left to fund on this invoice.`,
  InsufficientFundsOrAllowance: () => "Not enough tSGD in this wallet to cover all of its open commitments.",
  SettlementFailed: (a) => `Settlement reverted: investor ${a[0].slice(0, 8)}… could not pay. Nothing moved; ReceivaSG ops can remove that commitment.`,
  TooManyCommitments: () => "This invoice has reached its maximum number of investors.",
  NotYetInDefault: (a) => `Not in default yet. A default can be recorded after ${new Date(Number(a[0]) * 1000).toLocaleDateString("en-SG")}.`,
  InvalidGrade: () => "Grade must be between AAA and C.",
  CounterOutOfRange: (a) => Number(a[1]) < Number(a[0])
    ? "AAA invoices already get the best price, so there is no room for a counter-offer."
    : `A counter-offer must be between S$${(Number(a[0]) / 100).toLocaleString("en-SG", { minimumFractionDigits: 2 })} and S$${(Number(a[1]) / 100).toLocaleString("en-SG", { minimumFractionDigits: 2 })}.`,
  CounterPending: () => "A counter-offer is waiting for ReceivaSG's review. Wait for the decision before accepting.",
  NoCounterPending: () => "There is no counter-offer to review on this invoice.",
  TransferNotCompliant: (a) => `Blocked by the token contract (ERC-3643 check): ${COMPLIANCE_CODES[Number(a[0])]}.`,
  InsufficientAllowance: () => "The marketplace isn't approved to move these tokens yet.",
  NonTransferable: () => "Invoice NFTs are audit records and cannot be transferred.",
  NotTradable: () => "These tokens can't be traded right now (the invoice is not in its funded period).",
  NotSeller: () => "Only the seller can cancel this listing.",
  Inactive: () => "This listing has already been filled or cancelled.",
  InvalidListing: () => "Enter a number of tokens and an asking price.",
  ERC20InsufficientBalance: () => "Not enough tSGD in this wallet.",
  ERC20InsufficientAllowance: () => "tSGD spending was not approved for this amount.",
  AccessControlUnauthorizedAccount: () => "This wallet doesn't have permission for that action.",
};

export function explainError(e) {
  const data = findRevertData(e);
  if (data && data !== "0x") {
    try {
      const parsed = combined.parseError(data);
      if (parsed) {
        const fn = ERROR_TEXT[parsed.name];
        return { name: parsed.name, message: fn ? fn(parsed.args) : parsed.name };
      }
    } catch {}
    try {
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
      return { name: "Error", message: reason };
    } catch {}
  }
  if (e?.code === "ACTION_REJECTED") return { name: "Rejected", message: "You rejected the transaction in your wallet." };
  return { name: "Error", message: e?.shortMessage || e?.message || String(e) };
}

function findRevertData(e) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object" || seen.has(x)) return null;
    seen.add(x);
    if (typeof x.data === "string" && x.data.startsWith("0x")) return x.data;
    for (const k of ["error", "info", "data", "cause"]) {
      const r = walk(x[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(e);
}

export function decodeLog(log, contractName) {
  try {
    const iface = ifaceByName[contractName] || combined;
    const p = iface.parseLog(log);
    if (!p) return null;
    const args = {};
    p.fragment.inputs.forEach((inp, i) => (args[inp.name || i] = p.args[i]));
    return { name: p.name, args, address: log.address };
  } catch {
    return null;
  }
}

const sandboxKey = (actor) => ethers.id(`receivasg-sandbox:${actor}`);

/** Boot the in-browser chain, deploy contracts, seed demo data. */
export async function bootSandbox(onProgress = () => {}) {
  const chain = await new SandboxChain().init(ACTOR_KEYS.map(sandboxKey));
  const provider = new ethers.BrowserProvider(chain, undefined, { pollingInterval: 50, cacheTimeout: -1 });
  const actors = {};
  const signers = {};
  for (const k of ACTOR_KEYS) {
    actors[k] = ethers.computeAddress(sandboxKey(k));
    signers[k] = await provider.getSigner(actors[k]);
  }
  const setupLog = [];
  const log = (entry) => {
    setupLog.push(entry);
    onProgress(entry, setupLog.length);
  };
  const contracts = await deployCore({ ethers, artifacts, admin: signers.admin, bank: signers.bank, treasury: signers.treasury, log });
  await seedDemo({ ethers, contracts, signers, addresses: actors, chainNow: chain.latestTimestamp(), seedMarket: true, log });
  const client = await makeClient({ mode: "sandbox", provider, chain, actors, addresses: await addressesOf(contracts), signerFor: (k) => signers[k] });
  for (const entry of setupLog) await client._recordSetup(entry);
  return client;
}

/** Connect to deployed contracts through a browser wallet. */
export async function connectWallet(deployment) {
  if (!window.ethereum) throw new Error("No browser wallet found. Open the standalone HTML file in a browser with MetaMask installed.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const net = await provider.getNetwork();
  if (deployment.chainId && Number(net.chainId) !== Number(deployment.chainId)) {
    throw new Error(`Your wallet is on chain ${net.chainId}, but these contracts are on chain ${deployment.chainId} (${deployment.network}). Switch network in your wallet.`);
  }
  const client = await makeClient({
    mode: "wallet",
    provider,
    actors: deployment.actors,
    addresses: deployment.contracts,
    network: deployment.network,
    signerFor: async () => provider.getSigner(),
  });
  return client;
}

async function makeClient({ mode, provider, chain, actors, addresses, network, signerFor }) {
  const actorByAddr = {};
  // On testnets one deployer key can be admin, bank and treasury; the first role listed wins.
  for (const [k, a] of Object.entries(actors)) if (!actorByAddr[a.toLowerCase()]) actorByAddr[a.toLowerCase()] = k;
  const contractName = {};
  const nameMap = { tsgd: "TokenisedSGD", registry: "IdentityRegistry", nft: "InvoiceNFT", noteImpl: "ReceivableNote", spv: "ReceivaSPV", market: "DDExMarket" };
  const read = {};
  for (const [k, n] of Object.entries(nameMap)) {
    read[k] = new ethers.Contract(addresses[k], artifacts[n].abi, provider);
    contractName[addresses[k].toLowerCase()] = n;
  }
  const ledger = [];
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  const client = {
    mode,
    network: network || "ReceivaSG sandbox chain",
    provider,
    chain,
    actors,
    addresses,
    read,
    artifacts,
    ledger,
    actorOf: (addr) => (addr ? actorByAddr[addr.toLowerCase()] : undefined),
    contractName: (addr) => contractName[addr?.toLowerCase()] || (addr ? "ReceivableNote" : ""),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async now() {
      const b = await provider.getBlock("latest");
      return { block: b.number, time: b.timestamp };
    },
    note(addr) { return new ethers.Contract(addr, artifacts.ReceivableNote.abi, provider); },

    async connectedActor() {
      if (mode !== "wallet") return null;
      const s = await provider.getSigner();
      return actorByAddr[(await s.getAddress()).toLowerCase()] || "observer";
    },

    /** Send a transaction as `actor`. build(signer) returns a tx promise. */
    async send(actor, label, build) {
      const signer = await signerFor(actor);
      if (mode === "wallet") {
        const addr = (await signer.getAddress()).toLowerCase();
        if (actorByAddr[addr] !== actor) {
          throw new Error(`Switch your wallet to ${ACTORS[actor].name} (${actors[actor].slice(0, 6)}…${actors[actor].slice(-4)}) to do this.`);
        }
      }
      const entry = { id: ledger.length + 1, label, actor, status: "pending", time: Date.now() };
      ledger.unshift(entry);
      notify();
      try {
        const tx = await build(signer);
        entry.hash = tx.hash;
        notify();
        const r = await tx.wait();
        await fill(entry, r);
        entry.status = "ok";
        notify();
        return { receipt: r, entry };
      } catch (e) {
        const ex = explainError(e);
        entry.status = "reverted";
        entry.error = ex.message;
        entry.errorName = ex.name;
        notify();
        const err = new Error(ex.message);
        err.name = ex.name;
        throw err;
      }
    },

    async _recordSetup(s) {
      if (!s.hash) return;
      const r = await provider.getTransactionReceipt(s.hash);
      const entry = { id: ledger.length + 1, label: s.kind === "deploy" ? `Deploy ${s.name}` : s.label, actor: s.kind === "deploy" ? (s.name === "TokenisedSGD" ? "bank" : "admin") : actorByAddr[r.from.toLowerCase()], status: "ok", setup: true, time: Date.now(), hash: s.hash };
      await fill(entry, r);
      ledger.unshift(entry);
    },

    async increaseTime(seconds) {
      if (mode !== "sandbox") throw new Error("Fast-forwarding time is only possible on the sandbox chain.");
      // Move the clock relative to the latest block (not the wall clock), so the jump is exact.
      const latest = await provider.getBlock("latest");
      await provider.send("evm_setNextBlockTimestamp", [latest.timestamp + Math.floor(seconds)]);
      await provider.send("evm_mine", []);
      const b = await provider.getBlock("latest");
      ledger.unshift({ id: ledger.length + 1, label: `Fast-forward ${Math.round(seconds / 86400)} days`, actor: null, status: "time", block: b.number, time: Date.now(), events: [] });
      notify();
    },
  };

  async function fill(entry, r) {
    entry.block = r.blockNumber;
    entry.gasUsed = Number(r.gasUsed);
    entry.to = r.to;
    entry.contract = r.contractAddress ? contractName[r.contractAddress.toLowerCase()] : contractName[r.to?.toLowerCase()] || (r.to ? "ReceivableNote" : "");
    entry.events = r.logs.map((l) => decodeLog(l, contractName[l.address.toLowerCase()] || "ReceivableNote")).filter(Boolean);
    entry.from = r.from;
  }

  return client;
}

export { GRADES, STATUS, ifaceByName };
