const fs = require('fs');

import { PublicKey, KeyAddress } from 'unicrypto';

export type Primitive = string | number | Date | null | undefined;
export type Dict = { [key: string]: Primitive | Dict };

export interface RetryOptions {
  attempts?: number,
  interval?: number,
  exponential?: boolean,
  onError?: any
};

export async function retry(fn: any, options?: RetryOptions): Promise<any> {
  const opts = options || {};
  let attempts = 5;
  if (typeof opts.attempts === 'number') attempts = opts.attempts;

  const interval = opts.interval || 1000;
  const exponential = opts.exponential || false;
  const onError = opts.onError;

  try {
    const val = await fn();

    return val;
  } catch (error) {
    if (error instanceof Canceled) throw error;
    if (onError) onError(error);

    if (attempts) {
      await new Promise(r => setTimeout(r, interval));

      return retry(fn, {
        attempts: attempts - 1,
        interval: exponential ? interval * 2 : interval,
        exponential,
        onError
      });
    } else throw new Error('Maximum attempts reached');
  }
}

export function abortable(responsePromise: Promise<any>, request: any) {
  return cancelable(responsePromise, () => {
    const activeRequest = typeof request === 'function' ? request() : request;
    if (typeof activeRequest?.cancel === 'function') activeRequest.cancel();
    else if (typeof activeRequest?.abort === 'function') activeRequest.abort();
  });
}

export class Canceled extends Error {
  constructor(reason: string = "") {
    super(reason);
    Object.setPrototypeOf(this, Canceled.prototype);
  }
}

export interface Cancelable<T> extends Promise<T> {
  cancel(): Cancelable<T>;
}

function cancelable<T>(
  promise: Promise<T>,
  onCancel?: () => void
): Cancelable<T> {
  let cancel: (() => Cancelable<T>) | null = null;
  let cancelable: Cancelable<T>;
  cancelable = <Cancelable<T>>new Promise((resolve, reject) => {
    cancel = () => {
      try { if (onCancel) onCancel(); }
      catch (e) { reject(e); }

      reject(new Canceled());

      return cancelable;
    };

    promise.then(resolve, reject);
  });

  if (cancel) cancelable.cancel = cancel;

  return cancelable;
}

export function readJSON(path: string) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, (err: Error, data: string) => {
      if (err) reject(err);
      else resolve(JSON.parse(data));
    });
  });
}

export function isSuperset(set: Set<string>, subset: Set<string>) {
  // FIXME: Set is not defined properly in TS
  for (var elem of Array.from(subset.values())) {
    if (!set.has(elem)) {
        return false;
    }
  }

  return true;
}

export function createAddressSet(
  keys: Array<PublicKey> = [],
  addresses: Array<KeyAddress> = []
) {
  const addrs: Set<string> = new Set();

  keys.forEach(key => {
    addrs.add(key.shortAddress.base58);
    addrs.add(key.longAddress.base58);
  });

  addresses.forEach(addr => addrs.add(addr.base58));

  return addrs;
}

export function omitBOSS(serialized: any, fields: Array<string>) {
  if (typeof serialized !== "object" || !serialized) return serialized;

  const cleaned = Object.assign({}, serialized);
  delete cleaned['__t'];
  delete cleaned['__type'];

  fields.forEach(field => delete cleaned[field]);

  return cleaned;
}
