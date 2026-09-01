# Figure Collector Backend API

Backend API service for the Figure Collector application. Provides endpoints for user authentication (including email verification, 2FA/TOTP, and WebAuthn passkeys), figure management, list management, MFC sync orchestration, admin configuration, and acts as the orchestrator for microservices version management. Includes comprehensive test coverage with Jest and Supertest.

## Features

- **User Authentication**: Register, login, JWT access/refresh tokens, session management
- **Email Verification**: Verification flow with configurable grace period, password reset
- **Two-Factor Authentication**: TOTP (authenticator apps) and backup codes
- **WebAuthn Passkeys**: FIDO2/WebAuthn credential registration and passwordless login
- **Figure Management**: Full CRUD operations with pagination
- **Search**: MongoDB Atlas Search with regex fallback
- **Filtering and Statistics**: Advanced figure filtering and collection stats
- **List Management**: User-defined lists with item tracking and MFC list sync
- **MFC Sync Orchestration**: Full sync pipeline with SSE streaming, job management, and scraper webhook integration
- **Admin Configuration**: Dynamic system config (scripts, markdown, JSON) with public/private access
- **Lookup Data**: Role types, companies, and artists reference endpoints
- **Rate Limiting**: Per-endpoint rate limiting via express-rate-limit
- **Service Health**: Version reporting and health checks across services
- **Schema v3.0**: Enhanced data models for MFC integration (17 models)

## Technology Stack

- **Runtime**: Node.js 25 (Alpine)
- **Language**: TypeScript 5.9.3
- **Framework**: Express 5.2.1
- **Database**: MongoDB with Mongoose 8.19.2
- **Authentication**: JWT (jsonwebtoken) + bcryptjs
- **2FA/Passkeys**: @simplewebauthn/server + otpauth (TOTP)
- **Email**: Resend API
- **Validation**: Joi
- **Rate Limiting**: express-rate-limit
- **Testing**: Jest 30 + Supertest 7 + mongodb-memory-server
- **Dev Server**: tsx (esbuild-based)

## Version Management Architecture

The backend acts as the central orchestrator for service version reporting:

- **Self-Reporting**: Each service exposes a `/health` endpoint with `{service, version, status}`
- **Version Aggregation**: Backend's `/version` endpoint aggregates health status from all services
- **Unified API**: Single `/version` endpoint provides complete service health and version information
- **Frontend Integration**: Frontend enriches aggregated data with its own version from package.json

## Recent Updates

### Development Server (tsx)
Switched from `ts-node-dev` to `tsx` for faster development server startup:
- **tsx** uses esbuild under the hood for near-instant TypeScript compilation
- Automatic `.env` file loading via `--env-file` flag
- Hot reload with `tsx watch` for seamless development

### SSE Token Support
Auth middleware now supports query parameter tokens for SSE (Server-Sent Events) connections:
- EventSource API cannot set custom headers, requiring token in URL
- Format: `/sync/events/:sessionId?token=<jwt>`
- Falls back to standard `Authorization: Bearer <token>` header when available

## Development

### Environment Setup

**Quick Start:**
```bash
# Auto-generate .env file with secure random secrets
./setup-local-env.sh

# Or manually copy and edit
cp .env.example .env
# Then edit .env and replace placeholder values
```

**Configuration Files:**
- `.env.example` - Template showing required environment variables
- `setup-local-env.sh` - Script to auto-generate .env with random JWT secrets
- `.env` - Your local configuration (gitignored, never commit this!)

See `.env.example` for all configuration options including:
- Local MongoDB (default) vs MongoDB Atlas
- JWT secrets and token expiry settings
- Optional refresh token rotation
- Email verification, TOTP 2FA, and WebAuthn passkey configuration

### Local Development

```bash
# Install dependencies
npm install

# Set up environment (first time only)
./setup-local-env.sh

# Start MongoDB (if using local MongoDB)
docker run -d -p 27017:27017 --name mongodb mongo:latest

# Start development server (uses tsx for fast startup)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### Testing in Development

```bash
# Run tests in watch mode
npm run test:watch

# Test specific functionality
npx jest tests/integration/figures.test.ts --watch

