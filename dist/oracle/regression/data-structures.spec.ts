import {CList} from "../../src/Common/data/List";
import {CListNodeAnd} from "../../src/Common/data/ListNodeAnd";
import {objectGet, objectSet, objectUnset} from "../../src/Common/data/objectPath";
import {createRateWindow} from "../../src/Common/funcTimeWait";

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

function assertArrayEq<T>(actual: readonly T[], expected: readonly T[], message: string) {
    const same = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    if (!same) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function captureThrow(fn: () => void) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error("expected function to throw");
}

test("CList iteration survives deleting the next node", () => {
    const list = new CList([1, 2, 3, 4]);
    const node2 = list.find(2);
    const visited: number[] = [];

    assert(node2, "node to delete exists");

    for (const node of list) {
        visited.push(node.value);
        if (node.value === 1) {
            list.delete(node2);
        }
    }

    assertArrayEq(visited, [1, 3, 4], "iterator skips the deleted next node and continues");
    assertArrayEq([...list.values()], [1, 3, 4], "list contents are linked after deleting next node");
    assertEq(list.size, 3, "list size reflects deleted next node");
});

test("CList reversed iteration walks from last to first", () => {
    const list = new CList(["first", "second", "third"]);

    assertArrayEq([...list.reversedValues()], ["third", "second", "first"], "reversedValues returns tail-to-head order");
    assertArrayEq([...list.reversedNodes()].map(node => node.value), ["third", "second", "first"], "reversedNodes returns tail-to-head nodes");
});

test("CListNodeAnd keeps falsy values", () => {
    const list = new CListNodeAnd<0 | false | "">();

    list.AddEnd(0);
    list.AddEnd(false);
    list.AddEnd("");

    assertArrayEq(list.GetArray(), [0, false, ""], "legacy list stores falsy values passed to AddEnd");
    assertEq(list.dataFirst, 0, "dataFirst preserves 0");
    assertEq(list.dataEnd, "", "dataEnd preserves empty string");
    assertEq(list.find(node => node.data === false)?.data, false, "find can observe false data");
});

test("objectPath null traversal throws domain errors, not native TypeError", () => {
    const getError = captureThrow(() => objectGet({a: null} as any, ["a", "b"]));
    const setError = captureThrow(() => objectSet({a: null} as any, ["a", "b"], 1));
    const unsetError = captureThrow(() => objectUnset({a: null} as any, ["a", "b"]));

    assert(!(getError instanceof TypeError), "objectGet null traversal is not a native TypeError");
    assert(!(setError instanceof TypeError), "objectSet null traversal is not a native TypeError");
    assert(!(unsetError instanceof TypeError), "objectUnset null traversal is not a native TypeError");
    assertEq(String(getError), "value is not an object: null", "objectGet reports null traversal");
    assertEq(String(setError), "value is not an object: null", "objectSet reports null traversal");
    assertEq(String(unsetError), "value is not an object: null", "objectUnset reports null traversal");
});

test("rate window handles out-of-order timestamps", () => {
    const originalNow = Date.now;
    const window = createRateWindow();

    try {
        Date.now = () => 350;
        window.add({type: "UID", timeStamp: 300, weight: 3});
        window.add({type: "UID", timeStamp: 100, weight: 1});
        window.add({type: "UID", timeStamp: 200, weight: 2});

        assertArrayEq(window.dStatic.UID.map(([time]) => time), [100, 200, 300], "add keeps timestamps sorted");
        assertEq(window.sumWeight("UID", 175), 5, "sumWeight includes only entries inside the active window");
        assertArrayEq(window.dStatic.UID.map(([time]) => time), [200, 300], "sumWeight prunes old sorted entries");

        window.add({type: "UID", timeStamp: 250, weight: 4});
        assertArrayEq(window.dStatic.UID.map(([time]) => time), [200, 250, 300], "later out-of-order add is inserted in timestamp order");
        assertEq(window.readyAt("UID", 5), 300, "readyAt uses sorted time order when weights cross the limit");
        assertEq(window.byWeightTimeNow("UID", 250, 5), 250, "byWeightTimeNow ignores future entries after sorting");
    } finally {
        Date.now = originalNow;
    }
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
    throw new Error(`${failed} data-structures regression test(s) failed`);
}

console.log(`${tests.length} data-structures regression tests passed`);
