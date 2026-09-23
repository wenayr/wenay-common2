# wenay-exchange

Exchange data types that `wenay-common2` exported from its root up to 2.x: bars (OHLC), time
series, quotes history with timeframes built on demand, history loading, strategy parameters, and
the binary streams the series serialize to. The code is long-stable; it moved out in
`wenay-common2` 3.0.0 so that package stays a transport/state library.

## Install

```sh
npm install wenay-exchange wenay-common2
```

`wenay-common2` (>= 3.0.0) is a peer dependency. The project's single installed copy supplies the
time and core helpers (`TF`, `Period`, `BSearch`...), so nothing is downloaded twice and
`Bars.TF` is the same class as `TF` from `wenay-common2`: identity checks such as
`bars.Tf == TF.H1` keep working when a project uses both packages.

## Migrating from wenay-common2 2.x

The names and namespaces are unchanged; only the package changes.

| 2.x | 3.x |
| --- | --- |
| `import {Bars, Params} from 'wenay-common2'` | `import {Bars, Params} from 'wenay-exchange'` |
| `import {Bars, Params} from 'wenay-common2/client'` | `import {Bars, Params} from 'wenay-exchange'` |
| `import {CQuotesHistory, CParams, toValues, ...} from 'wenay-common2'` | the same names `from 'wenay-exchange'` |

`TF`, `Period` and the rest of the time API stay in `wenay-common2` (`Bars` re-exports them).
`ByteStreamW` / `ByteStreamR` are new root exports here: `CTimeSeries.write/read` take them.

## Surface

Root: the history interfaces (`IHistoryBase`), history loading (`LoadBase`), market data
(`CQuotesHistory`...), params (`CParams`, `toValues`...), `ByteStreamW` / `ByteStreamR`, and the
`Bars` and `Params` namespaces.

### Params (`Params`, also flat)
```
class CParams / CParamsReadonly implements IParams
toValues(params) -> SimpleParams                    // IParams -> plain enabled values   (alias: GetSimpleParams)
fromValues(infos, values) -> IParams                // inverse                            (alias: mergeParamValuesToInfos)
isSimpleParams(params) -> boolean                   // (isSimpleParams2 @deprecated)
isParamBase(p) · isParamGroup(p) · isParamGroupOrArray(p)
enableAllParams(params, enabled=true) -> clone
// types: IParam (the union) + IParamBase are the entry points; the per-flavour IParamNum/IParamEnum/IParamTime*/...
//        and *Readonly twins exist but read the union — wrap with ReadonlyFull<T> rather than the *Readonly aliases.
```

### Bars (`Bars`)
```
class OHLC · class CBar extends CBarBase (IBar)
class CBars (IBarsImmutable) · class CBarsMutable / CBarsMutableExt (IBarsExt)
  .push(bars|bar)        // append            (alias: Add)
  .updateLast(bar) · .addTick(tick) · .addTicks(ticks)        (alias: AddTick/AddTicks)
createRandomBars(tf, startTime, endTime|count, startPrice?, volatility?, tickSize?) -> CBars   // alias: CreateRandomBars
class CTimeSeries<T=number> (ITimeseries) · CTimeSeriesReadonly<T>
  .write(stream: ByteStreamW, valueType|valueWriter) · CTimeSeries.read(stream: ByteStreamR, valueType|valueGetter)
findBarsShallow(srcBars, barsToFind) -> number
// Bars also re-exports the wenay-common2 time surface: Bars.TF, Bars.Period, Bars.D1_MS...
```

### Market data
```
class CQuotesHistory
  .get(tf) -> IBarsImmutable|null                   // build-on-demand   (alias: Bars(tf))
class CQuotesHistoryMutable / CQuotesHistoryMutable2 extends CQuotesHistory
  .append(bars[, tf])    (alias: AddEndBars)  ·  .prepend(bars[, tf])   (alias: AddStartBars)
  .addTicks(ticks)       (alias: AddTicks; replaces last bar)  ·  AddNewTicks (strict append-only, rare)
  .deleteBefore(time)
```

### Binary streams
```
class ByteStreamW / ByteStreamR                    // pushNumber(value, type)/readNumber(type) over NumericTypes union
nullable(type: NumericTypes)                       // typed push*/read* (int8..uint64/float/double)
```

## Development

The source lives in the `wenay-common2` repository under `packages/wenay-exchange` and is tested there
against the library it depends on: `npm test` (build, strict type check, specs) and
`npm run verify:consumer` (both packages installed from tarballs into an empty project).
