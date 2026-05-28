# contracts/

Home of `RevenueBatchAnchor.sol` — the Arc Testnet audit-anchor contract (Merkle batch
roots + previous-root chaining). Built and tested with **Foundry**; licensed **MIT**.

**Deferred to Milestone 4.** Not part of the Milestone 0 credential-free scaffold. When
M4 begins: `forge init --force` here, add `RevenueBatchAnchor.sol` + Foundry tests, and
deploy to Arc Testnet. The contract spec (Merkle batch roots + previous-root chaining)
ships with the M4 design notes.
