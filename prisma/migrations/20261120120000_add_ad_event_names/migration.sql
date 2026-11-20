-- Events reported by Opus (an account created by a family or by a teacher) and by the trial
-- page (a callback request). Adding several values in one migration needs PostgreSQL 12 or later.
ALTER TYPE "CanonicalEventName" ADD VALUE 'ACCOUNT_CREATED';
ALTER TYPE "CanonicalEventName" ADD VALUE 'TEACHER_ACCOUNT_CREATED';
ALTER TYPE "CanonicalEventName" ADD VALUE 'CALLBACK_REQUESTED';
