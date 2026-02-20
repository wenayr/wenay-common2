
type tSide = "BUY" | "SELL"
type tType = "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_LIMIT" | "TAKE_PROFIT" | "TAKE_PROFIT_LIMIT" | "LIMIT_MAKER";
type tStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "PENDING_CANCEL" | "REJECTED" | "EXPIRED";

interface IIsoAssetRes {
    "asset": string,
    "borrowEnabled": boolean,
    "borrowed": string | number,
    "free": string | number,
    "interest": string | number,
    "locked": string | number,
    "netAsset": string | number,
    "netAssetOfBtc": string | number,
    "repayEnabled": boolean,
    "totalAsset": string | number,
}
export interface IIsolatedAcc {
    "baseAsset": IIsoAssetRes,
    "quoteAsset": IIsoAssetRes,
    "symbol": string,
    "isolatedCreated": boolean,
    "marginLevel": string | number,
    "marginLevelStatus": "EXCESSIVE"|"NORMAL"|"MARGIN_CALL"| "PRE_LIQUIDATION"| "FORCE_LIQUIDATION",
    "marginRatio": string | number,
    "indexPrice": string | number,
    "liquidatePrice": string | number,
    "liquidateRate": string | number,
    "tradeEnabled": boolean,
    "enabled": boolean
}

export type IBorrowable = {
    "amount": number, // account's currently max borrowable amount with sufficient system availability
    "borrowLimit": number // max borrowable amount limited by the account level,
    code?:number
}

export interface IOrderUpdateSpotOrMargin {
    symbol: string;
    orderId: number;
    clientOrderId: string;
    origQty: number;
    executedQty: number;
    price: number;
    side: tSide
    type: tType
    status: tStatus
    rejectReason?: "NONE" | number | string;
}
export interface IOrderUpdateSpotOrMarginMapById {
    [key: string]: IOrderUpdateSpotOrMargin
}

export interface IOrderSpotOrMargin {
    symbol: string;
    side: tSide
    type: tType
    timeInForce: "GTC" | "IOC" | "FOK" | "GTX";
    quantity: number;
    price?: number;
    newClientOrderId?: string;
    timestamp: number;
}

export interface IHistoryTradeSpot {
    symbol: string,
    id:number,
    orderId: number,
    orderListId?: number, //Unless OCO, the value will always be -1
    price: number, // as string
    qty: number, // as string
    quoteQty?:number, // as string
    commission: number, // as string
    commissionAsset: string
    time: number,
    isBuyer: boolean,
    isMaker: boolean,
    isBestMatch: boolean
}


export interface ISpotOrderRaw {
    symbol: string,
    code?: number,
    orderId: number,
    orderListId: number, //Unless OCO, value will be -1
    clientOrderId: string,
    origClientOrderId?: string,
    transactTime?: number,
    price: number, // as string
    origQty: number, // as string
    executedQty: number, // as string
    cummulativeQuoteQty: number, // as string
    status: tStatus
    timeInForce: "GTC" | "IOC" | "FOK" | "GTX";
    type: tType
    side: tSide
    strategyId?: number,               // This is only visible if the field was populated on order placement.
    strategyType?: number        // This is only visible if the field was populated on order placement.
    fills?: [
        {
            "price": number, // as string
            "qty": number, // as string
            "commission": number, // as string
            "commissionAsset": string
            "tradeId": number
        }[]
    ]
}

export interface IMarginAsset {
    asset: string,
    free: number,
    locked: number,
    borrowed: number,
    interest: number,

    // "marginLevel": "0.00000000",
    // "marginLevelStatus": "EXCESSIVE", // "EXCESSIVE", "NORMAL", "MARGIN_CALL", "PRE_LIQUIDATION", "FORCE_LIQUIDATION"
    // "marginRatio": "0.00000000",
    // "indexPrice": "10000.00000000",
    // "liquidatePrice": "1000.00000000",
    // "liquidateRate": "1.00000000",
    // "tradeEnabled": true
    // сколько есть монет в наличии, если отрицательный значит у нас монетка в займе
    netAsset: number,
    isRequest?: boolean
}
export interface IMarginAssets {
    [key: string]: IMarginAsset
}

export interface ISpotAsset {
    asset: string,
    free: number,
    locked: number
}
export interface ISpotAssets {
    [key: string]: ISpotAsset
}
export interface IFuturesAssets {
    [key: string]: {
        asset: string,
        walletBalance: number,
        availableBalance?: number
    }
}
export interface IFuturesPositions {
    [key: string]: IAccUpdatePositionFutures
}

export interface IBBO {
    bestAsk: number;
    bestBid: number;
}


