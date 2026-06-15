# Backend Unit Test Plan

## Goal
Unit tests cover pure helpers, validation rules, and small utilities that do not require a live database.

## Unit Targets

### Middleware and Validation
| Item | Test focus | Notes |
|---|---|---|
| middleware/auth.js (protect, requireDriver, requireAdmin, requireManager, requireSuperAdmin) | role matrix and token parsing | Prefer integration for full behavior, but keep unit checks for role filtering and error branches |
| middleware/validators.js | validation rules per endpoint | Validate required fields, type errors, and boundary conditions |
| middleware/errorHandler.js | error formatting | Ensure consistent message and status shaping |

### Utilities
| Item | Test focus | Notes |
|---|---|---|
| utils/ensureSuperAdminAccount.js | idempotent creation logic | Use mocked DB layer |
| utils/* (any pure helpers) | deterministic outputs | Include invalid input handling |

### Socket Helpers
| Item | Test focus | Notes |
|---|---|---|
| socket/socketHandler.js helpers | payload shaping, event routing | Use unit tests for pure transforms only |

## Required Edge Cases
- empty string vs null vs undefined
- invalid IDs
- role mismatch
- missing or malformed tokens
- boundary values (0, negative, large numbers)
