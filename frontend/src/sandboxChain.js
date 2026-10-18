// ReceivaSG sandbox chain: a single-node Ethereum chain that runs entirely in the browser.
// It wraps the EthereumJS VM (the same engine Remix uses for its in-browser "Remix VM")
// and answers the standard JSON-RPC methods through an EIP-1193 `request()` interface,
// so ethers.js talks to it exactly as it would to Sepolia or a Hardhat node.
// One block is mined per transaction ("instamine"). Time can be fast-forwarded.

import { VM } from "@ethereumjs/vm";
import { Common, Hardfork } from "@ethereumjs/common";
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Address, Account, privateToAddress, bufferToHex, toBuffer } from "@ethereumjs/util";
import { Block } from "@ethereumjs/block";
import { keccak256 } from "ethereum-cryptography/keccak.js";

const CHAIN_ID = 1337;
const GAS_LIMIT = 30_000_000n;
const BASE_FEE = 1n;
const ZERO_HASH = "0x" + "00".repeat(32);
const EMPTY_BLOOM = "0x" + "00".repeat(256);

const hex = (n) => "0x" + BigInt(n).toString(16);
const lc = (a) => (a ? a.toLowerCase() : a);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export class SandboxChain {
  constructor() {
    this.listeners = {};
  }

  /** @param keys array of 0x-prefixed private keys to fund and unlock */
  async init(keys) {
    this.common = Common.custom({ chainId: CHAIN_ID, networkId: CHAIN_ID, name: "receivasg-sandbox" }, { baseChain: "mainnet", hardfork: Hardfork.Merge });
    this.vm = await VM.create({ common: this.common });
    this.keys = new Map();
    for (const k of keys) {
      const pk = toBuffer(k);
      const addr = bufferToHex(privateToAddress(pk));
      this.keys.set(addr, pk);
      await this.vm.stateManager.putAccount(Address.fromString(addr), Account.fromAccountData({ balance: 10n ** 21n }));
    }
    this.timeOffset = 0;
    this.blocks = [];
    this.txs = new Map();
    this.receipts = new Map();
    this.logs = [];
    this._mineBlock([], 0n); // genesis
    return this;
  }

  get accounts() {
    return [...this.keys.keys()];
  }

  // ── time ────────────────────────────────────────────────────────────
  _nextTimestamp() {
    const latest = this.blocks.length ? this.blocks[this.blocks.length - 1].timestamp : 0;
    const wall = Math.floor(Date.now() / 1000) + this.timeOffset;
    return Math.max(latest + 1, wall);
  }

  latestTimestamp() {
    return this.blocks[this.blocks.length - 1].timestamp;
  }

  _vmBlock(number, timestamp) {
    return Block.fromBlockData(
      { header: { number, timestamp, gasLimit: GAS_LIMIT, baseFeePerGas: BASE_FEE, coinbase: "0x" + "00".repeat(20) } },
      { common: this.common, freeze: false }
    );
  }

  _mineBlock(txHashes, gasUsed) {
    const number = this.blocks.length;
    const timestamp = this._nextTimestamp();
    const parentHash = number === 0 ? ZERO_HASH : this.blocks[number - 1].hash;
    const hash = bufferToHex(Buffer.from(keccak256(Buffer.from(`receivasg-block-${number}-${timestamp}-${txHashes.join("")}`))));
    const b = { number, timestamp, hash, parentHash, txHashes, gasUsed };
    this.blocks.push(b);
    return b;
  }

  // ── EIP-1193 ────────────────────────────────────────────────────────
  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }
  removeListener() {}

  /** Requests are executed one at a time: calls use state checkpoints that must not interleave. */
  request(args) {
    const next = (this._queue || Promise.resolve()).then(() => this._handle(args));
    this._queue = next.catch(() => {});
    return next;
  }

  async _handle({ method, params = [] }) {
    switch (method) {
      case "eth_chainId": return hex(CHAIN_ID);
      case "net_version": return String(CHAIN_ID);
      case "web3_clientVersion": return "ReceivaSG-Sandbox/EthereumJS-VM";
      case "eth_accounts":
      case "eth_requestAccounts": return this.accounts;
      case "eth_blockNumber": return hex(this.blocks.length - 1);
      case "eth_gasPrice": return hex(BASE_FEE + 1n);
      case "eth_maxPriorityFeePerGas": return hex(1n);
      case "eth_getBlockByNumber": return this._blockJson(this._resolveBlock(params[0]), params[1]);
      case "eth_getBlockByHash": return this._blockJson(this.blocks.find((b) => b.hash === lc(params[0])), params[1]);
      case "eth_getBalance": return hex((await this._account(params[0])).balance);
      case "eth_getTransactionCount": return hex((await this._account(params[0])).nonce);
      case "eth_getCode": return bufferToHex(await this.vm.stateManager.getContractCode(Address.fromString(params[0])));
      case "eth_call": return this._call(params[0]);
      case "eth_estimateGas": return this._estimate(params[0]);
      case "eth_sendTransaction": return this._send(params[0]);
      case "eth_getTransactionByHash": return this.txs.get(lc(params[0])) || null;
      case "eth_getTransactionReceipt": return this.receipts.get(lc(params[0])) || null;
      case "eth_getLogs": return this._getLogs(params[0] || {});
      case "evm_increaseTime": this.timeOffset += Number(params[0]); return hex(this.timeOffset);
      case "evm_setNextBlockTimestamp": this.timeOffset = Number(params[0]) - Math.floor(Date.now() / 1000); return null;
      case "evm_mine": this._mineBlock([], 0n); return "0x0";
      default: throw new RpcError(-32601, `Method ${method} not supported by the sandbox chain`);
    }
  }

  _resolveBlock(tag) {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return this.blocks[this.blocks.length - 1];
    if (tag === "earliest") return this.blocks[0];
    return this.blocks[Number(BigInt(tag))];
  }

  _blockJson(b, full) {
    if (!b) return null;
    return {
      number: hex(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: hex(b.timestamp),
      nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", mixHash: ZERO_HASH,
      gasLimit: hex(GAS_LIMIT), gasUsed: hex(b.gasUsed), baseFeePerGas: hex(BASE_FEE),
      miner: "0x" + "00".repeat(20), extraData: "0x", logsBloom: EMPTY_BLOOM,
      sha3Uncles: ZERO_HASH, stateRoot: ZERO_HASH, transactionsRoot: ZERO_HASH, receiptsRoot: ZERO_HASH,
      size: "0x0", uncles: [],
      transactions: full ? b.txHashes.map((h) => this.txs.get(h)) : b.txHashes,
    };
  }

  async _account(addr) {
    return (await this.vm.stateManager.getAccount(Address.fromString(addr))) || new Account();
  }

  async _runCall(tx) {
    const block = this._vmBlock(BigInt(this.blocks.length), BigInt(this._nextTimestamp()));
    await this.vm.stateManager.checkpoint();
    try {
      return await this.vm.evm.runCall({
        caller: tx.from ? Address.fromString(tx.from) : Address.zero(),
        to: tx.to ? Address.fromString(tx.to) : undefined,
        data: toBuffer(tx.data || tx.input || "0x"),
        value: tx.value ? BigInt(tx.value) : 0n,
        gasLimit: GAS_LIMIT,
        block,
      });
    } finally {
      await this.vm.stateManager.revert();
    }
  }

  _throwIfReverted(res) {
    const err = res.execResult.exceptionError;
    if (!err) return;
    const data = bufferToHex(res.execResult.returnValue);
    throw new RpcError(3, "execution reverted", data);
  }

  async _call(tx) {
    const res = await this._runCall(tx);
    this._throwIfReverted(res);
    return bufferToHex(res.execResult.returnValue);
  }

  async _estimate(tx) {
    const res = await this._runCall(tx);
    this._throwIfReverted(res);
    const used = res.execResult.executionGasUsed;
    const dataLen = toBuffer(tx.data || tx.input || "0x").length;
    const intrinsic = 21_000n + BigInt(dataLen) * 16n + (tx.to ? 0n : 32_000n);
    const est = ((used + intrinsic) * 13n) / 10n + 20_000n;
    return hex(est > GAS_LIMIT ? GAS_LIMIT : est);
  }

  async _send(t) {
    const from = lc(t.from);
    const pk = this.keys.get(from);
    if (!pk) throw new RpcError(-32000, `Unknown sender ${t.from}`);
    const acct = await this._account(from);
    const gasLimit = t.gas ? BigInt(t.gas) : BigInt(await this._estimate(t));
    const tx = FeeMarketEIP1559Transaction.fromTxData(
      {
        chainId: BigInt(CHAIN_ID), nonce: acct.nonce, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n,
        gasLimit, to: t.to || undefined, value: t.value ? BigInt(t.value) : 0n, data: t.data || t.input || "0x",
      },
      { common: this.common }
    ).sign(pk);

    const number = this.blocks.length;
    const timestamp = this._nextTimestamp();
    const vmBlock = this._vmBlock(BigInt(number), BigInt(timestamp));
    const res = await this.vm.runTx({ tx, block: vmBlock, skipBlockGasLimitValidation: true });
    const hash = bufferToHex(tx.hash());
    const b = this._mineBlock([hash], res.totalGasSpent);

    const status = res.execResult.exceptionError ? "0x0" : "0x1";
    const contractAddress = res.createdAddress ? res.createdAddress.toString() : null;
    const logs = (res.execResult.logs || []).map((l, i) => ({
      address: bufferToHex(l[0]),
      topics: l[1].map((tp) => bufferToHex(tp)),
      data: bufferToHex(l[2]),
      blockNumber: hex(b.number), blockHash: b.hash, transactionHash: hash,
      transactionIndex: "0x0", logIndex: hex(i), removed: false,
    }));
    const txJson = {
      hash, from, to: t.to ? lc(t.to) : null, nonce: hex(acct.nonce), gas: hex(gasLimit),
      gasPrice: hex(BASE_FEE + 1n), maxFeePerGas: hex(1_000_000_000n), maxPriorityFeePerGas: "0x1",
      value: hex(t.value ? BigInt(t.value) : 0n), input: bufferToHex(tx.data), type: "0x2", chainId: hex(CHAIN_ID),
      accessList: [], v: hex(tx.v), r: hex(tx.r), s: hex(tx.s), yParity: hex(tx.v),
      blockHash: b.hash, blockNumber: hex(b.number), transactionIndex: "0x0",
    };
    const receipt = {
      transactionHash: hash, transactionIndex: "0x0", blockHash: b.hash, blockNumber: hex(b.number),
      from, to: txJson.to, cumulativeGasUsed: hex(res.totalGasSpent), gasUsed: hex(res.totalGasSpent),
      effectiveGasPrice: hex(BASE_FEE + 1n), contractAddress, logs, logsBloom: EMPTY_BLOOM, status, type: "0x2",
    };
    this.txs.set(hash, txJson);
    this.receipts.set(hash, receipt);
    if (status === "0x1") this.logs.push(...logs);
    return hash;
  }

  _getLogs(f) {
    const from = f.fromBlock && f.fromBlock !== "earliest" ? Number(this._resolveBlock(f.fromBlock).number) : 0;
    const to = f.toBlock ? this._resolveBlock(f.toBlock).number : this.blocks.length - 1;
    const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map(lc) : null;
    return this.logs.filter((l) => {
      const n = Number(BigInt(l.blockNumber));
      if (n < from || n > to) return false;
      if (addrs && !addrs.includes(lc(l.address))) return false;
      if (f.topics) {
        for (let i = 0; i < f.topics.length; i++) {
          const want = f.topics[i];
          if (want == null) continue;
          const opts = (Array.isArray(want) ? want : [want]).map(lc);
          if (!opts.includes(lc(l.topics[i]))) return false;
        }
      }
      return true;
    });
  }
}
