type LONG = number
type NUMBER = number
type STRING = string
type INT = number
type DECIMAL = number
type INTEGER = number
type ARRAY<T = any> = T[]
type BigDecimal = number
type DOUBLE = number
type BOOLEAN = boolean

type tFunc<P> = {
    name: string,
    nameType: string,
    wight?: {
        name: string,
        data: number
    }[],
    address?: {
        type: "GET" | "POST" | string
        url: string
        HMAC?: boolean
    }, params?: P | undefined
}

type tData = <T, P = undefined>(data: tFunc<P>) => T


export class CBinanceMarketDataMini {

    //https://binance-docs.github.io/apidocs/spot/en/#exchange-information
    ExchangeInformation = (data: tData) => {
        const name= "Exchange Information"
        const nameType= ""
        const wight= [{
            name: "IP",
            data: 10
        }
        ]
        const address = {
            type: "GET",
            url: "/api/v3/exchangeInfo"
        }
        // Options Example
        type params = {}
        type req = {
            "timezone": string, // "UTC"
            "serverTime": number, // 1565246363776
            "rateLimits": [
                {
                    //These are defined in the `ENUM definitions` section under `Rate Limiters (rateLimitType)`.
                    //All limits are optional
                }
            ],
            "exchangeFilters": [	//These are the defined filters in the `Filters` section.
                //All filters are optional.

            ],
            "symbols": [
                {
                    "symbol": string, // "ETHBTC"
                    "status": string, // "TRADING"
                    "baseAsset": string, // "ETH"
                    "baseAssetPrecision": number, // 8
                    "quoteAsset": string, // "BTC"
                    "quotePrecision": number, // 8
                    "quoteAssetPrecision": number, // 8
                    "orderTypes": ("LIMIT"|
                        "LIMIT_MAKER"|
                        "MARKET"|
                        "STOP_LOSS"|
                        "STOP_LOSS_LIMIT"|
                        "TAKE_PROFIT"|
                        "TAKE_PROFIT_LIMIT" ) []
                    ,
                    "icebergAllowed": boolean, // true
                    "ocoAllowed": boolean, // true
                    "quoteOrderQtyMarketAllowed": boolean, // true
                    "allowTrailingStop": boolean, // false
                    "cancelReplaceAllowed": boolean, // false
                    "isSpotTradingAllowed": boolean, // true
                    "isMarginTradingAllowed": boolean, // true
                    "filters": [			//These are defined in the Filters section.
                        //All filters are optional
                    ],
                    "permissions": [
                        string, // "SPOT"
                        string, // "MARGIN"
                    ],
                    "defaultSelfTradePreventionMode": string, // "NONE"
                    "allowedSelfTradePreventionModes": [
                        string, // "NONE"
                    ]
                }
            ]
        }

        return (params: params) => data<req, params>({name, nameType, wight, address, params}) as req
    }


}