interface IIsoAssetRes {
    "asset": string,
    "borrowEnabled": boolean,
    "borrowed": string | number,
    "free": string | number,
    "interest": string | number,
    "locked": string | number,
    "netAsset": string | number,
    "netAssetOfBtc": string | number,
    "repayEnabled": boolean,
    "totalAsset": string | number,
}
export interface IIsolatedAcc {
    "baseAsset": IIsoAssetRes,
    "quoteAsset": IIsoAssetRes,
    "symbol": string,
    "isolatedCreated": boolean,
    "marginLevel": string | number,
    "marginLevelStatus": "EXCESSIVE"|"NORMAL"|"MARGIN_CALL"| "PRE_LIQUIDATION"| "FORCE_LIQUIDATION",
    "marginRatio": string | number,
    "indexPrice": string | number,
    "liquidatePrice": string | number,
    "liquidateRate": string | number,
    "tradeEnabled": boolean,
    "enabled": boolean
}



export interface IAssetRawFutures {
    asset: string,       // USDT ...    // asset name
    walletBalance: string; // число      // wallet balance
    unrealizedProfit: string; // число    // unrealized profit
    marginBalance: string; // число      // margin balance
    maintMargin: string; // число        // maintenance margin required
    initialMargin: string; // число    // total initial margin required with current mark price
    positionInitialMargin: string; // число    //initial margin required for positions with current mark price
    openOrderInitialMargin: string; // число   // initial margin required for open orders with current mark price
    crossWalletBalance: string; // число      // crossed wallet balance
    crossUnPnl: string; // число      // unrealized profit of crossed positions
    availableBalance: string; // число       // available balance
    maxWithdrawAmount: string; // число     // maximum amount for transfer out
    marginAvailable: boolean    // whether the asset can be used as margin in Multi-Assets mode
    updateTime: number
}
export interface IPositionRawFutures {
    symbol: string,    // symbol name
    initialMargin: string; // число   // initial margin required with current mark price
    maintMargin: string; // число     // maintenance margin required
    unrealizedProfit: string; // число  // unrealized profit
    positionInitialMargin: string; // число      // initial margin required for positions with current mark price
    openOrderInitialMargin: string; // число     // initial margin required for open orders with current mark price
    leverage: string; // число      // current initial leverage
    isolated: boolean;       // if the position is isolated
    entryPrice: string; // число    // average entry price
    maxNotional: string; // число    // maximum available notional with current leverage
    positionSide: 'BOTH' | 'LONG' | 'SHORT';     // position side
    positionAmt: string; // число          // position amount
}
export interface IAccountInfoRawFutures {
    feeTier: number,       // account commisssion tier
    canTrade: boolean,   // if can trade
    canDeposit: boolean,     // if can transfer in asset
    canWithdraw: boolean,    // if can transfer out asset
    updateTime: number,
    totalInitialMargin: string; // число    // total initial margin required with current mark price (useless with isolated positions), only for USDT asset
    totalMaintMargin: string; // число    // total maintenance margin required, only for USDT asset
    totalWalletBalance: string; // число     // total wallet balance, only for USDT asset
    totalUnrealizedProfit: string; // число   // total unrealized profit, only for USDT asset
    totalMarginBalance: string; // число     // total margin balance, only for USDT asset
    totalPositionInitialMargin: string; // число    // initial margin required for positions with current mark price, only for USDT asset
    totalOpenOrderInitialMargin: string; // число   // initial margin required for open orders with current mark price, only for USDT asset
    totalCrossWalletBalance: string; // число      // crossed wallet balance, only for USDT asset
    totalCrossUnPnl: string; // число      // unrealized profit of crossed positions, only for USDT asset
    availableBalance: string; // число       // available balance, only for USDT asset
    maxWithdrawAmount: string; // число     // maximum amount for transfer out, only for USDT asset
    assets: IAssetRawFutures[],
    positions: IPositionRawFutures[]
    // positions of all sumbols in the market are returned
    // only "BOTH" positions will be returned with One-way mode
    // only "LONG" and "SHORT" positions will be returned with Hedge mode
}

export interface IOrderFutures {
    symbol?: string;
    clientOrderId?: string;
    side?: 'BUY' | 'SELL'
    orderType?: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'TRAILING_STOP_MARKET'
    timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX',
    originalQuantity: number; // число
    originalPrice?: number; // число
    averagePrice?: number; // число
    orderStatus: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' |'EXPIRED' | 'NEW_INSURANCE' | 'NEW_ADL'
    orderId: number,
    orderLastFilledQuantity?: number; // число
    orderFilledAccumulatedQuantity: number; // число
    positionSide?: 'LONG' | 'SHORT' | 'BOTH';
}

