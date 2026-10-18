// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title ReceivaSG Invoice NFT (ERC-721)
/// @notice The unique on-chain reference to one validated receivable. It is minted
///         to the SPV when the SME sells the invoice (true sale) and cannot be
///         transferred afterwards: it is an audit record, not a trading instrument.
///         Commercially sensitive documents stay off-chain; only the e-invoice hash
///         and lifecycle status are recorded here.
contract InvoiceNFT is ERC721, Ownable {
    using Strings for uint256;

    struct Record {
        bytes32 docHash;   // keccak256 of the Peppol/UBL e-invoice
        string invoiceRef; // supplier's invoice number
        uint256 faceValue; // S$ cents
        uint64 dueDate;
        uint8 grade;       // 0 = AAA ... 6 = CCC
        uint8 status;      // mirrors ReceivaSPV.Status
        address note;      // ERC-3643 note issued against this receivable
    }

    address public spv;
    mapping(uint256 => Record) private _records;

    event StatusUpdated(uint256 indexed tokenId, uint8 status);

    error NonTransferable();
    error OnlySPV();

    constructor(address admin) ERC721("ReceivaSG Invoice", "RSG-INV") Ownable(admin) {}

    /// @notice One-time wiring of the SPV contract that is allowed to mint.
    function setSPV(address spv_) external onlyOwner {
        require(spv == address(0), "SPV already set");
        spv = spv_;
    }

    modifier onlySPV() {
        if (msg.sender != spv) revert OnlySPV();
        _;
    }

    function mint(uint256 tokenId, Record calldata r) external onlySPV {
        _records[tokenId] = r;
        _safeMint(spv, tokenId);
    }

    function setStatus(uint256 tokenId, uint8 status) external onlySPV {
        _records[tokenId].status = status;
        emit StatusUpdated(tokenId, status);
    }

    function recordOf(uint256 tokenId) external view returns (Record memory) {
        return _records[tokenId];
    }

    /// @dev Soulbound: minting is the only movement allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Record storage r = _records[tokenId];
        string memory json = string.concat(
            '{"name":"ReceivaSG Invoice #', tokenId.toString(),
            '","description":"Validated receivable held by the ReceivaSG SPV",',
            '"attributes":[{"trait_type":"Invoice","value":"', r.invoiceRef,
            '"},{"trait_type":"Face value (SGD cents)","value":', r.faceValue.toString(),
            '},{"trait_type":"Due date","value":', uint256(r.dueDate).toString(),
            '},{"trait_type":"Grade","value":', uint256(r.grade).toString(),
            '},{"trait_type":"Status","value":', uint256(r.status).toString(),
            '}],"docHash":"', uint256(r.docHash).toHexString(32), '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
