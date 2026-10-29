// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./IdentityRegistry.sol";
import "./InvoiceNFT.sol";
import "./ReceivableNote.sol";

/// @title ReceivaSG SPV — bankruptcy-remote purchaser of SME receivables
/// @notice Runs the full ReceivaSG lifecycle on-chain:
///   1. SME submits an InvoiceNow-approved invoice (hash of the Peppol e-invoice).
///   2. ReceivaSG (VERIFIER_ROLE, acting as the Peppol Access Point + credit engine)
///      verifies it and assigns a grade AAA–CCC; the contract prices it from the grade
///      and tenor, never below the 85% minimum financing percentage.
///   3. SME accepts the offer → true sale: Invoice NFT minted to the SPV, notice of
///      assignment emitted for the buyer, and an ERC-3643-style note series created.
///   4. Eligible investors commit fractional amounts at the set price. Cash stays in
///      their own wallets (no escrow). The commitment that fills the invoice triggers
///      atomic settlement: every investor's tSGD is pulled, notes are minted, and the SME
///      is paid the full price — all in one transaction (T+0 delivery-versus-payment).
///   5. At maturity the buyer pays face value; the contract takes the servicing fee and
///      distributes the rest pro rata to whoever holds the notes then, and retires them.
contract ReceivaSPV is AccessControl, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum Status { None, Submitted, Offered, Listed, Funded, Repaid, Defaulted, Cancelled }

    struct Invoice {
        uint256 id;
        bytes32 docHash;
        string invoiceRef;
        address supplier;
        address buyer;
        uint256 faceValue;      // S$ cents
        uint256 price;          // S$ cents paid to the SME
        uint64 submittedAt;
        uint64 dueDate;
        uint64 fundedAt;
        uint64 closedAt;
        uint8 grade;            // 0 AAA, 1 AA, 2 A, 3 BBB, 4 BB, 5 B, 6 CCC
        bool floorApplied;
        Status status;
        address note;
        uint256 committed;      // S$ cents committed by investors
        uint256 notesAllocated; // note units allocated to commitments
        uint256 distributed;    // S$ cents paid out to note holders
    }

    struct Commitment {
        address investor;
        uint256 cash;  // S$ cents
        uint256 notes; // note units (cents of face value)
    }

    // ── parameters ────────────────────────────────────────────────────
    uint256 public constant MIN_FINANCING_BPS = 8500; // SME always receives >= 85% of face
    uint256 public constant MAX_COMMITMENTS = 40;
    uint64 public constant MIN_TENOR = 7 days;
    uint64 public constant MAX_TENOR = 365 days;

    /// discount charged per 90 days of tenor, in basis points of face value, by grade
    uint16[7] public discountBpsPer90d = [uint16(125), 160, 200, 275, 375, 500, 1500];
    /// minimum ticket per investor, in S$ cents, by grade (AAA has the highest entry barrier)
    uint256[7] public minTicket = [uint256(25_000_00), 10_000_00, 5_000_00, 2_500_00, 1_000_00, 1_000_00, 1_000_00];
    uint16 public servicingFeeBps = 10; // 0.10% of face, taken at maturity
    uint64 public defaultGracePeriod = 30 days;

    IERC20 public immutable cash;
    IdentityRegistry public immutable registry;
    InvoiceNFT public immutable invoiceNFT;
    address public immutable noteImplementation;
    address public treasury;

    uint256 public invoiceCount;
    mapping(uint256 => Invoice) private _invoices;
    mapping(uint256 => Commitment[]) private _commitments;
    mapping(uint256 => mapping(address => uint256)) private _commitIndex; // 1-based
    mapping(bytes32 => uint256) public invoiceIdByDocHash;
    /// @notice Cash an investor has committed across all invoices not yet settled.
    ///         Their tSGD allowance to the SPV must cover this total.
    mapping(address => uint256) public outstandingCommitted;
    /// @notice A price the SME has proposed instead of the grade-based offer, awaiting ReceivaSG's review.
    mapping(uint256 => uint256) public counterPrice;

    // ── events ────────────────────────────────────────────────────────
    event InvoiceSubmitted(uint256 indexed id, address indexed supplier, address indexed buyer, bytes32 docHash, uint256 faceValue, uint64 dueDate);
    event InvoiceVerified(uint256 indexed id, uint8 grade, uint256 price, bool floorApplied);
    event InvoiceRejected(uint256 indexed id, string reason);
    event OfferDeclined(uint256 indexed id);
    event InvoiceAssigned(uint256 indexed id, address indexed note, uint256 price, uint256 faceValue);
    event NoticeOfAssignment(uint256 indexed id, address indexed buyer, address payTo);
    event FundingCommitted(uint256 indexed id, address indexed investor, uint256 cash, uint256 notes, uint256 totalCommitted);
    event CommitmentWithdrawn(uint256 indexed id, address indexed investor, uint256 cash);
    event AtomicSettlement(uint256 indexed id, address indexed supplier, uint256 paidToSupplier, uint256 investors, uint256 notesIssued);
    event BuyerPaid(uint256 indexed id, address indexed payer, uint256 amount, uint256 servicingFee);
    event Distribution(uint256 indexed id, address indexed holder, uint256 amount, uint256 notes);
    event InvoiceDefaulted(uint256 indexed id, uint256 recovered);
    event GradeParamsUpdated(uint8 grade, uint16 discountBpsPer90d, uint256 minTicket);
    event CounterOffered(uint256 indexed id, uint256 offeredPrice, uint256 counterPrice);
    event CounterReviewed(uint256 indexed id, bool approved, uint256 price);

    // ── errors ────────────────────────────────────────────────────────
    error NotRegisteredSME();
    error BuyerNotRegistered();
    error DuplicateInvoice(uint256 existingId);
    error InvalidTenor();
    error InvalidAmount();
    error WrongStatus(Status current);
    error NotSupplier();
    error NotEligibleInvestor();
    error BelowMinimumTicket(uint256 minimum);
    error ExceedsRemaining(uint256 remaining);
    error InsufficientFundsOrAllowance();
    error SettlementFailed(address investor);
    error TooManyCommitments();
    error NotYetInDefault(uint64 defaultableAfter);
    error InvalidGrade();
    error CounterOutOfRange(uint256 minimum, uint256 maximum);
    error CounterPending();
    error NoCounterPending();

    constructor(
        address admin,
        address cash_,
        address registry_,
        address invoiceNFT_,
        address noteImplementation_,
        address treasury_
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        cash = IERC20(cash_);
        registry = IdentityRegistry(registry_);
        invoiceNFT = InvoiceNFT(invoiceNFT_);
        noteImplementation = noteImplementation_;
        treasury = treasury_;
    }

    // ══════════════════════════════════════════════════════════════════
    // 1. SME submits an approved e-invoice
    // ══════════════════════════════════════════════════════════════════
    function submitInvoice(
        bytes32 docHash,
        string calldata invoiceRef,
        address buyer,
        uint256 faceValue,
        uint64 dueDate
    ) external returns (uint256 id) {
        if (registry.categoryOf(msg.sender) != IdentityRegistry.Category.SME) revert NotRegisteredSME();
        if (registry.categoryOf(buyer) != IdentityRegistry.Category.CorporateBuyer) revert BuyerNotRegistered();
        uint256 existing = invoiceIdByDocHash[docHash];
        if (existing != 0) revert DuplicateInvoice(existing); // double-pledge guard
        if (faceValue == 0) revert InvalidAmount();
        if (dueDate < block.timestamp + MIN_TENOR || dueDate > block.timestamp + MAX_TENOR) revert InvalidTenor();

        id = ++invoiceCount;
        Invoice storage inv = _invoices[id];
        inv.id = id;
        inv.docHash = docHash;
        inv.invoiceRef = invoiceRef;
        inv.supplier = msg.sender;
        inv.buyer = buyer;
        inv.faceValue = faceValue;
        inv.submittedAt = uint64(block.timestamp);
        inv.dueDate = dueDate;
        inv.status = Status.Submitted;
        invoiceIdByDocHash[docHash] = id;

        emit InvoiceSubmitted(id, msg.sender, buyer, docHash, faceValue, dueDate);
    }

    // ══════════════════════════════════════════════════════════════════
    // 2. ReceivaSG verifies (InvoiceNow / Peppol data) and grades AAA–CCC
    // ══════════════════════════════════════════════════════════════════
    function verifyAndGrade(uint256 id, uint8 grade) external onlyRole(VERIFIER_ROLE) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Submitted) revert WrongStatus(inv.status);
        if (grade > 6) revert InvalidGrade();
        if (inv.dueDate < block.timestamp + MIN_TENOR) revert InvalidTenor();

        (uint256 price, bool floorApplied, ) = quote(inv.faceValue, grade, inv.dueDate - uint64(block.timestamp));
        inv.grade = grade;
        inv.price = price;
        inv.floorApplied = floorApplied;
        inv.status = Status.Offered;
        emit InvoiceVerified(id, grade, price, floorApplied);
    }

    function rejectInvoice(uint256 id, string calldata reason) external onlyRole(VERIFIER_ROLE) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Submitted) revert WrongStatus(inv.status);
        inv.status = Status.Cancelled;
        inv.closedAt = uint64(block.timestamp);
        emit InvoiceRejected(id, reason);
    }

    /// @notice Price = face − face × gradeRate × tenorDays / 90, floored at 85% of face.
    function quote(uint256 faceValue, uint8 grade, uint256 tenorSeconds)
        public
        view
        returns (uint256 price, bool floorApplied, uint256 tenorDays)
    {
        if (grade > 6) revert InvalidGrade();
        tenorDays = (tenorSeconds + 1 days - 1) / 1 days; // round up to whole days
        uint256 discount = (faceValue * discountBpsPer90d[grade] * tenorDays) / (90 * 10_000);
        uint256 floorPrice = (faceValue * MIN_FINANCING_BPS) / 10_000;
        price = discount >= faceValue ? 0 : faceValue - discount;
        if (price < floorPrice) {
            price = floorPrice;
            floorApplied = true;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 3. SME accepts → true sale to the SPV, NFT + note series issued
    // ══════════════════════════════════════════════════════════════════
    function acceptOffer(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.supplier) revert NotSupplier();
        if (inv.status != Status.Offered) revert WrongStatus(inv.status);
        if (counterPrice[id] != 0) revert CounterPending();

        address note = Clones.clone(noteImplementation);
        ReceivableNote(note).initialize(
            string.concat("ReceivaSG Note ", inv.invoiceRef),
            string.concat("RSN-", id.toString()),
            address(this),
            address(registry),
            id
        );
        inv.note = note;
        inv.status = Status.Listed;

        invoiceNFT.mint(
            id,
            InvoiceNFT.Record({
                docHash: inv.docHash,
                invoiceRef: inv.invoiceRef,
                faceValue: inv.faceValue,
                dueDate: inv.dueDate,
                grade: inv.grade,
                status: uint8(Status.Listed),
                note: note
            })
        );

        emit InvoiceAssigned(id, note, inv.price, inv.faceValue);
        emit NoticeOfAssignment(id, inv.buyer, address(this));
    }

    function declineOffer(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.supplier) revert NotSupplier();
        if (inv.status != Status.Offered) revert WrongStatus(inv.status);
        inv.status = Status.Cancelled;
        inv.closedAt = uint64(block.timestamp);
        delete counterPrice[id];
        delete invoiceIdByDocHash[inv.docHash]; // SME kept the invoice; it may be resubmitted later
        emit OfferDeclined(id);
    }

    // ── counter-offer ─────────────────────────────────────────────────
    /// @notice Range an SME may counter within: above the current offer, and no higher
    ///         than the price one grade better would earn for the same tenor (capped at face).
    ///         This keeps investors paid for the buyer's risk. AAA has no room to counter.
    function counterOfferRange(uint256 id) public view returns (uint256 minimum, uint256 maximum) {
        Invoice storage inv = _invoices[id];
        minimum = inv.price + 1;
        if (inv.grade == 0) return (minimum, inv.price);
        uint256 tenor = inv.dueDate > block.timestamp ? inv.dueDate - block.timestamp : 0;
        (maximum, , ) = quote(inv.faceValue, inv.grade - 1, tenor);
        if (maximum > inv.faceValue) maximum = inv.faceValue;
    }

    /// @notice SME proposes a higher price instead of accepting or declining the offer.
    function counterOffer(uint256 id, uint256 price) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.supplier) revert NotSupplier();
        if (inv.status != Status.Offered) revert WrongStatus(inv.status);
        if (counterPrice[id] != 0) revert CounterPending();
        (uint256 minimum, uint256 maximum) = counterOfferRange(id);
        if (price < minimum || price > maximum) revert CounterOutOfRange(minimum, maximum);
        counterPrice[id] = price;
        emit CounterOffered(id, inv.price, price);
    }

    /// @notice ReceivaSG approves the counter (it becomes the offer) or rejects it
    ///         (the original offer stands). Either way the SME then accepts or declines.
    function reviewCounter(uint256 id, bool approve) external onlyRole(VERIFIER_ROLE) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Offered) revert WrongStatus(inv.status);
        uint256 proposed = counterPrice[id];
        if (proposed == 0) revert NoCounterPending();
        delete counterPrice[id];
        if (approve) {
            inv.price = proposed;
            inv.floorApplied = false;
        }
        emit CounterReviewed(id, approve, inv.price);
    }

    // ══════════════════════════════════════════════════════════════════
    // 4. Pooled investor funding + atomic settlement
    // ══════════════════════════════════════════════════════════════════
    function commit(uint256 id, uint256 cashAmount) external nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Listed) revert WrongStatus(inv.status);
        if (!registry.isEligibleInvestor(msg.sender)) revert NotEligibleInvestor();
        if (cashAmount == 0) revert InvalidAmount();

        uint256 remaining = inv.price - inv.committed;
        if (cashAmount > remaining) revert ExceedsRemaining(remaining);

        uint256 idx = _commitIndex[id][msg.sender];
        uint256 prior = idx == 0 ? 0 : _commitments[id][idx - 1].cash;
        uint256 total = prior + cashAmount;
        bool fillsBook = cashAmount == remaining;
        if (total < minTicket[inv.grade] && !fillsBook) revert BelowMinimumTicket(minTicket[inv.grade]);
        uint256 needed = outstandingCommitted[msg.sender] + cashAmount;
        if (cash.balanceOf(msg.sender) < needed || cash.allowance(msg.sender, address(this)) < needed) {
            revert InsufficientFundsOrAllowance();
        }

        uint256 notes = fillsBook
            ? inv.faceValue - inv.notesAllocated
            : (cashAmount * inv.faceValue) / inv.price;

        if (idx == 0) {
            if (_commitments[id].length >= MAX_COMMITMENTS) revert TooManyCommitments();
            _commitments[id].push(Commitment(msg.sender, cashAmount, notes));
            _commitIndex[id][msg.sender] = _commitments[id].length;
        } else {
            Commitment storage c = _commitments[id][idx - 1];
            c.cash = total;
            c.notes += notes;
        }
        inv.committed += cashAmount;
        inv.notesAllocated += notes;
        outstandingCommitted[msg.sender] += cashAmount;

        emit FundingCommitted(id, msg.sender, cashAmount, notes, inv.committed);

        if (inv.committed == inv.price) _settle(id);
    }

    function withdrawCommitment(uint256 id) external nonReentrant {
        _removeCommitment(id, msg.sender);
    }

    /// @notice Ops can drop a commitment that can no longer settle (investor moved funds away).
    function removeCommitment(uint256 id, address investor) external onlyRole(OPERATOR_ROLE) {
        _removeCommitment(id, investor);
    }

    function _removeCommitment(uint256 id, address investor) internal {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Listed) revert WrongStatus(inv.status);
        uint256 idx = _commitIndex[id][investor];
        if (idx == 0) revert InvalidAmount();
        Commitment[] storage list = _commitments[id];
        Commitment memory c = list[idx - 1];
        uint256 last = list.length;
        if (idx != last) {
            list[idx - 1] = list[last - 1];
            _commitIndex[id][list[idx - 1].investor] = idx;
        }
        list.pop();
        _commitIndex[id][investor] = 0;
        inv.committed -= c.cash;
        inv.notesAllocated -= c.notes;
        outstandingCommitted[investor] -= c.cash;
        emit CommitmentWithdrawn(id, investor, c.cash);
    }

    /// @dev Delivery-versus-payment in a single transaction. If any investor's cash
    ///      cannot be pulled, the whole settlement reverts: nobody pays without receiving
    ///      notes, and the SME is never paid partially.
    function _settle(uint256 id) internal {
        Invoice storage inv = _invoices[id];
        ReceivableNote note = ReceivableNote(inv.note);
        Commitment[] storage list = _commitments[id];

        for (uint256 i = 0; i < list.length; i++) {
            Commitment storage c = list[i];
            outstandingCommitted[c.investor] -= c.cash;
            try cash.transferFrom(c.investor, address(this), c.cash) returns (bool ok) {
                if (!ok) revert SettlementFailed(c.investor);
            } catch {
                revert SettlementFailed(c.investor);
            }
            note.mint(c.investor, c.notes);
        }
        cash.safeTransfer(inv.supplier, inv.price);

        inv.status = Status.Funded;
        inv.fundedAt = uint64(block.timestamp);
        invoiceNFT.setStatus(id, uint8(Status.Funded));
        emit AtomicSettlement(id, inv.supplier, inv.price, list.length, inv.faceValue);
    }

    // ══════════════════════════════════════════════════════════════════
    // 5. Maturity: buyer pays, smart contract distributes pro rata
    // ══════════════════════════════════════════════════════════════════
    function repay(uint256 id) external nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Funded) revert WrongStatus(inv.status);

        cash.safeTransferFrom(msg.sender, address(this), inv.faceValue);
        uint256 fee = (inv.faceValue * servicingFeeBps) / 10_000;
        if (fee > 0) cash.safeTransfer(treasury, fee);
        emit BuyerPaid(id, msg.sender, inv.faceValue, fee);

        _distribute(id, inv.faceValue - fee);
        inv.status = Status.Repaid;
        inv.closedAt = uint64(block.timestamp);
        invoiceNFT.setStatus(id, uint8(Status.Repaid));
    }

    /// @notice Buyer failed to pay: after the grace period, ops records the default and
    ///         passes any amount recovered through collections to note holders pro rata.
    ///         The sale was without recourse, so the SME is not asked to pay it back.
    function settleDefault(uint256 id, uint256 recovered) external onlyRole(OPERATOR_ROLE) nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Funded) revert WrongStatus(inv.status);
        uint64 after_ = inv.dueDate + defaultGracePeriod;
        if (block.timestamp <= after_) revert NotYetInDefault(after_);

        if (recovered > 0) {
            cash.safeTransferFrom(msg.sender, address(this), recovered);
            _distribute(id, recovered);
        } else {
            ReceivableNote(inv.note).retire();
        }
        inv.status = Status.Defaulted;
        inv.closedAt = uint64(block.timestamp);
        invoiceNFT.setStatus(id, uint8(Status.Defaulted));
        emit InvoiceDefaulted(id, recovered);
    }

    function _distribute(uint256 id, uint256 amount) internal {
        Invoice storage inv = _invoices[id];
        ReceivableNote note = ReceivableNote(inv.note);
        address[] memory holders = note.holders();
        uint256 supply = note.totalSupply();
        uint256 paid;
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 bal = note.balanceOf(holders[i]);
            uint256 share = i == holders.length - 1 ? amount - paid : (amount * bal) / supply;
            paid += share;
            cash.safeTransfer(holders[i], share);
            emit Distribution(id, holders[i], share, bal);
        }
        inv.distributed += paid;
        note.retire();
    }

    // ══════════════════════════════════════════════════════════════════
    // ERC-3643 agent controls (exercised by ReceivaSG operations)
    // ══════════════════════════════════════════════════════════════════
    function freezeHolder(uint256 id, address wallet, bool isFrozen) external onlyRole(OPERATOR_ROLE) {
        ReceivableNote(_invoices[id].note).setFrozen(wallet, isFrozen);
    }

    function pauseNote(uint256 id, bool isPaused) external onlyRole(OPERATOR_ROLE) {
        ReceivableNote(_invoices[id].note).setPaused(isPaused);
    }

    function recoverNotes(uint256 id, address from, address to, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        ReceivableNote(_invoices[id].note).forcedTransfer(from, to, amount);
    }

    // ── admin ─────────────────────────────────────────────────────────
    function setGradeParams(uint8 grade, uint16 bpsPer90d, uint256 ticket) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (grade > 6) revert InvalidGrade();
        require(bpsPer90d <= 5_000, "rate too high");
        discountBpsPer90d[grade] = bpsPer90d;
        minTicket[grade] = ticket;
        emit GradeParamsUpdated(grade, bpsPer90d, ticket);
    }

    function setServicingFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 100, "fee too high");
        servicingFeeBps = bps;
    }

    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
    }

    // ── views ─────────────────────────────────────────────────────────
    function getInvoice(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    function getCommitments(uint256 id) external view returns (Commitment[] memory) {
        return _commitments[id];
    }

    function gradeTable() external view returns (uint16[7] memory rates, uint256[7] memory tickets) {
        return (discountBpsPer90d, minTicket);
    }

    function noteOf(uint256 id) external view returns (address) {
        return _invoices[id].note;
    }

    function statusOf(uint256 id) external view returns (Status) {
        return _invoices[id].status;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
