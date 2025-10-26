# vincent-sponsor-transaction 

> ⚠️ **Warning: This package is intended for Hackathon DEMO purposes with simplified security mechanisms. Production environments should implement more rigorous security practices.**

This package is a **fork** of [LIT-Protocol/vincent-ability-starter-kit](https://github.com/LIT-Protocol/vincent-ability-starter-kit), primarily designed to demonstrate **Sponsored Gas Transactions** functionality.

## 🎯 Core Features


**Primary Capability: Enable zero-gas smart contract execution for users**

This Ability implements a **EIP-7702**-based sponsored transaction mechanism, allowing users to execute smart contract calls completely free of charge. All gas fees are covered by the application sponsor.

#### How It Works

1. **Delegation Pattern**

   - Uses Vincent Ability framework and Lit Protocol PKP (Programmable Key Pair)
   - User's PKP is authorized to sign transactions on behalf of the user
   - All transactions are signed through Lit Network nodes, ensuring decentralized security

2. **Gas Sponsorship Mechanism**

   - Integrates with Alchemy's EIP-7702 Gas Sponsorship API
   - Uses Alchemy's Smart Account for User Operations
   - Sponsors pre-configure policies to control which transactions can be sponsored

3. **Execution Flow**
   ```
   User Request → Vincent Ability (Lit Action) → Lit PKP Signing → Alchemy Gas Sponsorship → Transaction On-Chain
   ```

#### Security Considerations (Simplified for This DEMO)

**⚠️ This project uses simplified implementations for rapid prototyping:**

1. **Empty Policy Array**

   ```typescript
   supportedPolicies: supportedPoliciesForAbility([]);
   ```

   - Production: Implement comprehensive Policy validation
   - Examples: Amount limits, frequency limits, whitelist validation, etc.

2. **Direct sponsorApiKey Usage**

   - Production: Should validate API keys server-side
   - API keys should NOT be exposed in client-side or public environments

3. **Lack of Rate Limiting**
   - Production: Should implement transaction frequency limits
   - Prevents abuse and DoS attacks

#### Production Environment Recommendations

1. **Implement comprehensive Policy validation**
2. **Manage API Keys server-side**
3. **Add transaction amount and frequency limits**
4. **Implement audit logging and monitoring**
5. **Add transaction whitelisting functionality**

### Original Starter Kit Packages

This project retains the following packages from the original starter kit:

- An example Vincent Ability that sends native tokens
- An example Vincent Policy that counts ability executions
- End-to-end tests that automatically build, deploy, and exercise the example ability and policy

### See detailed documentation / guides at [docs.heyvincent.ai](https://docs.heyvincent.ai)

## Requirements

- Node.js: ^20.19.4
- pnpm: 10.7.0 (managed via Corepack)

### Using Corepack to use pnpm

This repo is configured to use pnpm and enforces it in the preinstall step. If you do not have pnpm set up, use Corepack:

```bash
# Enable Corepack globally (ships with Node 16.9+)
corepack enable

# Ensure npm & pnpm shims are enabled
corepack enable npm
corepack enable pnpm

# Or run the helper script from the repo root
pnpm run use-corepack
```

Notes:

- The repo sets "packageManager": "pnpm@10.7.0" in package.json. Corepack will automatically provision that version.
- The preinstall script scripts/check-packagemanager.sh verifies Node and Corepack are available and enforces pnpm via `npx only-allow pnpm`.

## Scripts

Root-level scripts you will commonly use:

| Script       | What it does                                            | Notes                                                                   |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| preinstall   | Ensures Node + Corepack are available and enforces pnpm | Runs automatically during `pnpm install`                                |
| build        | nx run-many -t build                                    | Builds all packages (includes action bundling via Nx deps)              |
| test         | nx run-many -t test                                     | Runs unit tests (if any)                                                |
| test-e2e     | nx run-many -t test-e2e                                 | Builds + deploys the example Ability & Policy, then runs Jest E2E tests |
| reset-e2e    | Moves packages/test-e2e/.env.test-e2e to a .backup file | Useful to re-run bootstrap for a new env                                |
| lint         | nx run-many -t lint                                     | Lints all packages                                                      |
| typecheck    | nx run-many -t typecheck                                | Types checks all packages                                               |
| clean        | nx reset and per-project clean                          | Removes build artifacts and node_modules in projects                    |
| prepare      | husky                                                   | Git hooks setup                                                         |
| use-corepack | corepack enable ...                                     | Quickly enables pnpm via Corepack                                       |
| reset        | pnpm clean && pnpm install                              | Full reinstall                                                          |
| hard-build   | pnpm reset && pnpm build                                | Clean reinstall and build                                               |
| bootstrap    | tsx ./src/bin/bootstrap.ts                              | Interactive environment setup (see Bootstrap flow)                      |

Project-level Nx targets you may find useful (run via pnpm nx ...):

| Target        | Project(s)                          | What it does                                                           |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| action:build  | ability-native-send, policy-counter | Bundles the Lit Action code for the Ability/Policy                     |
| action:deploy | ability-native-send, policy-counter | Builds (if needed) and deploys the Lit Action code                     |
| build         | all                                 | TypeScript build (depends on action:build where applicable)            |
| test-e2e      | test-e2e                            | Depends on deploying both the example Ability & Policy, then runs Jest |

## Packages in this repository

| Package                                           | Path                         | Purpose                                                                                                                                              |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| @lit-protocol/vincent-example-ability-native-send | packages/ability-native-send | An example Vincent Ability that sends native tokens to a user. Demonstrates Ability authoring, bundling, and deployment.                             |
| @lit-protocol/vincent-example-policy-counter      | packages/policy-counter      | An example Vincent Policy that counts the number of times an Ability is executed. Demonstrates Policy authoring, bundling, and deployment.           |
| @lit-protocol/vincent-example-e2e                 | packages/test-e2e            | Private package with end-to-end tests. It orchestrates building and deploying the example Ability & Policy and then runs integration tests via Jest. |

## Bootstrap flow

The bootstrap script guides you through configuring the repo for the first time and preparing the E2E environment.

Command:

```bash
pnpm bootstrap
```

What happens:

1. Pinata JWT setup
   - A Pinata JWT is required for e2e tests and for publishing Vincent Abilities and Policies to the Registry.
   - You will be prompted to obtain a Pinata JWT from https://app.pinata.cloud/developers/api-keys.
   - The JWT you provide will be stored in a root-level .env as `PINATA_JWT`. Tooling will use this to authenticate with Pinata.
   - If you already have a .env file, the script will skip this step.
2. Funder environment setup for E2E
   - You must fund a wallet with testLPX on the LIT testnet (Yellowstone). You can fund your wallet using the faucet as https://chronicle-yellowstone-faucet.getlit.dev/
   - Once you have funded your wallet, you must provide its private key for usage by tooling in the repository.
   - The bootstrap process creates additional test private keys (app manager, app delegatee, agent wallet PKP owner) and stores those keys in packages/test-e2e/.env.test-e2e

Notes:

- If a root .env already exists, the Pinata JWT step is skipped.
- If packages/test-e2e/.env.test-e2e already exists, bootstrap aborts with an error so you don’t overwrite your private keys. Use `pnpm reset-e2e` to back up the existing .env.test-e2e file, and re-run bootstrap.

## Quick start

It is recommended to use Corepack to ensure pnpm is used for the repository's package management. If you use a different package manager, you may experience problematic behavior.

1. Verify your version of corepack and ensure you are on > 0.31.0
   ```bash
   corepack -v
   npm install -g corepack@latest
   ```
2. Enable Corepack:
   ```bash
   corepack enable && corepack enable pnpm
   ```
3. Run bootstrap to build and configure the repository :
   ```bash
   pnpm bootstrap
   ```
4. Run the example end-to-end test flow:
   ```bash
   pnpm test-e2e
   ```