# Check test coverage
npm run test:coverage
```

### Docker

The service uses a multi-stage Dockerfile based on Node.js 25 Alpine:

```bash
# Development (with hot reload)
docker build --target development -t backend:dev .
docker run -p 5070:5070 -e PORT=5070 backend:dev

# Test environment
docker build --target test -t backend:test .
docker run backend:test

# Production (default)
docker build -t backend:prod .
docker run -p 5050:5050 -e PORT=5050 backend:prod
```

**Available stages:**
- `base`: Node.js 25 Alpine with dumb-init
- `development`: Includes devDependencies and nodemon for hot reload
- `test`: Test environment with Jest
- `builder`: Compiles TypeScript to JavaScript
- `production`: Optimized image with only production dependencies (default)

## API Endpoints

**Infrastructure Endpoints** (accessed directly via nginx proxy)
- `GET /version` - Aggregated service health and version information
- `GET /health` - Service health check with version info

**Business Logic APIs** (accessed via `/api` prefix through nginx)

Note: The nginx frontend proxy strips `/api` prefix, so backend endpoints don't include `/api` in their paths.

### Authentication Endpoints (`/auth`)

- `POST /auth/register` - Register a new user
- `POST /auth/login` - Login and receive access/refresh tokens
- `POST /auth/refresh` - Obtain a new access token using a refresh token
- `POST /auth/logout` - Logout current session
- `POST /auth/logout-all` - Logout from all active sessions
- `GET /auth/sessions` - Retrieve all active sessions for the user
- `GET /auth/profile` - Get authenticated user profile
- `PUT /auth/profile` - Update authenticated user profile

**Email Verification & Password Reset:**
- `POST /auth/verify-email` - Verify email with token
- `POST /auth/resend-verification` - Resend verification email
- `POST /auth/forgot-password` - Request password reset email
- `POST /auth/reset-password` - Reset password with token

**Two-Factor Authentication:**
- `POST /auth/2fa/verify` - Verify 2FA code during login
- `POST /auth/2fa/totp/setup` - Begin TOTP setup (returns QR code)
- `POST /auth/2fa/totp/verify-setup` - Confirm TOTP setup with verification code
- `DELETE /auth/2fa/totp` - Remove TOTP from account
- `POST /auth/2fa/backup-codes` - Generate new backup codes

**WebAuthn Passkeys:**
- `POST /auth/webauthn/register/options` - Get registration options for new passkey
- `POST /auth/webauthn/register/verify` - Verify and store new passkey
- `POST /auth/webauthn/login/options` - Get authentication options
- `POST /auth/webauthn/login/verify` - Verify passkey authentication
- `DELETE /auth/webauthn/credential/:id` - Remove a registered passkey

**Note**: All authentication endpoints return responses in the `data.data` structure

### Figure Endpoints (`/figures`)

- `GET /figures` - List figures (paginated with `page` and `limit` query parameters)
- `GET /figures/search` - Search figures
- `GET /figures/filter` - Filter figures by criteria
- `GET /figures/stats` - Collection statistics
- `GET /figures/:id` - Get figure by ID
- `POST /figures` - Create a new figure
- `POST /figures/scrape-mfc` - MFC scraping proxy endpoint
- `PUT /figures/:id` - Update a figure
- `DELETE /figures/:id` - Delete a figure
- `GET /figures/public/search` - Public figure search (no auth required)

### User Endpoints (`/users`)

- `GET /users/profile` - Get user profile
- `PUT /users/profile` - Update user profile

### List Endpoints (`/lists`)

- `GET /lists` - Get all user lists
- `GET /lists/:id` - Get a specific list
- `GET /lists/by-item/:mfcId` - Find lists containing an MFC item
- `POST /lists` - Create a new list
- `POST /lists/sync` - Sync lists from MFC
- `POST /lists/:id/items` - Add items to a list
- `PUT /lists/:id` - Update a list
- `DELETE /lists/:id` - Delete a list
- `DELETE /lists/:id/items` - Remove items from a list

### Sync Endpoints (`/sync`)

- `POST /sync/validate-cookies` - Validate MFC session cookies
- `POST /sync/parse-csv` - Parse MFC CSV export
- `POST /sync/from-csv` - Import figures from CSV
- `POST /sync/full` - Start full MFC sync (scraper integration)
- `POST /sync/job` - Create a sync job
- `GET /sync/status` - Get current sync status
- `GET /sync/queue-stats` - Get sync queue statistics
- `GET /sync/stream/:sessionId` - SSE stream for sync progress
- `GET /sync/active-job` - Get the currently active sync job
- `GET /sync/job/:sessionId` - Get a specific sync job
- `DELETE /sync/job/:sessionId` - Cancel a sync job
- `GET /sync/mfc/cookie-allowlist` - Get MFC cookie allowlist

**Scraper Webhooks** (HMAC-SHA256 signed):
- `POST /sync/webhook/item-complete` - Item sync completion callback
- `POST /sync/webhook/phase-change` - Sync phase transition callback
- `POST /sync/webhook/lists-sync` - Lists sync completion callback

### Lookup Endpoints (`/lookup`)

- `GET /lookup/role-types` - Get all role types
- `GET /lookup/companies` - Get all companies
- `GET /lookup/artists` - Get all artists

### Admin Endpoints (`/admin`)

- `POST /admin/bootstrap` - Grant admin privileges using bootstrap token
  - Body: `{ email: string, token: string }`
  - Requires: `ADMIN_BOOTSTRAP_TOKEN` environment variable
- `GET /admin/config` - List all system configs (admin only)
- `GET /admin/config/:key` - Get specific config by key (admin only)
- `PUT /admin/config/:key` - Create or update a config (admin only)
  - Body: `{ value: string, type?: 'script'|'markdown'|'json'|'text', description?: string, isPublic?: boolean }`
- `DELETE /admin/config/:key` - Delete a config (admin only)
- `GET /config/:key` - Get a public config (no auth required)

**Config Key Format**: Must be lowercase, start with a letter, and contain only alphanumeric characters and underscores (e.g., `mfc_cookie_script`).

### Rate Limiting

Key endpoints are protected by express-rate-limit to prevent abuse:
- Authentication endpoints (login, register) have stricter limits
- General API endpoints use standard rate windows
- Rate limit headers are included in responses (`X-RateLimit-*`)

### Environment Variables

See `.env.example` for complete configuration template. Run `./setup-local-env.sh` to auto-generate.

**Required:**
- `MONGODB_URI`: MongoDB connection string (local: `mongodb://localhost:27017/figure-collector-dev` or Atlas)
- `JWT_SECRET`: Secret for JWT token signing (must be at least 32 characters in production)
- `JWT_REFRESH_SECRET`: Secret for refresh token signing (must be at least 32 characters in production)
- `SCRAPER_SERVICE_URL`: URL to scraper service
  - Local dev: `http://localhost:3080`
  - Docker prod: `http://scraper:3050`
  - Docker Coolify dev: `http://scraper-dev:3090`
  - (Must match service/network name for container DNS resolution)
