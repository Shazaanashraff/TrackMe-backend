# ADR 001: Separate parent authentication from student rider identity

Date: 2026-08-13  
Status: accepted

## Context

The previous prototype treated a rider-like profile as the authenticated user and attempted to switch profiles by issuing another token. That couples login state to a child, makes siblings difficult to model, and risks returning cached shuttle data for the wrong person.

## Decision

Keep one stable parent/guardian session and model each child or employee as an owned `StudentProfile`. Scope queries, QR passes, enrollments, attendance, tracking rooms, and notifications by an explicitly selected student ID.

## Consequences

- One phone, Gmail account, and login supports any number of students.
- Each student retains independent rider IDs, assignments, tracking, attendance, and alerts.
- Query keys must contain `studentId`; switching selection does not require clearing the entire cache.
- Existing users receive one migrated student automatically and see no extra selection step.
- APIs perform ownership checks at every student boundary.
