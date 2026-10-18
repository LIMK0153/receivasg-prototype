// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Tokenised SGD commercial bank deposit (simulated)
/// @notice Stands in for a tokenised bank deposit used as the cash leg of every
///         ReceivaSG settlement. 2 decimals, so 1 unit = S$0.01.
///         Only the issuing bank (ISSUER_ROLE) can mint or redeem.
contract TokenisedSGD is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    constructor(address issuingBank) ERC20("Tokenised SGD Deposit (simulated)", "tSGD") {
        _grantRole(DEFAULT_ADMIN_ROLE, issuingBank);
        _grantRole(ISSUER_ROLE, issuingBank);
    }

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    /// @notice Bank credits a customer's tokenised deposit (e.g. after a fiat top-up).
    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Bank redeems tokenised deposits back to a fiat account.
    function redeem(address from, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount);
    }
}
