# Vendored sources: provenance

Nothing in this folder is ours. Files are byte-for-byte upstream (LF; `.gitattributes` marks them `-text`).
Do not edit them: change the adapter in `../src` instead.

## erc8004-contracts/ — official ERC-8004 reference implementation

- Repository: https://github.com/erc-8004/erc-8004-contracts
- Commit: `b9e466c250744a7e06b13dff9d3c2844ed64f825` (master, 2026-08-15, "Fixed typo"); contracts report `getVersion() = "2.0.0"`.
- Files (path in upstream `contracts/`, git blob id):
  - `IdentityRegistryUpgradeable.sol` `134b93126ae856548b5f3b09935c7b25336f01f3`
  - `ReputationRegistryUpgradeable.sol` `6d5ad6b1a8ccd78e2c36990b0fa9b74b68b9ea35`
  - `ValidationRegistryUpgradeable.sol` `7a28ef3372664e78618796692e92c3cc9e9ec7c8`
  - `ERC1967Proxy.sol` `30b6a155de08046aad766d740f405d26b38d134e`
  Check: `git hash-object --no-filters <file>` equals the blob id.
- Licence: every file carries `SPDX-License-Identifier: MIT`. (The repo has no LICENSE file and no GitHub licence; its
  README says "CC0 - Public Domain" and its package.json says "ISC". The per-file SPDX MIT header is the one we follow.)
- Not vendored: `MinimalUUPS.sol` (hard-codes the ERC-8004 team's owner `0x5472…2603`; replaced by
  `../src/LocalBootstrapUUPS.sol`), `MinimalUUPSMainnet.sol`, `HardhatMinimalUUPS.sol`, `SingletonFactory.sol`.
- Compiler settings copied from upstream `hardhat.config.ts`: solc 0.8.24, evmVersion shanghai, optimizer 200 runs, viaIR.

## openzeppelin-contracts-5.4.0/ and openzeppelin-contracts-upgradeable-5.4.0/

- npm `@openzeppelin/contracts@5.4.0`, integrity
  `sha512-eCYgWnLg6WO+X52I16TZt8uEjbtdkgLC0SUX/xnAksjjrQI4Xfn4iBRoI5j55dmlOhDv1Y7BoR3cU7e3WWhC6A==`
- npm `@openzeppelin/contracts-upgradeable@5.4.0`, integrity
  `sha512-STJKyDzUcYuB35Zub1JpWW58JxvrFFVgQ+Ykdr8A9PGXgtq/obF5uoh07k2XmFyPxfnZdPdBdhkJ/n2YxJ87HQ==`
