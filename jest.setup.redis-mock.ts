import { jest } from '@jest/globals'

jest.mock('redis', () => jest.requireActual('redis-mock'));
