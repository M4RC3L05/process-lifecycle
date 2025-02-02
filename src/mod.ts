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

const wrapExecutor = (
  // deno-lint-ignore no-explicit-any
  fn: ((...args: any[]) => Promise<void>) | ((...args: any[]) => void),
) => {
  // deno-lint-ignore no-explicit-any
  return async (...args: any[]) => {
    const result = fn(...args);

    if (result instanceof Promise) {
      return await result;
    }

    return result;
  };
};

const wrapIgnoreErrorsExecuter = (
  // deno-lint-ignore no-explicit-any
  fn: ((...args: any[]) => Promise<void>) | ((...args: any[]) => void),
) => {
  const wrapped = wrapExecutor(fn);

  // deno-lint-ignore no-explicit-any
  return async (...args: any[]) => {
    try {
      await wrapped(...args);
    } catch {
      //
    }
  };
};

export class GlobalTimeoutExceededError extends Error {
  constructor(timeout: number) {
    super("Global timeout exceeded", { cause: { timeout } });
  }
}

export class ServiceTimeoutExceededError extends Error {
  constructor(serviceName: string, mode: "boot" | "shutdown", timeout: number) {
    super(`Service "${serviceName}" ${mode} timeout exceeded`, {
      cause: { timeout },
    });
  }
}

export class ServiceLifecycleError extends Error {
  constructor(serviceName: string, mode: "boot" | "shutdown", cause?: unknown) {
    super(`Service "${serviceName}" ${mode} error`, {
      cause,
    });
  }
}

export class ProcessLifecicleAggregateError extends AggregateError {
  constructor(mode: "boot" | "shutdown", errors: Iterable<unknown>) {
    super(errors, `Process lifecycle "${mode}" terminated with errors`);
  }
}

class DisposableSet<T> extends Set<T> {
  [Symbol.dispose]() {
    this.clear();
  }
}

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

const timeout = <T>(
  ms: number,
  resolveWith: T,
) => {
  const { promise, resolve } = Promise.withResolvers();

  const timeoutId = setTimeout(() => resolve(resolveWith), ms);

  return {
    promise,
    [Symbol.dispose]: () => {
      clearTimeout(timeoutId);
      resolve(resolveWith);
    },
  };
};

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
    this.#eventsHandlers.set(event, wrapIgnoreErrorsExecuter(fn));
  }

  getService<R>(name: string): R {
    return this.#services.get(name) as R;
  }

  registerService<BR>(serviceRegistration: ServiceRegistration<BR>) {
    if (this.#abortController.signal.aborted) return;

    this.#serviceRegistrationsStaged.push({
      ...serviceRegistration,
      boot: wrapExecutor(serviceRegistration.boot),
      shutdown: wrapExecutor(serviceRegistration.shutdown),
      timeout: serviceRegistration.timeout ?? 5_000,
    });
  }

  boot = (): Promise<void> => {
    if (!this[bootProcessSymbol]) {
      this[bootProcessSymbol] = this.#executeLifecycle(
        "boot",
        [...this.#serviceRegistrationsStaged],
        this.#options.bootTimeout,
      );
    }

    return this[bootProcessSymbol];
  };

  shutdown = (): Promise<void> => {
    if (!this[shutdownProcessSymbol]) {
      this[shutdownProcessSymbol] = this.#executeLifecycle(
        "shutdown",
        this.#serviceRegistrations.toReversed(),
        this.#options.shutdownTimeout,
      );
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

  async #executeLifecycle(
    mode: "boot" | "shutdown",
    serviceRegistrations: Required<ServiceRegistration>[],
    globalDelay: number,
  ): Promise<void> {
    using errors = new DisposableSet<Error>();
    using globalTimeout = timeout(
      globalDelay,
      new GlobalTimeoutExceededError(globalDelay),
    );

    if (mode === "shutdown") {
      this.#abortController.abort();
    }

    try {
      this.#getHandler(`${mode}Started`)?.();

      for (const serviceRegistration of serviceRegistrations) {
        this.#getHandler(`${mode}ServiceStarted`)?.({
          name: serviceRegistration.name,
        });

        using serviceRegistrationTimeout = timeout(
          serviceRegistration.timeout,
          new ServiceTimeoutExceededError(
            serviceRegistration.name,
            mode,
            serviceRegistration.timeout,
          ),
        );

        try {
          const executed = mode === "shutdown"
            ? serviceRegistration.shutdown(
              this.#services.get(serviceRegistration.name),
            )
            : serviceRegistration.boot(this);

          const response = await Promise.race([
            executed,
            serviceRegistrationTimeout.promise,
            globalTimeout.promise,
          ]);

          if (response instanceof Error) {
            throw response;
          }

          if (mode === "shutdown") {
            this.#services.delete(serviceRegistration.name);
          } else {
            // Add booted service to the service registrations so we can shut it down on shutdown.
            this.#serviceRegistrations.push(serviceRegistration);
            // Store result to be available on other service registrations on boot.
            this.#services.set(serviceRegistration.name, response);
          }

          this.#getHandler(`${mode}ServiceEnded`)?.({
            name: serviceRegistration.name,
          });
        } catch (error) {
          const mappedError = new ServiceLifecycleError(
            serviceRegistration.name,
            mode,
            error,
          );

          this.#getHandler(`${mode}ServiceEnded`)?.({
            name: serviceRegistration.name,
            error: mappedError,
          });

          errors.add(mappedError);

          // If the mode is boot we want to abort the services handling
          // The consumer should force exit in this cases if on shutdown mode.
          if (mode === "boot" || error instanceof GlobalTimeoutExceededError) {
            throw mappedError;
          }
        }
      }

      this.#booted = mode === "boot";

      const payload: { error?: Error } = {};

      if (errors.size > 0) {
        payload.error = new ProcessLifecicleAggregateError(mode, errors);
      }

      this.#getHandler(`${mode}Ended`)?.(payload);
    } catch (error) {
      this.#booted = false;

      errors.add(error as Error);

      this.#getHandler(`${mode}Ended`)?.({
        error: new ProcessLifecicleAggregateError(mode, errors),
      });

      // If there was an error while booting we shutdown.
      if (mode === "boot") {
        return this.shutdown();
      }
    }

    // Remove event handlers after shutdown ended.
    // It must be contructed a new instace to be able to boot again and register new listeners.
    if (mode === "shutdown") {
      this.#eventsHandlers.clear();
      this.#serviceRegistrationsStaged = [];
      this.#serviceRegistrations = [];
      this.#services.clear();
    }

    if (mode === "boot") {
      this.#serviceRegistrationsStaged = [];
    }
  }
}
