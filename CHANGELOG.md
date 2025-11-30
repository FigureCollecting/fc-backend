# Changelog

All notable changes to the fc-backend service will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2025-11-30

### Added
- **Dynamic Admin Config System**: New API for managing runtime configuration
  - `POST /admin/bootstrap` - Grant admin privileges using secret bootstrap token
  - `GET/PUT/DELETE /admin/config/:key` - Admin-only CRUD for system configs
  - `GET /config/:key` - Public endpoint for retrieving public configs
  - SystemConfig model supporting script, markdown, json, and text types
  - Key format validation (lowercase, alphanumeric with underscores)

### Security
- **Timing-Safe Token Comparison**: Bootstrap token validation uses `crypto.timingSafeEqual()` to prevent timing attacks

### Tests
- Added 32 comprehensive tests for admin routes (now 400 total tests)
- 100% line coverage on new admin controller code

---

## [2.1.1] - 2025-11-28

### Added
- **Codecov Configuration**: Added `codecov.yml` with 80% patch coverage threshold
  - Enforces code quality standards on new code
  - Configured project and patch coverage targets
- **Docker Image Verification**: Added scripts for safe Docker image verification
  - `scripts/verify-docker-image.sh` for validating container images
  - `scripts/safe-version-bump.sh` for controlled version management

### Changed
- **Security Scan Workflow**: Removed archived version-manager from scheduled security scans
  - Updated matrix strategy to only scan active services (fc-backend, fc-frontend, scraper)

### Security
- **CI/CD Improvements**: Enhanced build and security workflows
  - All security scans passing (CodeQL, Trivy, NPM Audit)
  - Container image scanning with vulnerability reporting

---

## [2.1.0] - 2025-11-27

### Added
- **Code Analysis Tools**: Replaced SonarCloud with CodeQL and Codecov
  - CodeQL for security vulnerability scanning
  - Codecov for coverage tracking and enforcement

---

## [2.0.0] - 2025-10-26

### Added
- Initial production release
- Express/TypeScript REST API
- MongoDB Atlas integration with Mongoose
- JWT authentication system
- Figure CRUD operations with Atlas Search
- Docker containerization
- GitHub Actions CI/CD pipeline
- Security vulnerability scanning

---

## Links

- [Repository](https://github.com/rpgoldberg/fc-backend)
- [Issues](https://github.com/rpgoldberg/fc-backend/issues)
- [Pull Requests](https://github.com/rpgoldberg/fc-backend/pulls)
