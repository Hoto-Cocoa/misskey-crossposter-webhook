import { JestConfigWithTsJest } from 'ts-jest';

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['./jest.setup.ts'],
  setupFilesAfterEnv: ['./jest.setup.redis-mock.ts'],
  moduleNameMapper: {
    '^(\\.\\.?\\/.+)\\.jsx?$': '$1'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.build/',
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        isolatedModules: true,
      },
    ],
  },
  silent: true,
  detectOpenHandles: true,
  verbose: true,
  collectCoverage: true,
  coverageReporters: [
    "text",
    "cobertura"
  ]
} as JestConfigWithTsJest;
