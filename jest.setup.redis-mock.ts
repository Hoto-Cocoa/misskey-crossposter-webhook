import { jest } from '@jest/globals'
import * as Redis from './tests/_modules/redis.js';

jest.mock('redis', () => Redis);
