import { jest } from '@jest/globals';

const store: Record<string, string> = {};

export function createClient() {
  return {
    get: jest.fn((key: string) => store[key]),
    set: jest.fn((key: string, value: string) => store[key] = value),
    del: jest.fn((key: string) => delete store[key]),
  };
}

export function clear() {
  Object.keys(store).forEach(key => delete store[key]);
}
