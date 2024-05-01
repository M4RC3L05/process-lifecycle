import {
  assertEquals,
  assertInstanceOf,
  describe,
  FakeTime,
  it,
  spy,
} from "./deps_test.ts";
import { ProcessLifecycle } from "./mod.ts";

describe("ProcessLifecycle", () => {
  describe("getService()", () => {
    it("should get the service once it has been booted", async () => {
      const pc = new ProcessLifecycle();

      pc.registerService({ name: "foo", boot: () => 1, shutdown: () => {} });

      assertEquals(pc.getService("foo"), undefined);

      await pc.boot();

      assertEquals(pc.getService("foo"), 1);
    });
  });

  it("should not run anything if we did not call boot", () => {
    const bootSpy = spy();
    const shutdownSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });

    assertEquals(bootSpy.calls.length, 0);
    assertEquals(shutdownSpy.calls.length, 0);
  });

  it("should return the same promise if boot is called multiple times", async () => {
    const eventSpy = spy();

    const pc = new ProcessLifecycle();
    pc.on("bootStarted", eventSpy);

    const b1 = pc.boot();
    const b2 = pc.boot();

    await Promise.all([b1, b2]);

    assertEquals(b1, b2);
    assertEquals(eventSpy.calls.length, 1);
  });

  it("should return the same promise if shutdown is called multiple times", async () => {
    const eventSpy = spy();

    const pc = new ProcessLifecycle();
    pc.on("shutdownStarted", eventSpy);

    const s1 = pc.shutdown();
    const s2 = pc.shutdown();

    await Promise.all([s1, s2]);

    assertEquals(s1, s2);
    assertEquals(eventSpy.calls.length, 1);
  });

  it("should not run anything if we did call boot without services registered", async () => {
    const bootSpy = spy();
    const shutdownSpy = spy();
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.on("bootStarted", eventSpy);
    pc.on("bootEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.boot();

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    assertEquals(bootSpy.calls.length, 0);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(eventSpy.calls.length, 2);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{}]);
  });

  it("should not run anything if we did not call boot, registered services and call shutdown", async () => {
    const pc = new ProcessLifecycle();

    const bootSpy = spy();
    const shutdownSpy = spy();
    const eventSpy = spy();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.shutdown();

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 0);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(eventSpy.calls.length, 2);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{}]);
  });

  it("should boot registered services in the order they where registered", async () => {
    const bootSpy = spy();
    const shutdownSpy = spy();
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({ name: "bar", boot: bootSpy, shutdown: shutdownSpy });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.boot();

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    assertEquals(bootSpy.calls.length, 2);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy.calls[1].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(eventSpy.calls.length, 6);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[4].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[5].args, [{}]);
  });

  it("should trigger a shutdown if any of the services fails to boot", async () => {
    const error = new Error("foo");
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() => {
      throw error;
    });
    const shutdownSpy = spy();
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({ name: "bar", boot: bootSpy2, shutdown: shutdownSpy });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.boot();

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 1);
    assertEquals(shutdownSpy.calls[0].args, [1]);
    assertEquals(eventSpy.calls.length, 10);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[4].args, [{ name: "bar", error }]);
    assertInstanceOf(eventSpy.calls[5].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[5].args[0].error.message,
      errors: eventSpy.calls[5].args[0].error.errors,
    }], [{ error: '"boot" terminated with errors', errors: [error] }]);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[8].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[9].args, [{}]);
  });

  it("should trigger a shutdown if any of the services timesout to boot", async () => {
    const fakeTimer = new FakeTime(0);
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 20_000);
      })
    );
    const shutdownSpy = spy();
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({
      name: "bar",
      boot: bootSpy2,
      shutdown: shutdownSpy,
      timeout: 100,
    });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    const bootP = pc.boot();

    await fakeTimer.tickAsync(1000);
    await bootP;

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(shutdownSpy.calls.length, 1);
    assertEquals(shutdownSpy.calls[0].args, [1]);
    assertEquals(eventSpy.calls.length, 10);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals([{
      name: eventSpy.calls[4].args[0].name,
      error: eventSpy.calls[4].args[0].error.message,
    }], [{ name: "bar", error: "Service boot timeout exceeded" }]);
    assertInstanceOf(eventSpy.calls[5].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[5].args[0].error.message,
      errors: eventSpy.calls[5].args[0].error.errors.map((error: Error) =>
        error.message
      ),
    }], [{
      error: '"boot" terminated with errors',
      errors: ["Service boot timeout exceeded"],
    }]);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[8].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[9].args, [{}]);
  });

  it("should trigger a shutdown if the global boot timeout is reached", async () => {
    const fakeTimer = new FakeTime(0);
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 20_000);
      })
    );
    const shutdownSpy = spy();
    const eventSpy = spy();

    const pc = new ProcessLifecycle({ bootTimeout: 5000 });

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({
      name: "bar",
      boot: bootSpy2,
      shutdown: shutdownSpy,
      timeout: 6000,
    });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    const bootP = pc.boot();

    await fakeTimer.tickAsync(5500);
    await bootP;

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(shutdownSpy.calls.length, 1);
    assertEquals(shutdownSpy.calls[0].args, [1]);
    assertEquals(eventSpy.calls.length, 10);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals([{
      name: eventSpy.calls[4].args[0].name,
      error: eventSpy.calls[4].args[0].error.message,
    }], [{ name: "bar", error: "Global timeout exceeded" }]);
    assertInstanceOf(eventSpy.calls[5].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[5].args[0].error.message,
      errors: eventSpy.calls[5].args[0].error.errors.map((error: Error) =>
        error.message
      ),
    }], [{
      error: '"boot" terminated with errors',
      errors: ["Global timeout exceeded"],
    }]);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[8].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[9].args, [{}]);
  });

  it("should shutdown the services in the reverse order they where registered", async () => {
    const error = new Error("foo");
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() => 2);
    const shutdownSpy = spy();
    const shutdownSpy2 = spy(() => {
      throw error;
    });
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({ name: "bar", boot: bootSpy2, shutdown: shutdownSpy2 });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.boot();

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(shutdownSpy2.calls.length, 0);
    assertEquals(eventSpy.calls.length, 6);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[4].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[5].args, [{}]);

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    await pc.shutdown();

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 1);
    assertEquals(shutdownSpy.calls[0].args, [1]);
    assertEquals(shutdownSpy2.calls.length, 1);
    assertEquals(shutdownSpy2.calls[0].args, [2]);
    assertEquals(eventSpy.calls.length, 12);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[8].args, [{ name: "bar", error }]);
    assertEquals(eventSpy.calls[9].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[10].args, [{ name: "foo" }]);
    assertInstanceOf(eventSpy.calls[11].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[11].args[0].error.message,
      errors: eventSpy.calls[11].args[0].error.errors,
    }], [{
      error: '"shutdown" terminated with errors',
      errors: [error],
    }]);
  });

  it("should shutdown the services if some of them timesout", async () => {
    const fakeTimer = new FakeTime(0);
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() => 2);
    const shutdownSpy = spy();
    const shutdownSpy2 = spy(() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 20_000);
      })
    );
    const eventSpy = spy();

    const pc = new ProcessLifecycle();

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({ name: "bar", boot: bootSpy2, shutdown: shutdownSpy2 });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    const bootP = pc.boot();

    await fakeTimer.tickAsync(1000);
    await bootP;

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(shutdownSpy2.calls.length, 0);
    assertEquals(eventSpy.calls.length, 6);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[4].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[5].args, [{}]);

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    const shutdownP = pc.shutdown();
    await fakeTimer.tickAsync(5500);
    await shutdownP;

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 1);
    assertEquals(shutdownSpy.calls[0].args, [1]);
    assertEquals(shutdownSpy2.calls.length, 1);
    assertEquals(shutdownSpy2.calls[0].args, [2]);
    assertEquals(eventSpy.calls.length, 12);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "bar" }]);
    assertEquals([{
      name: eventSpy.calls[8].args[0].name,
      error: eventSpy.calls[8].args[0].error.message,
    }], [{ name: "bar", error: "Service shutdown timeout exceeded" }]);
    assertEquals(eventSpy.calls[9].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[10].args, [{ name: "foo" }]);
    assertInstanceOf(eventSpy.calls[11].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[11].args[0].error.message,
      errors: eventSpy.calls[11].args[0].error.errors.map((error: Error) =>
        error.message
      ),
    }], [{
      error: '"shutdown" terminated with errors',
      errors: ["Service shutdown timeout exceeded"],
    }]);
  });

  it("should stop shutting down if the global shutdown timeout is reached", async () => {
    const fakeTimer = new FakeTime(0);
    const bootSpy = spy(() => 1);
    const bootSpy2 = spy(() => 2);
    const shutdownSpy = spy();
    const shutdownSpy2 = spy(() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 20_000);
      })
    );
    const eventSpy = spy();

    const pc = new ProcessLifecycle({ shutdownTimeout: 5000 });

    pc.registerService({ name: "foo", boot: bootSpy, shutdown: shutdownSpy });
    pc.registerService({
      name: "bar",
      boot: bootSpy2,
      shutdown: shutdownSpy2,
      timeout: 6000,
    });

    pc.on("bootStarted", eventSpy);
    pc.on("bootServiceStarted", eventSpy);
    pc.on("bootServiceEnded", eventSpy);
    pc.on("bootEnded", eventSpy);
    pc.on("shutdownStarted", eventSpy);
    pc.on("shutdownServiceStarted", eventSpy);
    pc.on("shutdownServiceEnded", eventSpy);
    pc.on("shutdownEnded", eventSpy);

    assertEquals(pc.booted, false);
    assertEquals(pc.signal.aborted, false);

    await pc.boot();

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(shutdownSpy2.calls.length, 0);
    assertEquals(eventSpy.calls.length, 6);
    assertEquals(eventSpy.calls[0].args, []);
    assertEquals(eventSpy.calls[1].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[2].args, [{ name: "foo" }]);
    assertEquals(eventSpy.calls[3].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[4].args, [{ name: "bar" }]);
    assertEquals(eventSpy.calls[5].args, [{}]);

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, false);

    const shutdownP = pc.shutdown();
    await fakeTimer.tickAsync(5500);
    await shutdownP;

    assertEquals(pc.booted, true);
    assertEquals(pc.signal.aborted, true);

    assertEquals(bootSpy.calls.length, 1);
    assertEquals(bootSpy.calls[0].args, [pc]);
    assertEquals(bootSpy2.calls.length, 1);
    assertEquals(bootSpy2.calls[0].args, [pc]);
    assertEquals(shutdownSpy.calls.length, 0);
    assertEquals(shutdownSpy2.calls.length, 1);
    assertEquals(shutdownSpy2.calls[0].args, [2]);
    assertEquals(eventSpy.calls.length, 10);
    assertEquals(eventSpy.calls[6].args, []);
    assertEquals(eventSpy.calls[7].args, [{ name: "bar" }]);
    assertEquals([{
      name: eventSpy.calls[8].args[0].name,
      error: eventSpy.calls[8].args[0].error.message,
    }], [{ name: "bar", error: "Global timeout exceeded" }]);
    assertInstanceOf(eventSpy.calls[9].args[0].error, AggregateError);
    assertEquals([{
      error: eventSpy.calls[9].args[0].error.message,
      errors: eventSpy.calls[9].args[0].error.errors.map((error: Error) =>
        error.message
      ),
    }], [{
      error: '"shutdown" terminated with errors',
      errors: ["Global timeout exceeded"],
    }]);
  });
});