- `BACKEND_URL`: Public URL of this backend service (used in webhook URLs sent to scraper)
  - Local dev: `http://localhost:5080`
  - Docker prod: `http://backend:5050`
  - Docker Coolify dev: `http://backend:5090`
  - (Must be reachable from the scraper container for sync webhook callbacks)
- `PORT`: Port for backend service (prod: 5050, local dev: 5080)
- `NODE_ENV`: Environment (development/production)

**Optional:**
- `ACCESS_TOKEN_EXPIRY`: Access token expiration time (default: 15m)
- `ROTATE_REFRESH_TOKENS`: Enable refresh token rotation for enhanced security (default: false)
- `ADMIN_BOOTSTRAP_TOKEN`: Secret token for granting admin privileges via `POST /admin/bootstrap`
  - Generate a secure token: `openssl rand -base64 32`
  - After granting admin to your user, the token can be changed or removed
- `ENABLE_ATLAS_SEARCH`: Set to `true` on environments with Atlas Search indexes configured
  - Enables Atlas Search `$search` operator for advanced search features
  - Falls back to regex search when not set or when `TEST_MODE=memory`

**Auth Modernization (Email Verification, 2FA, Passkeys):**
- `EMAIL_FROM`: Sender address for verification/reset emails (default: `noreply@figurecollecting.com`)
- `FRONTEND_URL`: Base URL for email links (local: `http://localhost:5081`, prod: `https://figurecollecting.com`)
- `RESEND_API_KEY`: Resend API key for sending emails (omit for console fallback in dev)
- `EMAIL_VERIFICATION_EXPIRY_HOURS`: Token expiry for email verification (default: 24)
- `PASSWORD_RESET_EXPIRY_MINUTES`: Token expiry for password reset (default: 30)
- `EMAIL_VERIFICATION_GRACE_DAYS`: Grace period before verification is enforced (default: 7)
- `TOTP_ENCRYPTION_KEY`: AES-256-GCM key for encrypting TOTP secrets -- generate with `openssl rand -hex 32`
  - Must match across environments sharing the same database
  - Do not change after users have set up 2FA -- existing secrets become undecryptable
