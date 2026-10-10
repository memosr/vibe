// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title Vibe Folk Babies
/// @notice Vibe Love bebekleri. Görsel tamamen zincir üstünde (SVG). Her mint FOLK yakar.
contract VibeBabies is ERC721 {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable folk;
    address public owner;
    uint256 public price;       // yakılacak FOLK (en küçük birim)
    uint256 public totalSupply;
    uint256 public totalBurned;

    struct Baby { uint32 seed; uint8 rarity; uint64 born; string name; string dad; string mom; }
    mapping(uint256 => Baby) public babies;
    mapping(uint256 => bytes) private art;
    mapping(uint32 => uint256) public tokenOfSeed;

    event Born(uint256 indexed id, address indexed parent, uint32 seed, uint8 rarity, string name);
    event PriceChanged(uint256 price);

    constructor(address folk_, uint256 price_) ERC721("Vibe Folk Babies", "VBABY") {
        folk = IERC20(folk_);
        price = price_;
        owner = msg.sender;
    }

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
    function setPrice(uint256 p) external onlyOwner { price = p; emit PriceChanged(p); }
    function setOwner(address o) external onlyOwner { owner = o; }

    function mint(uint32 seed, uint8 rarity, string calldata name_, string calldata dad, string calldata mom, bytes calldata svg)
        external returns (uint256 id)
    {
        require(tokenOfSeed[seed] == 0, "already minted");
        require(rarity < 4, "rarity");
        _clean(name_, 20); _clean(dad, 12); _clean(mom, 12);
        require(svg.length > 10 && svg.length <= 12000, "svg size");
        require(svg[0] == "<" && svg[1] == "s" && svg[2] == "v" && svg[3] == "g", "svg");

        if (price > 0) {
            require(folk.transferFrom(msg.sender, DEAD, price), "burn failed");
            totalBurned += price;
        }
        id = ++totalSupply;
        tokenOfSeed[seed] = id;
        babies[id] = Baby(seed, rarity, uint64(block.timestamp), name_, dad, mom);
        art[id] = svg;
        _mint(msg.sender, id);
        emit Born(id, msg.sender, seed, rarity, name_);
    }

    // isimlerde sadece harf, rakam, boşluk, nokta ve tire (JSON güvenli)
    function _clean(string calldata s, uint256 maxLen) private pure {
        bytes calldata b = bytes(s);
        require(b.length > 0 && b.length <= maxLen, "name length");
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            require((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == " " || c == "." || c == "-", "name chars");
        }
    }

    function rarityName(uint8 r) public pure returns (string memory) {
        return r == 3 ? "Legendary" : r == 2 ? "Epic" : r == 1 ? "Rare" : "Common";
    }

    function svgOf(uint256 id) external view returns (string memory) { _requireOwned(id); return string(art[id]); }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Baby memory b = babies[id];
        string memory head = string.concat(
            '{"name":"', b.name, ' #', Strings.toString(id),
            '","description":"A Vibe Baby born to ', b.dad, ' and ', b.mom, ' in Vibe Love. Fully on-chain.",',
            '"external_url":"https://vibe-nine-woad.vercel.app/#love",'
        );
        string memory attrs = string.concat(
            '"attributes":[{"trait_type":"Rarity","value":"', rarityName(b.rarity),
            '"},{"trait_type":"Dad","value":"', b.dad,
            '"},{"trait_type":"Mom","value":"', b.mom,
            '"},{"trait_type":"Seed","value":"', Strings.toString(b.seed),
            '"},{"display_type":"date","trait_type":"Born","value":', Strings.toString(b.born), '}]'
        );
        string memory json = string.concat(head, '"image":"data:image/svg+xml;base64,', Base64.encode(art[id]), '",', attrs, '}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