- Both integrities equal the ones pinned in the reference repo's `package-lock.json` at the commit above.
- Licence: MIT (package.json of each, kept here).
- Only the files the build actually compiles are kept (taken from forge's build-info); the rest of each package is omitted.

## sha256 of every vendored file

    d70ae5779f17b5a0b42eea535227f4004072ccc35b4d0b4ffe7c0ed5502a25c5  erc8004-contracts/ERC1967Proxy.sol
    18c8ca8c88493b46e54d000c96eaf7470d1f9dbfe55493fd7fa923bae543ff75  erc8004-contracts/IdentityRegistryUpgradeable.sol
    9063eba192391c3e6959edcad452184f07a6c1b3975391e7c4d77dbf1eaabf09  erc8004-contracts/ReputationRegistryUpgradeable.sol
    26b1ebb8718abfeba1f12d51201f2adcf6c02f5bde79902532bd2d8fc3657882  erc8004-contracts/ValidationRegistryUpgradeable.sol
    2d17bba201aa2f9c55e317315b872272a60361848dfceb6b1e77081265c79a27  openzeppelin-contracts-5.4.0/interfaces/IERC1271.sol
    dfb3f56fa928a7c6cae41a7ce2c86b9210fa18d33fa26389099d66a0fa790368  openzeppelin-contracts-5.4.0/interfaces/IERC165.sol
    c4e901318ab6d4963582c62c62ce988a34c68dbae71846b67decacde79e9a317  openzeppelin-contracts-5.4.0/interfaces/IERC1967.sol
    2b14563481c355e6a84127f0ee528d3e3b80fcdd76ff840660784c2445fcc0ae  openzeppelin-contracts-5.4.0/interfaces/IERC4906.sol
    f89772d2d4fafcbef8b73bb10ee9a3373edec2eedb2f1b302320915b351dc3d1  openzeppelin-contracts-5.4.0/interfaces/IERC5267.sol
    4e4412e3eb28d5d2055e7b0e8153a2ab4d143f94e125a03a1b3d655ea7ed0002  openzeppelin-contracts-5.4.0/interfaces/IERC721.sol
    73653312bc2eda0ec231553a5295242eaef2d4f46a023532d45fe76cbd0f565f  openzeppelin-contracts-5.4.0/interfaces/draft-IERC1822.sol
    df936240c9a5d342582cbda70dd773b1c1d0e0dda3042b1c17b902ef0c36827b  openzeppelin-contracts-5.4.0/interfaces/draft-IERC6093.sol
    8c5b490fe133a9dda13c9a2915761c6b6c2e003a16c95863a800ce5527992bc4  openzeppelin-contracts-5.4.0/package.json
    a06fe97082355529c1da9076ea6c4518875ca9fdb1a4fa1e194c35cff21b29a1  openzeppelin-contracts-5.4.0/proxy/ERC1967/ERC1967Proxy.sol
    58c5b19893bf3d7f9e1aa0edc5b908b915eb7af4381800deb425a6e5331f4432  openzeppelin-contracts-5.4.0/proxy/ERC1967/ERC1967Utils.sol
    5f5081378d4bc82b814b0d64990b7f7b9c69697593b73a3341f4a269940ba540  openzeppelin-contracts-5.4.0/proxy/Proxy.sol
    c1c9726bbb0ec4c540c7c98059dcded69a8586b46c168036672381033ee76239  openzeppelin-contracts-5.4.0/proxy/beacon/IBeacon.sol
    ff0eb9902bf0ac099205615fac90eacf34fae637571b05aab3ea35dea53d5f17  openzeppelin-contracts-5.4.0/token/ERC721/IERC721.sol
    eafee3ffdc7cb2fba4bf6bd16fb28f8e5b4679742e81c2ad42a1b1df5c179feb  openzeppelin-contracts-5.4.0/token/ERC721/IERC721Receiver.sol
    33223782ea652dca413702ce92f9f59d91d758a035065b24bbedb7dc60c63a78  openzeppelin-contracts-5.4.0/token/ERC721/extensions/IERC721Metadata.sol
    f2041b1685dcf0cf6b968d9b8454e5a46068b1df5ab0e82ba0b269fa2f3099a8  openzeppelin-contracts-5.4.0/token/ERC721/utils/ERC721Utils.sol
    f1a9255dbc40cf9ae7c786abed3b022691a9d24bca0c7f05dc60e63421d405ab  openzeppelin-contracts-5.4.0/utils/Address.sol
    0704b9d6c032cca8512a3bc3f30f49f86f1f03102d2896a3d23e794b82efea66  openzeppelin-contracts-5.4.0/utils/Errors.sol
    270fc8401c1a13fae6a7a4a2dd6e381b95d658896701e51f0d3e2688acab3dec  openzeppelin-contracts-5.4.0/utils/Panic.sol
    75704538dcb223239280c6726d9a31cf769a7816718517c997fc7d63bdb70778  openzeppelin-contracts-5.4.0/utils/StorageSlot.sol
    2db7d21151644c57f75ed3ab55e87f3cf7fbf587a65345650fd740e2cfd50be3  openzeppelin-contracts-5.4.0/utils/Strings.sol
    0964ddd02f4a7a8cf9ba130e3aeead588ca3d425d5bc13cc4221358c69108ed0  openzeppelin-contracts-5.4.0/utils/cryptography/ECDSA.sol
    936a89f512d5da84b0896b66d2398f2bea9eefdf2afa788af5265fcd74302693  openzeppelin-contracts-5.4.0/utils/cryptography/MessageHashUtils.sol
    9055c2994b37dea1a41b7b7926dcb510f05dbe2540b0aafc5fbee9558fffd0ca  openzeppelin-contracts-5.4.0/utils/introspection/IERC165.sol
    92fee281fd46a1b058b190cf21d6b1a528f0433a907850ae1c9bcf36c5c0cd98  openzeppelin-contracts-5.4.0/utils/math/Math.sol
    9769274bf53f26a7c7896c526ea1980dc9bea5bf5c2a5fd04870008c4afc1de9  openzeppelin-contracts-5.4.0/utils/math/SafeCast.sol
    1ed50b1056af886752f0fb48a0165d381e69bb4a4b18b893b066dc144a7e08d7  openzeppelin-contracts-5.4.0/utils/math/SignedMath.sol
    9247b9ad7939d23990dbdc9274917c3762ffb37e5137ef7bbfcc2e2fba1b8dd2  openzeppelin-contracts-upgradeable-5.4.0/access/OwnableUpgradeable.sol
    a2b61919debcbc734d1a7c7bd93a0154c8265a7912aff09c736db7cd022f6050  openzeppelin-contracts-upgradeable-5.4.0/package.json
    f527a063813c2bf60c153fb08e38539578935402894fcc36fac42324ca325d3b  openzeppelin-contracts-upgradeable-5.4.0/proxy/utils/Initializable.sol
    2d07bcf9728190a5c807cf68defc3f3c52aa098d04770d44af37f30abade38d5  openzeppelin-contracts-upgradeable-5.4.0/proxy/utils/UUPSUpgradeable.sol
    2589016aed958e644f7235481c1639a8657640a746c33cbd9f42a5cc28519604  openzeppelin-contracts-upgradeable-5.4.0/token/ERC721/ERC721Upgradeable.sol
    205704dcb4f17cb667aecbb8a0a66bdd175012d342e1c3abd469b67449b8e7f3  openzeppelin-contracts-upgradeable-5.4.0/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol
    a08e16324da33a9d666dc07a22ae58031c242a3869f6808e55b4b82fc70cb209  openzeppelin-contracts-upgradeable-5.4.0/utils/ContextUpgradeable.sol
    91c98a39169b1ad2a4babb09e7a7c89d895956739d3f960701911cbc8b542050  openzeppelin-contracts-upgradeable-5.4.0/utils/cryptography/EIP712Upgradeable.sol
    d2105a1e3ba533399fb408105267329c2c134fcb18043a9c024d1b6e81982fc9  openzeppelin-contracts-upgradeable-5.4.0/utils/introspection/ERC165Upgradeable.sol
