type ProcessLifecycleOptions = {
  shutdownTimeout?: number;
  bootTimeout?: number;
};

// deno-lint-ignore no-explicit-any
type ServiceRegistration<BR = any> = {
  name: string;
  boot:
    | ((hd: ProcessLifecycle) => Promise<BR>)
    | ((hd: ProcessLifecycle) => BR);
  shutdown: ((data: BR) => Promise<void>) | ((data: BR) => void);
  timeout?: number;
};

const wrapInPromise = (
  // deno-lint-ignore no-explicit-any
  fn: ((...args: any[]) => Promise<void>) | ((...args: any[]) => void),
) => {
  // deno-lint-ignore no-explicit-any
  return (...args: any[]) =>
    new Promise((resolve, reject) => {
      try {
        const result = fn(...args);

        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      } catch (error) {
        reject(error);
      }
    });
};

export class GlobalTimeoutExceededError extends Error {}

type ProcessLifecycleEvents = {
  bootStarted: () => void;
  // deno-lint-ignore no-explicit-any
  bootEnded: (result: { error?: any }) => void;
  shutdownStarted: () => void;
  // deno-lint-ignore no-explicit-any
  shutdownEnded: (result: { error?: any }) => void;
  bootServiceStarted: (service: Pick<ServiceRegistration, "name">) => void;
  bootServiceEnded: (
    // deno-lint-ignore no-explicit-any
    service: Pick<ServiceRegistration, "name"> & { error?: any },
  ) => void;
  shutdownServiceStarted: (service: Pick<ServiceRegistration, "name">) => void;
  shutdownServiceEnded: (
    // deno-lint-ignore no-explicit-any
    service: Pick<ServiceRegistration, "name"> & { error?: any },
  ) => void;
};

type ProcessLifecycleEventsKeys = keyof ProcessLifecycleEvents;

const bootProcessSymbol = Symbol("bootProcessSymbol");
const shutdownProcessSymbol = Symbol("shutdownProcessSymbol");

const timeout = (
  ms: number,
  fn: (x: () => void) => void,
) =>
  new Promise<void>((resolve) => {
    const i = setTimeout(resolve, ms);

    fn(() => {
      clearTimeout(i);
      resolve();
    });

    Deno.unrefTimer(i);
  });

export class ProcessLifecycle {
  #abortController = new AbortController();
  #serviceRegistrationsStaged: Required<ServiceRegistration>[] = [];
  #serviceRegistrations: Required<ServiceRegistration>[] = [];
  #services = new Map<string, unknown>();
  #options: Required<ProcessLifecycleOptions>;
  #booted = false;
  #eventsHandlers = new Map<
    ProcessLifecycleEventsKeys,
    ProcessLifecycleEvents[ProcessLifecycleEventsKeys]
  >();

  [bootProcessSymbol]?: Promise<void>;
  [shutdownProcessSymbol]?: Promise<void>;

  constructor(options?: ProcessLifecycleOptions) {
    this.#options = {
      bootTimeout: 15_000,
      shutdownTimeout: 15_000,
      ...(options ?? {}),
    };
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get booted(): boolean {
    return this.#booted;
  }

  on<KE extends ProcessLifecycleEventsKeys>(
    event: KE,
    fn: ProcessLifecycleEvents[KE],
  ) {
    this.#eventsHandlers.set(event, fn);
  }

  getService<R>(name: string): R {
    return this.#services.get(name) as R;
  }

  registerService<BR>(serviceRegistration: ServiceRegistration<BR>) {
    if (this.#abortController.signal.aborted) return;

    this.#serviceRegistrationsStaged.push({
      ...serviceRegistration,
      boot: wrapInPromise(serviceRegistration.boot),
      shutdown: wrapInPromise(serviceRegistration.shutdown),
      timeout: serviceRegistration.timeout ?? 5_000,
    });
  }

  boot = (): Promise<void> => {
    if (!this[bootProcessSymbol]) {
      this[bootProcessSymbol] = this.#executeLifecycle("boot");
    }

    return this[bootProcessSymbol];
  };

  shutdown = (): Promise<void> => {
    if (!this[shutdownProcessSymbol]) {
      this[shutdownProcessSymbol] = this.#executeLifecycle("shutdown");
    }

    return this[shutdownProcessSymbol];
  };

  #getHandler<KE extends ProcessLifecycleEventsKeys>(
    event: KE,
  ) {
    return this.#eventsHandlers.get(event) as
      | ProcessLifecycleEvents[KE]
      | undefined;
  }

  async #executeLifecycle(mode: "boot" | "shutdown"): Promise<void> {
    const timeouts: (() => void)[] = [];
    const serviceRegistrations = mode === "shutdown"
      ? this.#serviceRegistrations.toReversed()
      : this.#serviceRegistrationsStaged;
    const globalDelay = mode === "shutdown"
      ? this.#options.shutdownTimeout
      : this.#options.bootTimeout;
    const globalTimeout = timeout(globalDelay, (x) => timeouts.push(x))
      .then(() => "global-timeout");

    if (mode === "shutdown") {
      this.#abortController.abort();
    }

    try {
      this.#getHandler(`${mode}Started`)?.();

      for (const serviceRegistration of serviceRegistrations) {
        this.#getHandler(`${mode}ServiceStarted`)?.({
          name: serviceRegistration.name,
        });

        try {
          const response = await Promise.race([
            mode === "shutdown"
              ? serviceRegistration.shutdown(
                this.#services.get(serviceRegistration.name),
              )
              : serviceRegistration.boot(this),
            timeout(
              serviceRegistration.timeout,
              (x) => timeouts.push(x),
            ).then(() => "timeout"),
            globalTimeout,
          ]);

          if (response === "timeout") {
            throw new Error("Service boot timeout exceeded");
          }

          if (response === "global-timeout") {
            throw new GlobalTimeoutExceededError("Global timeout exceeded");
          }

          if (mode === "shutdown") {
            this.#services.delete(serviceRegistration.name);
          } else {
            this.#serviceRegistrations.push(serviceRegistration);
            this.#services.set(serviceRegistration.name, response);
          }

          this.#getHandler(`${mode}ServiceEnded`)?.({
            name: serviceRegistration.name,
          });
        } catch (error) {
          this.#getHandler(`${mode}ServiceEnded`)?.({
            name: serviceRegistration.name,
            error,
          });

          if (mode === "boot" || error instanceof GlobalTimeoutExceededError) {
            throw error;
          }
        }
      }

      // Cancel all timeouts queued.
      timeouts.forEach((fn) => fn());

      this.#booted = mode === "boot";

      this.#getHandler(`${mode}Ended`)?.({});
    } catch (error) {
      // Cancel all timeouts queued.
      timeouts.forEach((fn) => fn());

      this.#getHandler(`${mode}Ended`)?.({ error });

      if (mode === "boot") {
        return this.#executeLifecycle("shutdown");
      }
    }
  }
}
