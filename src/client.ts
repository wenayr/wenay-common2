export * from "./Common/Time";
export * from "./Common/common";
export * from "./Common/Color";
export * from "./Common/ListNodeAnd";
export * from "./Common/Math";
export * from "./toError/myThrow";
export * from "./Exchange/ConnectData/Binance";

export * from "./Common/Listen";
export * from "./Common/joinListens";
export * from "./Common/ListenBySocket";

export * as BaseTypes from "./Common/BaseTypes";
export * as Common from "./Common/common";
export * as Time from "./Common/Time";
export * as Color from "./Common/Color";
export * as ListNodeAnd from "./Common/ListNodeAnd";
export * as Math from "./Common/Math";
export * as List from "./Common/List";
export * as LoadCandles from "./Exchange/ConnectData/Binance";

import {CListNodeAnd} from "./Common/ListNodeAnd";

export function test() {
    const tt = new CListNodeAnd()
    console.log("test");
    console.log("lalalal client")
}