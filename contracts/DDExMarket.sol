// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./ReceivaSPV.sol";
import "./ReceivableNote.sol";

/// @title Secondary market venue — simulated stand-in for the DBS Digital Exchange (DDEx)
/// @notice In the press release, ReceivaSG notes are listed on DDEx for price discovery
///         and pre-maturity exit. This contract simulates that venue so the prototype can
///         show the mechanics end to end: a holder lists notes at an ask price, an eligible
///         investor buys, and cash and notes swap atomically (DvP).
///         Notes are never escrowed: the seller keeps them until the trade executes.
///         The note contract itself enforces eligibility, so an unverified buyer's
///         purchase fails inside the transfer — the venue cannot bypass compliance.
contract DDExMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Listing {
        uint256 id;
        uint256 invoiceId;
        address note;
        address seller;
        uint256 amount; // note units
        uint256 price;  // total ask in S$ cents
        bool active;
        address buyer;
        uint64 listedAt;
        uint64 filledAt;
    }

    IERC20 public immutable cash;
    ReceivaSPV public immutable spv;
    Listing[] private _listings;

    event Listed(uint256 indexed listingId, uint256 indexed invoiceId, address indexed seller, uint256 amount, uint256 price);
    event Cancelled(uint256 indexed listingId);
    event Trade(uint256 indexed listingId, uint256 indexed invoiceId, address seller, address indexed buyer, uint256 amount, uint256 price);

    error NotTradable();
    error NotSeller();
    error Inactive();
    error InvalidListing();

    constructor(address cash_, address spv_) {
        cash = IERC20(cash_);
        spv = ReceivaSPV(spv_);
    }

    function list(uint256 invoiceId, uint256 amount, uint256 price) external returns (uint256 listingId) {
        if (spv.statusOf(invoiceId) != ReceivaSPV.Status.Funded) revert NotTradable();
        if (amount == 0 || price == 0) revert InvalidListing();
        ReceivableNote note = ReceivableNote(spv.noteOf(invoiceId));
        require(note.balanceOf(msg.sender) >= amount, "insufficient notes");
        require(note.allowance(msg.sender, address(this)) >= amount, "approve notes first");

        listingId = _listings.length;
        _listings.push(Listing(listingId, invoiceId, address(note), msg.sender, amount, price, true, address(0), uint64(block.timestamp), 0));
        emit Listed(listingId, invoiceId, msg.sender, amount, price);
    }

    function cancel(uint256 listingId) external {
        Listing storage l = _listings[listingId];
        if (l.seller != msg.sender) revert NotSeller();
        if (!l.active) revert Inactive();
        l.active = false;
        emit Cancelled(listingId);
    }

    /// @notice Atomic DvP: notes move seller → buyer (compliance checked by the note),
    ///         tSGD moves buyer → seller, in the same transaction.
    function buy(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        if (!l.active) revert Inactive();
        if (spv.statusOf(l.invoiceId) != ReceivaSPV.Status.Funded) revert NotTradable();
        l.active = false;
        l.buyer = msg.sender;
        l.filledAt = uint64(block.timestamp);

        ReceivableNote(l.note).transferFrom(l.seller, msg.sender, l.amount);
        cash.safeTransferFrom(msg.sender, l.seller, l.price);

        emit Trade(listingId, l.invoiceId, l.seller, msg.sender, l.amount, l.price);
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function allListings() external view returns (Listing[] memory) {
        return _listings;
    }
}
