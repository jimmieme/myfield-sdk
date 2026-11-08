import { ClientError } from "../errors.ts";
import type { StorageAdapter } from "../bucket/store.ts";

/** Application-owned database and out-of-line key store for authorization records. @public */
export type AuthStorage = { database: IDBDatabase; store: string };

/** Explicit storage for cloneable identity, pending request and authorization records. @public */
export interface AuthorizationStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  add(key: string, value: unknown): Promise<boolean>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

/** Uses an existing IndexedDB store; no records are saved until explicitly requested. @public */
export function createAuthorizationStorage(options: AuthStorage): AuthorizationStorage {
  const { database, store } = options ?? {};
  if (!database || typeof database.transaction !== "function" || typeof store !== "string" || !store || !database.objectStoreNames.contains(store)) throw new ClientError("INVALID_INPUT", "Authorization store must already exist");
  function run<T>(mode: IDBTransactionMode, operation: (target: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode);
      const target = tx.objectStore(store);
      if (target.keyPath !== null) { tx.abort(); reject(new ClientError("INVALID_INPUT", "Authorization store must use out-of-line keys")); return; }
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Authorization transaction failed"));
      try { operation(target, value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    get: <T>(key: string) => run<T | null>("readonly", (target, done) => {
      const request = target.get(key); request.onsuccess = () => done(request.result ?? null);
    }),
    set: (key, value) => run<void>("readwrite", target => { target.put(value, key); }),
    add: (key, value) => run<boolean>("readwrite", (target, done) => {
      const request = target.add(value, key);
      request.onsuccess = () => done(true);
      request.onerror = event => {
        if (request.error?.name === "ConstraintError") { event.preventDefault(); event.stopPropagation(); done(false); }
      };
    }),
    remove: key => run<void>("readwrite", target => { target.delete(key); }),
    keys: prefix => run<string[]>("readonly", (target, done) => {
      const request = target.getAllKeys();
      request.onsuccess = () => done(request.result.filter((key): key is string => typeof key === "string" && key.startsWith(prefix)));
    }),
  };
}

export const createAuthStorage: (options: AuthStorage) => StorageAdapter = createAuthorizationStorage;
