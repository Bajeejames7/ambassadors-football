import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ambassadors_test",
      CREATOR_EMAIL: "creator@test.org",
      TOKEN_SECRET: "test-secret",
      MPESA_MODE: "mock",
      MPESA_MOCK_DELAY_MS: "50",
      MPESA_CALLBACK_SECRET: "cb-secret-123",
    },
  },
});
