// Dummy values so config/env.ts validation passes when unit tests import
// modules that transitively pull in env-dependent infrastructure code.
// Tests never actually connect to these services - repositories/clients
// are always faked/mocked.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'test-bucket';
process.env.S3_ACCESS_KEY_ID ??= 'test';
process.env.S3_SECRET_ACCESS_KEY ??= 'test';
process.env.S3_PUBLIC_URL ??= 'http://localhost:9000/test-bucket';
