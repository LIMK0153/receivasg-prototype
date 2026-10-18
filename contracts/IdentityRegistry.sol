// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ReceivaSG Identity Registry (ERC-3643-style, simplified)
/// @notice Mirrors the role of the ERC-3643 IdentityRegistry: maps a wallet to a
///         verified identity and its eligibility category. Personal data never goes
///         on-chain: only a hash of the off-chain KYC/AML record is stored.
///         Every ReceivaSG note transfer consults this registry before it executes.
contract IdentityRegistry is AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    enum Category {
        None,
        SME,                   // invoice originator / supplier
        CorporateBuyer,        // obligor that pays the invoice
        AccreditedInvestor,    // eligible to hold notes
        InstitutionalInvestor  // eligible to hold notes
    }

    struct Identity {
        Category category;
        uint16 country;        // ISO 3166 numeric, 702 = Singapore
        uint64 kycExpiry;      // unix time the KYC/AML check lapses
        bytes32 kycRecordHash; // hash of the off-chain KYC file (no personal data on-chain)
    }

    mapping(address => Identity) private _identities;
    address[] private _wallets;
    mapping(address => bool) private _seen;

    event IdentityRegistered(address indexed wallet, Category category, uint16 country, uint64 kycExpiry, bytes32 kycRecordHash);
    event IdentityRemoved(address indexed wallet);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function registerIdentity(
        address wallet,
        Category category,
        uint16 country,
        uint64 kycExpiry,
        bytes32 kycRecordHash
    ) external onlyRole(AGENT_ROLE) {
        require(wallet != address(0), "zero wallet");
        require(category != Category.None, "category required");
        _identities[wallet] = Identity(category, country, kycExpiry, kycRecordHash);
        if (!_seen[wallet]) {
            _seen[wallet] = true;
            _wallets.push(wallet);
        }
        emit IdentityRegistered(wallet, category, country, kycExpiry, kycRecordHash);
    }

    function removeIdentity(address wallet) external onlyRole(AGENT_ROLE) {
        delete _identities[wallet];
        emit IdentityRemoved(wallet);
    }

    function isVerified(address wallet) public view returns (bool) {
        Identity storage i = _identities[wallet];
        return i.category != Category.None && i.kycExpiry >= block.timestamp;
    }

    /// @notice Only accredited or institutional investors may hold ReceivaSG notes.
    function isEligibleInvestor(address wallet) public view returns (bool) {
        if (!isVerified(wallet)) return false;
        Category c = _identities[wallet].category;
        return c == Category.AccreditedInvestor || c == Category.InstitutionalInvestor;
    }

    function categoryOf(address wallet) external view returns (Category) {
        return isVerified(wallet) ? _identities[wallet].category : Category.None;
    }

    function identityOf(address wallet) external view returns (Identity memory) {
        return _identities[wallet];
    }

    function registeredWallets() external view returns (address[] memory) {
        return _wallets;
    }
}
