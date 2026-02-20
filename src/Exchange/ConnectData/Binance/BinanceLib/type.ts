import {TF} from "../../../../Common/Time";


export type tErrorBinance = {
    code: number,
    msg: string
}

const eSymbolStatus = {
    PRE_TRADING: 1,
    TRADING: 2,
    POST_TRADING: 3,
    END_OF_DAY: 4,
    HALT: 5,
    AUCTION_MATCH: 6,
    BREAK: 7,
} as const
type tSymbolStatus = keyof typeof eSymbolStatus

const eAccount = {
    SPOT: 1,
    MARGIN: 2,
    LEVERAGED: 3,
    TRD_GRP_002: 4,
    TRD_GRP_003: 5,
    TRD_GRP_004: 6,
    TRD_GRP_005: 7,
    TRD_GRP_006: 8,
    TRD_GRP_007: 9,
} as const
type tAccount = keyof typeof eAccount

// Description
const eOrderStatusDescription = {
    NEW:                "The order has been accepted by the engine.",
    PARTIALLY_FILLED:   "A part of the order has been filled.",
    FILLED:             "The order has been completed.",
    CANCELED:           "The order has been canceled by the user.",
    PENDING_CANCEL:      "Currently unused",
    REJECTED:           "The order was not accepted by the engine and not processed.",
    EXPIRED:            "The order was canceled according to the order type's rules (e.g. LIMIT FOK orders with no fill, LIMIT IOC or MARKET orders that partially fill) or by the exchange, (e.g. orders canceled during liquidation, orders canceled during maintenance)",
    EXPIRED_IN_MATCH:   "The order was canceled by the exchange due to STP trigger. (e.g. an order with EXPIRE_TAKER will match with existing orders on the book with the same account or same tradeGroupId)"
} as const
type OrderStatus = keyof typeof eOrderStatusDescription

const eOCOStatus = {
    RESPONSE:	    "This is used when the ListStatus is responding to a failed action. (E.g. Orderlist placement or cancellation)",
    EXEC_STARTED:	"The order list has been placed or there is an update to the order list status.",
    ALL_DONE:	    "The order list has finished executing and thus no longer active.",
} as const
type tOCOStatus = keyof typeof eOCOStatus

const eOCOOrderStatus = {
    EXECUTING:	"Either an order list has been placed or there is an update to the status of the list.",
    ALL_DONE:	"An order list has completed execution and thus no longer active.",
    REJECT:	    "The List Status is responding to a failed action either during order placement or order canceled.",
} as const
type tOCOOrderStatus = keyof typeof eOCOOrderStatus

const eContingencyType = {
    OCO: 1
} as const
type tContingencyType = keyof typeof eContingencyType

// (orderTypes, type)
const eOrderTypes = {
    LIMIT: 1,
    MARKET: 2,
    STOP_LOSS: 3,
    STOP_LOSS_LIMIT: 4,
    TAKE_PROFIT: 5,
    TAKE_PROFIT_LIMIT: 6,
    LIMIT_MAKER: 7
} as const
type tOrderTypes = keyof typeof eOrderTypes

// (newOrderRespType)
const eOrderResponseType = {
    ACK: 1,
    RESULT: 2,
    FULL: 3
} as const
type tOrderResponseType = keyof typeof eOrderResponseType

const eOrderSide = {
    BUY: 1,
    SELL: 2
} as const
type tOrderSide = keyof typeof eOrderSide

//timeInForce This sets how long an order will be active before expiration.
const eTimeInForce = {
    GTC:	"Good Til Canceled An order will be on the book unless the order is canceled.",
    IOC:	"Immediate Or Cancel An order will try to fill the order as much as it can before the order expires.",
    FOK:	"Fill or Kill An order will expire if the full order cannot be filled upon execution.  "
}
type tTimeInForce = keyof typeof eTimeInForce

const periodBase = {
    "1s" : 1,
    "1m" : 1 * 60,
    "3m" : 3 * 60,
    "5m" : 5 * 60,
    "15m": 16 * 60,
    "30m": 30 * 60,
    "1h" : 1 * 60 * 60,
    "2h" : 2 * 60 * 60,
    "4h" : 4 * 60 * 60,
    "6h" : 6 * 60 * 60,
    "8h" : 8 * 60 * 60,
    "12h": 12 * 60 * 60,
    "1d" : 24 * 60 * 60,
    "3d" : 3 * 24 * 60 * 60,
    "1w" : 7 * 24 * 60 * 60,
    "1M" : 30 * 24 * 60 * 60,
} as const

const periodConvertTo = (()=>{
    type tPeriod = keyof typeof periodBase
    const convertTf: {[key: number]: tPeriod} = {}
    for (let key in periodBase) {
        const tt =periodBase[key as tPeriod ]
        convertTf[tt] = key as tPeriod
    }
    return {
        toName: periodBase,
        toSec: convertTf
    }
})()

// rateLimitType
const eRateLimiters = {
    REQUEST_WEIGHT: 1,
    ORDERS: 2,
    RAW_REQUESTS: 3
} as const
type tRateLimiters = keyof typeof eRateLimiters

//  (interval)
const eRatelimitIntervals = {
    SECOND: 60,
    MINUTE: 3600,
    DAY: 86400
} as const
type tRatelimitIntervals = keyof typeof eRatelimitIntervals



