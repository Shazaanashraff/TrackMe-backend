# ADR 001: Separate parent authentication from student rider identity

Date: 2026-08-13  
Status: superseded by repository ADR 002 (neutral rider identity)

## Context

The previous prototype treated a rider-like profile as the authenticated user and attempted to switch profiles by issuing another token. That couples login state to a child, makes siblings difficult to model, and risks returning cached shuttle data for the wrong person.

## Decision

Keep one stable account session and model each person as an owned rider profile. The original `StudentProfile` name was corrected by ADR 002 because service-specific roles cannot be known before enrollment.

## Consequences

- One phone, Gmail account, and login supports any number of students.
- Each student retains independent rider IDs, assignments, tracking, attendance, and alerts.
- Query keys must contain `studentId`; switching selection does not require clearing the entire cache.
- Existing users receive one migrated student automatically and see no extra selection step.
- APIs perform ownership checks at every student boundary.