- `WEBAUTHN_RP_NAME`: Relying party display name for passkey prompts (default: `FigureCollecting`)
- `WEBAUTHN_RP_ID`: Domain for passkey binding (local: `localhost`, prod: `figurecollecting.com`)
- `WEBAUTHN_ORIGIN`: Full origin URL for WebAuthn (local: `http://localhost:5081`, prod: `https://figurecollecting.com`)

**Debug Logging:**
- `DEBUG`: Set to `true` to enable all application loggers (AUTH, SYNC, MAIN, DATABASE, etc.)
- `DEBUG_LEVEL`: Log level threshold -- `verbose`, `info`, `warn`, or `error` (default: `info` in development, `error` in production)
- `DEBUG_MODULES`: Comma-separated list of modules to enable (e.g., `AUTH,SYNC`), or `*` for all. Only needed if `DEBUG` is not `true`
- `SERVICE_AUTH_TOKEN_DEBUG`: Show partial tokens in logs for debugging (default: false)

**Security Note:**
- Generate secure secrets using: `openssl rand -base64 32`
- Or run `./setup-local-env.sh` to auto-generate random secrets
- Never commit `.env` files (already in .gitignore)

### Token Management

The authentication system uses a two-token strategy with enhanced security:
- **Access Token**: Short-lived JWT for API access (15 minutes expiry by default)
- **Refresh Token**: Long-lived cryptographically secure token (7 days expiry) stored as HMAC-SHA256 hash in MongoDB

Security Features:
- **Zero Trust Validation**: Every protected request validates user exists in the current database (prevents cross-environment token reuse)
- **Hashed Storage**: Refresh tokens are hashed using HMAC-SHA256 before database storage
- **Secure Generation**: Refresh tokens use cryptographically secure random generation
- **Token Rotation**: Optional refresh token rotation on each use (configurable)
- **Session Tracking**: Device and IP address tracking for all active sessions
- **Revocation**: Individual or bulk session revocation capabilities
- **Error Sanitization**: Production environment returns generic error messages to prevent information leakage

Token Response Structure:
```json
{
  "data": {
    "accessToken": "...",
    "refreshToken": "..."
  }
}
```

## Schema v3.0 Data Models

Schema v3.0 introduces enhanced data models for MFC (MyFigureCollection) integration:

| Model | Purpose | Key Features |
|-------|---------|--------------|
| **User** | User accounts | Authentication, roles, email verification status |
| **Figure** | Legacy figure data | CRUD operations, backwards compatibility |
| **MFCItem** | Shared catalog data | Releases, dimensions, community stats |
| **UserFigure** | User-specific data | Collection status, purchase info, ratings |
| **RoleType** | Dynamic role registry | Company/Artist/Relation kinds, system seeding |
| **Company** | Manufacturers, distributors | Role-based categorization, MFC ID linking |
| **Artist** | Sculptors, illustrators | Role-based categorization, portfolio linking |
| **MfcList** | User MFC lists | List sync from MFC, item tracking |
| **SearchIndex** | Unified search | Cross-entity search, Atlas 3-index limit workaround |
| **SyncJob** | Sync job tracking | Job state machine, progress, SSE sessions |
| **RefreshToken** | JWT refresh tokens | HMAC-SHA256 hashed, session metadata |
| **EmailVerificationToken** | Email verification | Token-based email confirmation |
| **PasswordResetToken** | Password reset | Time-limited reset tokens |
| **TwoFactorSession** | 2FA pending sessions | Temporary session during 2FA verification |
| **WebAuthnChallenge** | WebAuthn challenges | Challenge storage for passkey ceremonies |
| **SystemConfig** | Admin configuration | Dynamic key-value config, public/private access |

