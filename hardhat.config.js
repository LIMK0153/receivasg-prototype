require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Offline fallback: use the solc compiler bundled in node_modules (solcjs) when
// USE_LOCAL_SOLC=1. On a normal machine with internet, Hardhat downloads solc itself.
if (process.env.USE_LOCAL_SOLC === "1") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return {
        compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: "0.8.24+commit.e11b9ed9",
      };
    }
    return runSuper();
  });
}

const PK = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" keeps bytecode compatible with every EVM we target
      // (Sepolia, Polygon Amoy, Hardhat, and the in-browser sandbox chain).
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: PK ? [PK] : [],
      chainId: 11155111,
    },
    amoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      accounts: PK ? [PK] : [],
      chainId: 80002,
    },
    // Any other EVM testnet (e.g. Base Sepolia): set CUSTOM_RPC_URL
    custom: {
      url: process.env.CUSTOM_RPC_URL || "http://127.0.0.1:8545",
      accounts: PK ? [PK] : [],
    },
  },
  etherscan: {
    apiKey: { sepolia: process.env.ETHERSCAN_API_KEY || "" },
  },
};
