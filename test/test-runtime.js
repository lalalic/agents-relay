import nodeTest from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Reconciler } from '../dist/reconciler.js';
import { serveDashboard } from '../dist/dashboard.js';

const runtimeStorage = new AsyncLocalStorage();

class TestRuntime {
  #disposers = [];
  #disposed = false;

  defer(disposer) {
    let done = false;
    const once = async () => {
      if (done) return;
      done = true;
      await disposer();
    };
    this.#disposers.push(once);
    return once;
  }

  reconciler(store, options) {
    const reconciler = new Reconciler(store, options);
    this.defer(() => reconciler.close());
    return new Proxy(reconciler, {
      get: (target, property, receiver) => {
        if (property !== 'watch') return Reflect.get(target, property, receiver);
        return async (...args) => {
          const stop = await target.watch(...args);
          return this.defer(stop);
        };
      },
    });
  }

  dashboard(...args) {
    const server = serveDashboard(...args);
    this.defer(async () => {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return server;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors = [];
    for (const dispose of this.#disposers.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    this.#disposers = [];
    if (errors.length) throw new AggregateError(errors, 'Test runtime cleanup failed');
  }
}

function currentRuntime() {
  const runtime = runtimeStorage.getStore();
  if (!runtime) throw new Error('Managed test resource created outside the test runtime');
  return runtime;
}

function wrapCallback(callback) {
  return async (...args) => {
    const runtime = new TestRuntime();
    return await runtimeStorage.run(runtime, async () => {
      try {
        return await callback(...args);
      } finally {
        await runtime.dispose();
      }
    });
  };
}

function test(...args) {
  const callbackIndex = args.findLastIndex(value => typeof value === 'function');
  if (callbackIndex >= 0) args[callbackIndex] = wrapCallback(args[callbackIndex]);
  return nodeTest(...args);
}

export function managedReconciler(store, options) {
  return currentRuntime().reconciler(store, options);
}

export function managedDashboard(...args) {
  return currentRuntime().dashboard(...args);
}

export default test;