**Automatic Seeding**: System role types (Manufacturer, Sculptor, etc.) are seeded automatically on app startup. This is idempotent and safe to run on every deployment.

**Atlas Search**: See `docs/SCHEMA_V3_INDEX_GUIDE.md` for index configuration and deployment procedures.

## Controllers

| Controller | Responsibility |
|------------|----------------|
| **authController** | Login, registration, token refresh, logout, session management |
| **emailVerificationController** | Email verification flow, resend, password reset |
| **twoFactorController** | TOTP setup/verify, backup codes, WebAuthn ceremonies |
| **figureController** | Figure CRUD operations |
| **searchController** | Figure search (Atlas Search and regex fallback) |
| **statsController** | Collection statistics aggregation |
| **listController** | List CRUD, item management, MFC list sync |
| **lookupController** | Role types, companies, artists reference data |
| **userController** | User profile management |
| **adminController** | Admin bootstrap, system config CRUD |

## Services

| Service | Responsibility |
|---------|----------------|
| **emailService** | Email delivery via Resend API (with console fallback for dev) |
| **webauthnService** | WebAuthn credential registration and authentication |
| **totpService** | TOTP secret generation, encryption (AES-256-GCM), and verification |
| **searchIndexService** | SearchIndex document management for unified search |
| **staleSessionMonitor** | Periodic cleanup of expired sessions and tokens |
| **atlasSearchService** | MongoDB Atlas Search `$search` query builder |
| **regexSearchService** | Regex-based search fallback for non-Atlas environments |

## Middleware

| Middleware | Responsibility |
|------------|----------------|
| **authMiddleware** | JWT verification, user lookup, admin role check, SSE query token support |
| **validationMiddleware** | Joi-based request validation and input sanitization |
| **emailVerificationMiddleware** | Enforces email verification with configurable grace period |

## Webhook Integration

The sync system communicates with the scraper service via webhooks:

- **Outbound**: Backend sends sync requests to scraper with callback URLs
- **Inbound**: Scraper sends progress updates back to backend webhook endpoints
- **Security**: All webhook payloads are signed with HMAC-SHA256 for authenticity verification
- **Endpoints**: `item-complete`, `phase-change`, and `lists-sync` callbacks

## Testing

The backend includes extensive test infrastructure with 55 test files, approximately **954 tests across 51 suites**. All tests pass without any skipped tests.

### Test Coverage

- **Unit Tests**: Models, controllers, middleware, utilities
- **Integration Tests**: API endpoints with database operations, route validation
- **Service Tests**: Search services, session monitoring, search index management
- **Performance Tests**: Database queries and API response times
- **Authentication Tests**: JWT handling, registration, login, 2FA, WebAuthn
- **Sync Tests**: Webhook handling, job lifecycle, SSE streaming, cancellation
- **Cross-Service Tests**: Backend-scraper integration, end-to-end workflows
- **Error Handling Tests**: Various failure scenarios

### Test Structure

