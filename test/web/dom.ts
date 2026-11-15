// Type-aware lint reads this file outside tsconfig.json (it is in tsconfig.web.json), so it names its runner types.
/// <reference types="bun" />
/**
 * A browser DOM (happy-dom) for the web chat's component tests, present only while a web
 * test file runs.
 *
 * `bun test` runs every test file in one process, and a global `window` would make the
 * server-side suites — and the model SDKs they load — believe they run in a browser. So
 * the DOM is registered once, when this module is first evaluated, and then taken away
 * after each web test file and put back before the next ({@link useDom}). It is the same
 * window every time: custom elements registered by the A2UI renderer stay registered.
 */
import { afterAll, afterEach, beforeAll } from 'bun:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';

type Key = string | symbol;

function descriptors(): Map<Key, PropertyDescriptor> {
  const found = new Map<Key, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor !== undefined) {
      found.set(key, descriptor);
    }
  }
  return found;
}

const native = descriptors();
GlobalRegistrator.register({ url: 'http://localhost/' });
const withDom = descriptors();

/** The globals happy-dom added or replaced. */
const changed: Key[] = [...withDom.keys()].filter((key) => {
  const before = native.get(key);
  const after = withDom.get(key);
  const same = Object.is(before?.value, after?.value) && before?.get === after?.get;
  return !same && after?.configurable === true;
});

function apply(source: Map<Key, PropertyDescriptor>): void {
  for (const key of changed) {
    const descriptor = source.get(key);
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
    }
  }
}

/** Drops every loaded module whose path matches, so its next import evaluates it afresh. */
export function forgetModules(path: RegExp): void {
  // Bun keeps ES modules and CommonJS modules in the one registry `require.cache` shows.
  // oxlint-disable-next-line unicorn/prefer-module, import/no-commonjs -- the module registry has no ES-module spelling
  const registry = require.cache;
  for (const key of Object.keys(registry)) {
    if (path.test(key)) {
      Reflect.deleteProperty(registry, key);
    }
  }
}

/** Puts the DOM globals back. */
export function resumeDom(): void {
  apply(withDom);
}

/** Takes the DOM globals away, restoring what the runtime had. */
export function suspendDom(): void {
  apply(native);
}

/**
 * Call once at the top of a web test file: the DOM is there for the file's tests and gone
 * afterwards, and `cleanup` unmounts what each test rendered.
 */
export function useDom(cleanup: () => void): void {
  beforeAll(resumeDom);
  afterEach(cleanup);
  afterAll(suspendDom);
}
