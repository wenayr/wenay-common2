export * from "./Common/Time";
export * from "./Common/core/common";
export * from "./Common/Color";
export * from "./Common/data/ListNodeAnd";
export * from "./Common/math/Math";
export * from "./toError/myThrow";
export * from "./Exchange/ConnectData/Binance";

export * from "./Common/events/Listen";
export * from "./Common/events/joinListens";
export * from "./Common/ListenBySocket";

export * as BaseTypes from "./Common/core/BaseTypes";
export * as Common from "./Common/core/common";
export * as Time from "./Common/Time";
export * as Color from "./Common/Color";
export * as ListNodeAnd from "./Common/data/ListNodeAnd";
export * as Math from "./Common/math/Math";
export * as List from "./Common/data/List";
export * as LoadCandles from "./Exchange/ConnectData/Binance";

import {CListNodeAnd} from "./Common/data/ListNodeAnd";

export function test() {
    const tt = new CListNodeAnd()
    console.log("test");
    console.log("lalalal client")
}