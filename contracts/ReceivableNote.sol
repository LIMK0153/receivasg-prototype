// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./IdentityRegistry.sol";

/// @title ReceivaSG Receivable-Backed Note (ERC-3643-style permissioned token)
/// @notice One note series is issued by the SPV against each Invoice NFT.
///         1.00 note = a claim on S$1.00 of the invoice's face value (2 decimals).
///
///         What makes it ERC-3643-style rather than a plain ERC-20:
///         - every transfer is checked against the IdentityRegistry, so notes can
///           only ever sit in wallets of verified accredited / institutional investors;
///         - a non-compliant transfer fails inside the contract (it never executes);
///         - the agent (the SPV) can pause the series, freeze a wallet, and force a
///           transfer for lost-wallet recovery;
///         - holders are tracked on-chain so maturity proceeds are paid pro rata.
///
///         Deployed once as an implementation and cloned (EIP-1167) per invoice.
contract ReceivableNote {
    // ── ERC-20 surface ────────────────────────────────────────────────
    string public name;
    string public symbol;
    uint8 public constant decimals = 2;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ── ERC-3643-style controls ───────────────────────────────────────
    address public agent; // the ReceivaSG SPV
    IdentityRegistry public identityRegistry;
    uint256 public invoiceId;
    bool public paused;
    bool public retired;
    mapping(address => bool) public frozen;

    address[] private _holders;
    mapping(address => uint256) private _holderIndex; // 1-based
    bool private _initialized;

    // Transfer check result codes (also used by the UI to explain failures)
    uint8 public constant OK = 0;
    uint8 public constant PAUSED = 1;
    uint8 public constant SENDER_FROZEN = 2;
    uint8 public constant RECEIVER_FROZEN = 3;
    uint8 public constant SENDER_NOT_VERIFIED = 4;
    uint8 public constant RECEIVER_NOT_ELIGIBLE = 5;
    uint8 public constant INSUFFICIENT_BALANCE = 6;
    uint8 public constant SERIES_RETIRED = 7;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AddressFrozen(address indexed wallet, bool frozen);
    event Paused(bool paused);
    event ForcedTransfer(address indexed from, address indexed to, uint256 value);
    event Retired(uint256 indexed invoiceId);

    error TransferNotCompliant(uint8 code);
    error OnlyAgent();
    error AlreadyInitialized();
    error InsufficientAllowance();

    modifier onlyAgent() {
        if (msg.sender != agent) revert OnlyAgent();
        _;
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        address agent_,
        address registry_,
        uint256 invoiceId_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        name = name_;
        symbol = symbol_;
        agent = agent_;
        identityRegistry = IdentityRegistry(registry_);
        invoiceId = invoiceId_;
    }

    // ── Compliance check (view) ───────────────────────────────────────
    function canTransfer(address from, address to, uint256 amount) public view returns (uint8) {
        if (retired) return SERIES_RETIRED;
        if (paused) return PAUSED;
        if (frozen[from]) return SENDER_FROZEN;
        if (frozen[to]) return RECEIVER_FROZEN;
        if (!identityRegistry.isVerified(from)) return SENDER_NOT_VERIFIED;
        if (!identityRegistry.isEligibleInvestor(to)) return RECEIVER_NOT_ELIGIBLE;
        if (balanceOf[from] < amount) return INSUFFICIENT_BALANCE;
        return OK;
    }

    // ── ERC-20 functions with compliance enforced ─────────────────────
    function transfer(address to, uint256 amount) external returns (bool) {
        _checkedTransfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _checkedTransfer(from, to, amount);
        return true;
    }

    function _checkedTransfer(address from, address to, uint256 amount) internal {
        uint8 code = canTransfer(from, to, amount);
        if (code != OK) revert TransferNotCompliant(code);
        _move(from, to, amount);
    }

    // ── Agent (SPV) functions ─────────────────────────────────────────
    function mint(address to, uint256 amount) external onlyAgent {
        if (retired) revert TransferNotCompliant(SERIES_RETIRED);
        if (!identityRegistry.isEligibleInvestor(to)) revert TransferNotCompliant(RECEIVER_NOT_ELIGIBLE);
        totalSupply += amount;
        balanceOf[to] += amount;
        _trackHolder(to);
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burns every outstanding note once the receivable has been paid out.
    function retire() external onlyAgent {
        for (uint256 i = 0; i < _holders.length; i++) {
            address h = _holders[i];
            uint256 bal = balanceOf[h];
            balanceOf[h] = 0;
            _holderIndex[h] = 0;
            emit Transfer(h, address(0), bal);
        }
        delete _holders;
        totalSupply = 0;
        retired = true;
        emit Retired(invoiceId);
    }

    function setFrozen(address wallet, bool isFrozen) external onlyAgent {
        frozen[wallet] = isFrozen;
        emit AddressFrozen(wallet, isFrozen);
    }

    function setPaused(bool isPaused) external onlyAgent {
        paused = isPaused;
        emit Paused(isPaused);
    }

    /// @notice Recovery path (e.g. investor lost keys): move notes to a new verified wallet.
    function forcedTransfer(address from, address to, uint256 amount) external onlyAgent {
        if (!identityRegistry.isEligibleInvestor(to)) revert TransferNotCompliant(RECEIVER_NOT_ELIGIBLE);
        if (balanceOf[from] < amount) revert TransferNotCompliant(INSUFFICIENT_BALANCE);
        _move(from, to, amount);
        emit ForcedTransfer(from, to, amount);
    }

    function holders() external view returns (address[] memory) {
        return _holders;
    }

    // ── internals ─────────────────────────────────────────────────────
    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _trackHolder(to);
        if (balanceOf[from] == 0) _untrackHolder(from);
        emit Transfer(from, to, amount);
    }

    function _trackHolder(address h) internal {
        if (_holderIndex[h] == 0 && balanceOf[h] > 0) {
            _holders.push(h);
            _holderIndex[h] = _holders.length;
        }
    }

    function _untrackHolder(address h) internal {
        uint256 idx = _holderIndex[h];
        if (idx == 0) return;
        uint256 last = _holders.length;
        if (idx != last) {
            address moved = _holders[last - 1];
            _holders[idx - 1] = moved;
            _holderIndex[moved] = idx;
        }
        _holders.pop();
        _holderIndex[h] = 0;
    }
}