```
tests/
├── config/
│   └── db.test.ts                        # Database configuration tests
├── controllers/
│   ├── authController.test.ts            # Auth controller unit tests
│   ├── figureController.test.ts          # Figure controller unit tests
│   ├── lookupController.test.ts          # Lookup controller unit tests
│   ├── searchController.test.ts          # Search controller unit tests
│   ├── statsController.test.ts           # Stats controller unit tests
│   └── userController.test.ts            # User controller unit tests
├── integration/
│   ├── adminRoutes.test.ts               # Admin endpoint tests
│   ├── atlasSearch.test.ts               # Atlas Search integration
│   ├── authRoutes.test.ts                # Auth endpoint tests
│   ├── database.test.ts                  # Database integration tests
│   ├── figureRoutes.test.ts              # Figure CRUD tests
│   ├── figureRoutes.sortValidation.test.ts # Figure sort validation
│   ├── listRoutes.test.ts                # List endpoint tests
│   ├── lookupRoutes.test.ts              # Lookup endpoint tests
│   ├── routeValidation.test.ts           # Route validation tests
│   ├── serviceEndpoints.test.ts          # Service endpoint tests
│   ├── syncRoutes.activeJob.test.ts      # Active job management
│   ├── syncRoutes.cancel.test.ts         # Sync cancellation
│   ├── syncRoutes.jobCrud.test.ts        # Sync job CRUD
│   ├── syncRoutes.listsSync.test.ts      # Lists sync webhooks
│   ├── syncRoutes.phaseChange.test.ts    # Phase change webhooks
│   ├── syncRoutes.proxy.test.ts          # Sync proxy tests
│   ├── syncRoutes.webhook.test.ts        # Webhook handling
│   ├── syncRoutes.webhookV3.test.ts      # V3 webhook handling
│   ├── userRoutes.test.ts                # User endpoint tests
│   ├── cross-service/
│   │   ├── backend-scraper-integration.test.ts
│   │   └── end-to-end-workflows.test.ts
│   └── database/
│       └── dbConnection.test.ts          # DB connection tests
├── middleware/
│   └── authMiddleware.test.ts            # Auth middleware tests
├── models/
│   ├── Artist.test.ts                    # Artist model tests
│   ├── Company.test.ts                   # Company model tests
│   ├── Figure.test.ts                    # Figure model tests
│   ├── MFCItem.test.ts                   # MFC item model tests
│   ├── MfcList.test.ts                   # MFC list model tests
│   ├── RoleType.test.ts                  # Role type model tests
│   ├── SearchIndex.test.ts               # Search index model tests
│   ├── SyncJob.test.ts                   # Sync job model tests
│   ├── User.test.ts                      # User model tests
│   └── UserFigure.test.ts               # User figure model tests
├── performance/
│   └── stress.test.ts                    # Performance & stress tests
├── services/
│   ├── searchIndexService.test.ts        # Search index service tests
│   ├── staleSessionMonitor.test.ts       # Session monitor tests
│   └── search/
│       ├── atlasSearchService.test.ts    # Atlas Search service tests
│       ├── index.test.ts                 # Search service index tests
│       └── regexSearchService.test.ts    # Regex search service tests
├── unit/
│   ├── atlasSearchMock.test.ts           # Atlas Search mock tests
│   ├── auth/
│   │   ├── jwtValidation.test.ts         # JWT validation tests
│   │   └── tokenHashing.test.ts          # Token hashing tests
│   └── middleware/
│       └── validationMiddleware.test.ts  # Validation middleware tests
└── utils/
    ├── errorUtils.test.ts                # Error utility tests
    ├── parseDimensions.test.ts           # Dimension parsing tests
    ├── responseUtils.test.ts             # Response utility tests
    └── tagValidation.test.ts             # Tag validation tests
```

### Running Tests

**WSL Setup Required**: Install Node.js via NVM (see [WSL_TEST_FIX_SOLUTION.md](../WSL_TEST_FIX_SOLUTION.md))

```bash
# Install dependencies
npm install

# Run all tests (memory mode)
npm run test:memory

# Run with coverage report
npm run test:coverage

# Run in watch mode (development)
npm run test:watch

# Run Docker-based test suite
npm run test:docker

# Run specific test suite
npx jest tests/integration/authRoutes.test.ts

# Run performance stress tests
npx jest tests/performance/stress.test.ts

# Run tests matching pattern
npx jest --testNamePattern="user authentication"
```

### Docker Testing Infrastructure

- Comprehensive Docker test containers for isolated testing
- Automated test scripts for containerized environment
- Supports both CI/CD and local development testing modes
- Performance and stress testing via dedicated Docker configurations
- Cross-platform compatibility with WSL and native Linux environments

**Toggleable Test Container (`Dockerfile.test`):**
```bash
# Build test image
docker build -f Dockerfile.test -t backend:test .

# Mode 1: Run tests (default)
docker run backend:test

# Mode 2: Run as service (for integration testing)
docker run -e RUN_SERVER=1 -p 3015:3015 backend:test
```

