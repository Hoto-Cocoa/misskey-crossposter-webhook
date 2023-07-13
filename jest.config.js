/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['./jest.setup.ts'],
  setupFilesAfterEnv: ['./jest.setup.redis-mock.js'],
  moduleNameMapper: {
    '^(\\.\\.?\\/.+)\\.jsx?$': '$1'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.build/',
  ]
};
