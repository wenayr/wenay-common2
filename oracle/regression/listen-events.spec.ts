import {listen as createListenPair} from "../../src/Common/events/Listen";
import {CObjectEventsArr, CObjectEventsList, tListEvent} from "../../src/Common/events/event";

type Test = {
    name: string;
    fn: () => void;
};

const tests: Test[] = [];

function test(name: string, fn: () => void) {
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

test("duplicate same callback has independent off handles", () => {
    const [emit, listen] = createListenPair<[number]>();
    let sum = 0;
    const cb = (value: number) => {
        sum += value;
    };

    const off1 = listen.on(cb);
    const off2 = listen.on(cb);

    assertEq(listen.count(), 2, "same callback can be registered twice");
    emit(2);
    assertEq(sum, 4, "both duplicate subscriptions receive events");

    off1();
    assertEq(listen.count(), 1, "first off removes only one duplicate subscription");
    emit(3);
    assertEq(sum, 7, "second duplicate remains active after first off");

    off2();
    assertEq(listen.count(), 0, "second off removes remaining duplicate subscription");
    emit(5);
    assertEq(sum, 7, "no duplicate subscriptions remain active");
});

test("keyed overwrite cleans previous cbClose registration", () => {
    const [emit, listen] = createListenPair<[string]>();
    const calls: string[] = [];
    let oldClosed = 0;
    let newClosed = 0;

    listen.on(value => calls.push(`old:${value}`), {
        key: "slot",
        cbClose: () => oldClosed++,
    });
    listen.on(value => calls.push(`new:${value}`), {
        key: "slot",
        cbClose: () => newClosed++,
    });

    assertEq(listen.count(), 1, "key overwrite keeps one subscription");
    emit("event");
    assertEq(calls.join(","), "new:event", "key overwrite replaces callback");

    listen.close();

    assertEq(oldClosed, 0, "overwritten cbClose is removed from close registry");
    assertEq(newClosed, 1, "current keyed cbClose runs on close");
});

test("off(cb) removes all entries for the callback", () => {
    const [emit, listen] = createListenPair<[number]>();
    let removedCallbackCalls = 0;
    let otherCallbackCalls = 0;
    const cb = () => {
        removedCallbackCalls++;
    };

    listen.on(cb);
    listen.on(cb);
    listen.on(() => {
        otherCallbackCalls++;
    });

    assertEq(listen.count(), 3, "initial subscriptions are registered");
    listen.off(cb);
    assertEq(listen.count(), 1, "off(cb) removes every subscription for cb");

    emit(1);
    assertEq(removedCallbackCalls, 0, "removed callback is not called");
    assertEq(otherCallbackCalls, 1, "unrelated callback remains active");
});

test("close handlers support off and close clears listeners", () => {
    const [emit, listen] = createListenPair<[void]>();
    let listenerCalls = 0;
    let closeOffCalls = 0;
    let onCloseCalls = 0;
    let cbCloseCalls = 0;

    const offListener = listen.on(() => {
        listenerCalls++;
    }, {
        cbClose: () => cbCloseCalls++,
    });
    const offEventClose = listen.onClose(() => {
        closeOffCalls++;
    });
    listen.onClose(() => {
        onCloseCalls++;
    });

    offEventClose();
    listen.close();

    assertEq(listenerCalls, 0, "close does not emit regular listeners");
    assertEq(cbCloseCalls, 1, "per-subscription cbClose runs on close");
    assertEq(closeOffCalls, 0, "onClose off prevents close callback");
    assertEq(onCloseCalls, 1, "onClose callback runs on close");
    assertEq(listen.count(), 0, "close clears regular listeners");

    offListener();
    emit();
    assertEq(listenerCalls, 0, "off after close remains harmless");
});

test("once unsubscribes after first event and supports early off", () => {
    const [emit, listen] = createListenPair<[number]>();
    let onceCalls = 0;
    let earlyOffCalls = 0;

    listen.once(value => {
        onceCalls += value;
    });
    emit(2);
    emit(3);

    assertEq(onceCalls, 2, "once callback receives only the first event");
    assertEq(listen.count(), 0, "once subscription removes itself after firing");

    const off = listen.once(() => {
        earlyOffCalls++;
    });
    off();
    emit(4);

    assertEq(earlyOffCalls, 0, "off returned from once removes subscription before event");
    assertEq(listen.count(), 0, "early once off leaves no subscriptions");
});

test("CObjectEventsArr Clean calls OnDel and removes every item", () => {
    const events = new CObjectEventsArr<object>();
    const deleted: string[] = [];
    const first: tListEvent = {OnDel: () => deleted.push("first")};
    const second: tListEvent = {OnDel: () => deleted.push("second")};

    events.Add(first);
    events.Add(second);
    events.Clean();

    assertEq(events.count(), 0, "array event Clean removes every item");
    assertEq(deleted.join(","), "second,first", "array event Clean calls OnDel during deletion");

    events.Clean();
    assertEq(deleted.join(","), "second,first", "array event Clean after empty does not call OnDel again");
});

test("CObjectEventsList Clean calls OnDel and removes every item", () => {
    const events = new CObjectEventsList<object>(false);
    const deleted: string[] = [];
    const first: tListEvent<object> = {OnDel: () => deleted.push("first")};
    const second: tListEvent<object> = {OnDel: () => deleted.push("second")};

    events.Add(first);
    events.Add(second);
    events.Clean();

    assertEq(events.count(), 0, "list event Clean removes every item");
    assertEq(deleted.join(","), "second,first", "list event Clean calls OnDel during deletion");

    events.Clean();
    assertEq(deleted.join(","), "second,first", "list event Clean after empty does not call OnDel again");
});

let failed = 0;

for (const {name, fn} of tests) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failed++;
        console.error(`not ok - ${name}`);
        console.error(error);
    }
}

if (failed > 0) {
    throw new Error(`${failed} listen/event regression test(s) failed`);
}

console.log(`${tests.length} listen/event regression tests passed`);