export interface IOrderFuturesMapById {
    [key:string]: IOrderFutures
}

export interface IOrderUpdateCallbackFutures {
    eventType: string;
    eventTime: number;
    transaction: number,
    order: IOrderFutures
}


export interface IOrderRawFutures {
    avgPrice: string; // число
    clientOrderId: string;
    cumQuote: string; // число
    executedQty: string; // число
    orderId: number;
    origQty: string; // число
    origType: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'TRAILING_STOP_MARKET';
    price: string; // число
    reduceOnly: boolean;
    side: 'BUY' | 'SELL'
    positionSide: 'LONG' | 'SHORT' | 'BOTH';
    status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'NEW_INSURANCE' | 'NEW_ADL'
    stopPrice: string; // число              // please ignore when order type is TRAILING_STOP_MARKET
    closePosition: boolean,   // if Close-All
    symbol: string;
    time: number;            // order time
    timeInForce: 'GTC' | 'IOC' | 'FOK' | 'GTX',
    type: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'TRAILING_STOP_MARKET';
    activatePrice: string; // число          // activation price, only return with TRAILING_STOP_MARKET order
    priceRate: string; // число               // callback rate, only return with TRAILING_STOP_MARKET order
    updateTime: number;        // update time
    workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect: boolean;
    code?:number,
    msg?: string
}


export interface IMgCallPositionFutures {
    symbol: string;
    positionSide: string;  // LONG SHORT BOTH
    positionAmount: string; // число как стринг
    marginType: string;  // CROSSED   ISOLATED
    isolatedWallet: string; // число как стринг // Isolated Wallet (if isolated position)
    markPrice: string; // число как стринг
    unrealizedPnL: string; // число как стринг  профит/лосс
    maintenanceMargin: string; // число как стринг   // Maintenance Margin Required
}

export interface IMarginCallCallbackFutures {
    eventType: string;
    eventTime: number;
    crossWalletBalance: string // Cross Wallet Balance. Only pushed with crossed position margin call
    positions: IMgCallPositionFutures[]
}

export interface IOrderUpdateCallbackFutures {
    eventType: string;
    eventTime: number;
    transaction: number,
    order: IOrderFutures
}

export interface IAccUpdatePositionFutures {
    symbol: string,
    positionAmount: number; // число как стринг
    entryPrice: number; // число как стринг
    accumulatedRealized?: number; // число как стринг (pre-fee)
    unrealizedPnL: number; // число как стринг
    marginType?: string; // CROSSED   ISOLATED
    isolatedWallet?: number; // число как стринг // Isolated Wallet (if isolated position)
    positionSide: 'BOTH' | 'LONG' | 'SHORT';  // LONG SHORT BOTH
    isRequest?: boolean
}

export interface IAccUpdateBalanceFutures {
    asset: string;  // USDT ...
    walletBalance: string; // число как стринг
    crossWalletBalance: string; // число как стринг
}
export interface IAccUpdateCallbackFutures {
    eventType: string;
    eventTime: number;
    transaction: number;
    updateData: {
        eventReasonType: 'DEPOSIT' | 'WITHDRAW' | 'ORDER' | 'FUNDING_FEE' | 'WITHDRAW_REJECT' | 'ADJUSTMENT' | 'INSURANCE_CLEAR' | 'ADMIN_DEPOSIT' | 'ADMIN_WITHDRAW' | 'MARGIN_TRANSFER' | 'MARGIN_TYPE_CHANGE' | 'ASSET_TRANSFER' | 'OPTIONS_PREMIUM_FEE' | 'OPTIONS_SETTLE_PROFIT' | 'AUTO_EXCHANGE';
        balances: IAccUpdateBalanceFutures[];
        positions: IAccUpdatePositionFutures[];
    }
}

export interface ITradeHistoryFutures {
    buyer: boolean;
    commission: string; // число
    commissionAsset: string; // USDT ...
    id: number,
    maker: boolean,
    orderId: number,
    price: string; // число
    qty: string; // число
    quoteQty: string; // число
    realizedPnl: string; // число
    side: 'BUY' | 'SELL';
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    symbol: string;
    time: number;
}



export interface IIsolatedFeeData {
    "vipLevel": number,
    "symbol": string,
    "leverage": string | number,
    "data": [
        {
            "coin": string,
            "dailyInterest": string | number,
            "borrowLimit": string | number
        },
        {
            "coin": string,
            "dailyInterest": string | number,
            "borrowLimit": string | number
        }
    ]
}
