import axios from 'axios';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

export function isObject(item: any) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

export function mergeDeep<T extends Record<any, any>>(target: T, ...sources: T[]): T {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, ...sources);
}

export async function getUrlFileBuffer(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
  });

  return Buffer.from(response.data);
}

export function getHash(data: string | Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

export async function loadJsonAndAssign<T>(path: string, target: Partial<T> = {}): Promise<T> {
  return Object.assign({}, JSON.parse(Buffer.from(await readFile(path)).toString()) as T, target);
}