The test container can switch between running tests or starting the service based on the `RUN_SERVER` environment variable, making it flexible for different testing scenarios.

### Test Configuration

The backend uses Jest 30 with TypeScript support:

- **Framework**: Jest 30 with ts-jest
- **HTTP Testing**: Supertest 7 for API endpoint testing
- **Database**: mongodb-memory-server for isolated testing
- **Coverage**: Configured for comprehensive code coverage

### Mocking Strategy

- **External Services**: Scraper and Version Service APIs mocked
- **Database**: Uses in-memory MongoDB instance
- **JWT**: Mocked JWT tokens for authentication tests
- **Environment**: Test-specific environment variables
- **Validation**: Mocked input validation middleware with test scenarios for edge cases
- **Webhooks**: HMAC signature verification mocked for webhook tests

### Security Enhancements

Implemented comprehensive security improvements:
- **JWT Configuration Validation**: Fails fast if JWT secrets aren't properly configured
- **Minimum Secret Length**: Enforces 32+ character secrets in production environments
- **Refresh Token Hashing**: HMAC-SHA256 hashing for all stored refresh tokens
- **Error Message Sanitization**: Generic error messages in production to prevent information disclosure
- **Enhanced Joi-based validation middleware**: Input validation and sanitization
- **Input sanitization**: Protection against nested object attacks
- **Proper HTTP status codes**: Consistent error handling across all endpoints
- **Session Management**: Comprehensive session tracking and revocation

### Test Data

Tests use consistent fixtures:

```javascript
// Example test user
const testUser = {
  email: 'test@example.com',
  password: 'testpassword123',
  username: 'testuser'
};

// Example test figure
const testFigure = {
  name: 'Test Figure',
  manufacturer: 'Test Company',
  series: 'Test Series',
  scale: '1/8',
  price: 15000
};
```

### CI/CD Integration

```bash
# CI test command (no watch mode)
NODE_ENV=test npm test -- --watchAll=false

# Coverage for CI reporting
NODE_ENV=test npm test -- --coverage --watchAll=false
```

### CI on forks (shift-left)

Development happens on personal forks; pull requests go to `FigureCollecting/*`.
CI on a fork follows one rule. The push gate (its four cases are documented in
a comment block) sits at the top of `build.yml`, `security-scan.yml` and
`codeql.yml`; the publishing workflows (`docker-publish.yml`, `release.yml`,
`sbom-security-scan.yml`, `scheduled-security-scan.yml`) carry an org-only gate.

- **Feature branches on your fork run the core CI on every push**: unit tests +
  build, dependency/container/npm-audit scans (the container scan builds the
  production image) and CodeQL, so problems surface before the PR is opened.
  `docker-publish.yml` does not run there (it only publishes), and Dependabot
  branches (`dependabot/**`) get their CI from their pull request instead.
- **Set a fork secret `NODE_AUTH_TOKEN`** (repo Settings > Secrets and variables >
  Actions) to a classic GitHub PAT with **only** the `read:packages` scope, so
  `npm ci` can read the private `@figurecollecting/*` packages. Without it the
  install falls back to the fork's `GITHUB_TOKEN` and fails with `npm error 403`.
  Upstream needs no such secret. The secret reaches your own pushes and PRs from
  branches of your fork, never a PR opened from someone else's fork.
- **`develop` and `main` on your fork are mirrors of upstream: pushes to them
  run no jobs.** The workflows still trigger, so each sync leaves grey
  `skipped` runs in the Actions tab; that is the gate working, not a failure.
  Manual `workflow_dispatch` runs (`security-scan.yml`; `docker-publish.yml`, which
  then builds with `push: false`) are not gated and still run there, and so do
  scheduled runs if you enable schedules on the fork.
  The gate compares branch names case-insensitively, so do not name a feature
  branch `Develop` or `MAIN`.
- **Publishing (GHCR images, GitHub releases, image SBOM/attestations) and
  Codecov uploads happen only from the org**; those jobs and steps are skipped
  on forks.
