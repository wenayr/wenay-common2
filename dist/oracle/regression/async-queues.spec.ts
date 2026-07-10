import {
    createAsyncQueue,
    createReadyGate,
    createThrottle,
    enhancedQueueRun,
} from "../../src/Common/async/waitRun";
import {promiseProgress} from "../../src/Common/async/promiseProgress";

type Test = {
    name: string;
    fn: () => void | Promise<void>;
};

const tests: Test[] = [];

function test(name: string, fn: Test["fn"]) {
    tests.push({name, fn});
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

async function assertRejects(promise: Promise<unknown>, expected: unknown, message: string) {
    try {
        await promise;
    } catch (error) {
        assert(error === expected, message);
        return;
    }
    throw new Error(`${message}: promise resolved`);
}

function assertThrows(fn: () => unknown, message: string) {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error(`${message}: function did not throw`);
}

function sleep(ms = 0) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

test("createAsyncQueue rejects concurrency 0", () => {
    assertThrows(() => createAsyncQueue(0), "concurrency 0 throws");
});

test("createAsyncQueue resolves, rejects, limits concurrency, and onIdle waits", async () => {
    const queue = createAsyncQueue(2);
    const failure = new Error("queue failure");
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const makeTask = (name: string, ms: number, value: string, reject = false) => async () => {
        events.push(`start:${name}`);
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(ms);
        active--;
        events.push(`end:${name}`);
        if (reject) throw failure;
        return value;
    };

    const first = queue.add(makeTask("first", 8, "one"));
    const second = queue.add(makeTask("second", 3, "two", true));
    const third = queue.add(makeTask("third", 1, "three"));
    const secondRejected = assertRejects(second, failure, "rejected task rejects add promise");

    assertEq(queue.size, 1, "third task is queued while first two are active");
    assertEq(await first, "one", "resolved task returns its value");
    await secondRejected;
    assertEq(await third, "three", "queue continues after rejected task");
    await queue.onIdle();

    assertEq(queue.size, 0, "queue is empty after onIdle");
    assertEq(active, 0, "no tasks remain active after onIdle");
    assert(maxActive <= 2, "queue never exceeds configured concurrency");
    assert(events.includes("start:third"), "queued task eventually starts");
});

test("createThrottle survives rejected throttled task", async () => {
    const throttle = createThrottle();
    const events: string[] = [];

    throttle.throttle(0, async () => {
        events.push("first");
        throw new Error("ignored");
    });

    await sleep(5);

    throttle.throttle(0, async () => {
        events.push("second");
    });

    await sleep(5);
    assertEq(events.join(","), "first,second", "throttle runs after a rejected task");
});

test("enhancedQueueRun keeps draining after rejected tasks", async () => {
    const queue = enhancedQueueRun(1);
    const failure = new Error("enhanced failure");
    const events: string[] = [];

    queue.enqueue(async () => {
        events.push("fire-and-forget reject");
        throw failure;
    });
    queue.enqueue(async () => {
        events.push("after fire-and-forget");
    });

    await queue.runAll();

    await assertRejects(
        queue.enqueueAndRun(async () => {
            events.push("reported reject");
            throw failure;
        }),
        failure,
        "enqueueAndRun reports task rejection",
    );

    await queue.enqueueAndRun(async () => {
        events.push("after reported reject");
    });
    await queue.runAll();

    assertEq(
        events.join(","),
        "fire-and-forget reject,after fire-and-forget,reported reject,after reported reject",
        "enhancedQueueRun continues after both swallowed and reported rejections",
    );
    assertEq(queue.queueSize, 0, "enhancedQueueRun queue is empty after runAll");
});

test("promiseProgress all returns values and emits ok events", async () => {
    const listened = promiseProgress<string>([
        () => Promise.resolve("alpha"),
        async () => {
            await sleep(1);
            return "beta";
        },
    ]);
    const okEvents: string[] = [];
    const errorEvents: string[] = [];

    listened.onOk((data, i, ok, errors, count) => {
        okEvents.push(`${i}:${data}:${ok}:${errors}:${count}`);
    });
    listened.onError(error => {
        errorEvents.push(String(error));
    });

    const values = await listened.all();

    assertEq(values.join(","), "alpha,beta", "promiseProgress all resolves values in input order");
    assertEq(okEvents.join("|"), "0:alpha:1:0:2|1:beta:2:0:2", "ok events fire with counts");
    assertEq(errorEvents.length, 0, "no error events fire for successful all");
    assertEq(listened.stats().ok, 2, "status tracks ok count");
});

test("promiseProgress all rejects on errors while events fire", async () => {
    const failure = new Error("listen failure");
    const listened = promiseProgress<string>([
        () => Promise.resolve("alpha"),
        () => Promise.reject(failure),
        async () => {
            await sleep(1);
            return "gamma";
        },
    ]);
    const okEvents: string[] = [];
    const errorEvents: string[] = [];

    listened.onOk((data, i, ok, errors, count) => {
        okEvents.push(`${i}:${data}:${ok}:${errors}:${count}`);
    });
    listened.onError((error, i, ok, errors, count) => {
        errorEvents.push(`${i}:${error === failure}:${ok}:${errors}:${count}`);
    });

    await assertRejects(listened.all(), failure, "promiseProgress all rejects with task error");
    await Promise.allSettled(listened.items());

    assertEq(errorEvents.join("|"), "1:true:1:1:3", "error event fires with counts");
    assertEq(okEvents.join("|"), "0:alpha:1:0:3|2:gamma:2:1:3", "ok events still fire around rejection");
    assertEq(listened.stats().error, 1, "status tracks error count");
    assertEq(listened.stats().ok, 2, "status tracks successful count after rejection");
});

test("ReadyGate continues after thrown task and clears queued tasks", async () => {
    const gate = createReadyGate();
    const failure = new Error("ready failure");
    const events: string[] = [];

    gate.add(() => {
        events.push("first");
        throw failure;
    });
    gate.add(async () => {
        await sleep(1);
        events.push("second");
    });

    assertEq(gate.tasks().length, 2, "gate stores tasks before ready");
    await assertRejects(gate.ready(), failure, "ready reports first thrown task");

    assertEq(events.join(","), "first,second", "ready continues after thrown task");
    assertEq(gate.tasks().length, 0, "ready clears queued tasks");
    assert(gate.isReady(), "gate remains ready after thrown task");

    gate.add(() => {
        events.push("after-ready");
    });
    assertEq(events.join(","), "first,second,after-ready", "tasks added after ready run immediately");
});

async function main() {
    let failed = 0;

    for (const {name, fn} of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }

    if (failed > 0) {
        throw new Error(`${failed} async queue regression test(s) failed`);
    }

    console.log(`${tests.length} async queue regression tests passed`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
