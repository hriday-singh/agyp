# Contributing to agyp

Thank you for considering contributing to `agyp`.

## Development Setup

### Prerequisites

- Node.js 20 (>=20.12) or higher
- The Antigravity (`agy`) CLI installed and on your system `PATH`
- On Linux (GUI): `libsecret-tools` or `libsecret` installed

### Getting Started

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/hriday-singh/agyp.git
   cd agyp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build and test:
   ```bash
   npm run build
   npm test
   npm run typecheck
   ```

## Development Guidelines

- **Zero runtime dependencies**: `agyp` relies strictly on Node.js built-in modules (`node:child_process`, `node:fs`, `node:crypto`, `node:os`, `node:path`). Do not add external runtime dependencies to `dependencies`.
- **Strict TypeScript**: Keep strict TypeScript typing enabled without `any`.
- **Unit testing**: All new commands, options, and logic must have accompanying unit tests in `test/`. Run `npm test` to verify before submitting PRs.
- **Cross-platform compatibility**: Ensure changes do not break on Windows or Linux.
