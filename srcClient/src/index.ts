
// import * as baseTypes from "./Common/BaseTypes";
// import * as common from "./Common/Common";
// import * as time from "./Common/Time";
// import * as math from "./Common/Math";
// import * as list from "./Common/List";
// import * as color from "./Common/Color";
// import * as listNodeAnd from "./Common/ListNodeAnd";
// import * as console from "console";
// // export {common}
// // export * from "./and/CParams";
//
//

// export * from "./Common/BaseTypes";
export * from "../../src/Common/Time";
export * from "../../src/Common/core/common";
export * from "../../src/Common/Color";
export * from "../../src/Common/data/ListNodeAnd";
export * from "../../src/Common/math/Math";
export * from "../../src/Exchange/ConnectData/Binance";

export * as BaseTypes from "../../src/Common/core/BaseTypes";
export * as Common from "../../src/Common/core/common";
export * as Time from "../../src/Common/Time";
export * as Color from "../../src/Common/Color";
export * as ListNodeAnd from "../../src/Common/data/ListNodeAnd";
export * as Math from "../../src/Common/math/Math";
export * as List from "../../src/Common/data/List";
export * as LoadCandles from "../../src/Exchange/ConnectData/Binance";

import {CListNodeAnd} from "../../src/Common/data/ListNodeAnd";

export function test() {
    const tt = new CListNodeAnd()
    console.log("test client");
    console.log("lalalal this is client")
}