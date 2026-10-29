// Deploys the ReceivaSG suite and seeds the demo data on any network.
//
//   npx hardhat run scripts/deploy.js --network localhost   (after `npx hardhat node`)
//   npx hardhat run scripts/deploy.js --network sepolia     (needs DEPLOYER_PRIVATE_KEY + Sepolia ETH)
//
// Writes deployments/<network>.json — paste its contents into the prototype's
// Explorer → Network panel to drive these contracts with MetaMask.
// On public testnets it also writes deployments/<network>.demo-wallets.json with the
// private keys of freshly generated demo wallets (TESTNET ONLY — never reuse them).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

const LOCAL = ["hardhat", "localhost"];

async function main() {
  const suite = await import("../shared/deploySuite.mjs");
  const { ACTORS } = await import("../shared/constants.mjs");
  const artifacts = require("../shared/artifacts.json");
  const net = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const keys = Object.keys(ACTORS);
  const signers = {};
  const addresses = {};
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });

  if (LOCAL.includes(net)) {
    const all = await ethers.getSigners();
    keys.forEach((k, i) => (signers[k] = all[i]));
  } else {
    const [deployer] = await ethers.getSigners();
    if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env (a testnet-only key funded with Sepolia ETH).");
    signers.admin = signers.bank = signers.treasury = deployer;

    // Demo wallets: reuse if a previous run created them, otherwise generate new ones.
    const walletFile = path.join(outDir, `${net}.demo-wallets.json`);
    const saved = fs.existsSync(walletFile) ? JSON.parse(fs.readFileSync(walletFile, "utf8")) : {};
    const gasEth = ethers.parseEther(process.env.DEMO_GAS_ETH || "0.01");
    const needGas = ["sme", "buyer", "investorA", "investorB", "unverified", "bgSme1", "bgSme2"];
    for (const k of keys) {
      if (signers[k]) continue;
      const w = saved[k] ? new ethers.Wallet(saved[k].privateKey) : ethers.Wallet.createRandom();
      saved[k] = { name: ACTORS[k].name, address: w.address, privateKey: w.privateKey };
      signers[k] = w.connect(ethers.provider);
    }
    fs.writeFileSync(walletFile, JSON.stringify(saved, null, 2));
    for (const k of needGas) {
      const bal = await ethers.provider.getBalance(signers[k].address);
      if (bal < gasEth / 2n) {
        const tx = await deployer.sendTransaction({ to: signers[k].address, value: gasEth });
        await tx.wait();
        console.log(`  funded ${ACTORS[k].name} with ${ethers.formatEther(gasEth)} ETH for gas`);
      }
    }
    console.log(`Demo wallet keys saved to deployments/${net}.demo-wallets.json (import into MetaMask; testnet only).`);
  }
  for (const k of keys) addresses[k] = await signers[k].getAddress();

  const log = (e) => console.log(e.kind === "deploy" ? `  deployed ${e.name.padEnd(17)} ${e.address}` : `  ${e.label}`);
  console.log(`\nDeploying ReceivaSG to ${net} (chain ${chainId})`);
  const contracts = await suite.deployCore({ ethers, artifacts, admin: signers.admin, bank: signers.bank, treasury: signers.treasury, log });
  const latest = await ethers.provider.getBlock("latest");
  const seedMarket = process.env.SEED_MARKET !== "0";
  console.log(`\nSeeding demo data${seedMarket ? " and background invoices" : ""}`);
  await suite.seedDemo({ ethers, contracts, signers, addresses, chainNow: latest.timestamp, seedMarket, log });

  const deployment = {
    network: net,
    chainId,
    deployedAt: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
    explorer: net === "sepolia" ? "https://sepolia.etherscan.io/address/" : net === "amoy" ? "https://amoy.polygonscan.com/address/" : null,
    contracts: await suite.addressesOf(contracts),
    actors: addresses,
  };
  const file = path.join(outDir, `${net}.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  console.log(`\nWrote deployments/${net}.json`);
  if (deployment.explorer) console.log(`SPV on block explorer: ${deployment.explorer}${deployment.contracts.spv}`);

  if (!LOCAL.includes(net) && process.env.ETHERSCAN_API_KEY) {
    console.log("\nVerifying source code on Etherscan…");
    const c = deployment.contracts;
    const args = {
      tsgd: [addresses.bank], registry: [addresses.admin], nft: [addresses.admin], noteImpl: [],
      spv: [addresses.admin, c.tsgd, c.registry, c.nft, c.noteImpl, addresses.treasury], market: [c.tsgd, c.spv],
    };
    for (const [k, constructorArguments] of Object.entries(args)) {
      try {
        await hre.run("verify:verify", { address: c[k], constructorArguments });
      } catch (e) {
        console.log(`  ${k}: ${e.message.split("\n")[0]}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
