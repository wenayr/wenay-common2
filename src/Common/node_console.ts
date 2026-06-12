///?<reference no-default-lib="true"/>
///?<reference lib="esnext"/>
///?<reference types="node"/>
///?<reference types="source-map-support"/>

import type {CallSite} from "source-map-support"
//type CallSite = { getLineNumber() :number; getFileName() :string; getFunctionName() :string; getColumnNumber() :number; }

export {};

const {self, window} = globalThis as any;

//console.log("!!!!!",typeof self, typeof window);

let _enabled = false;

export function enable(flag=true) { _enabled= flag; }
export function disable()         { _enabled= false; }

// Раньше тут был приватный setupLogs2 на source-map-support (никогда не вызывался,
// поэтому его wrapCallSite всегда был undefined). Удалён: актуальный setupLogs ниже
// опирается на source maps рантайма (tsx / node --enable-source-maps).
function setupLogs(){
    if (typeof self != 'object' && typeof window!="object") { // если запущено на node.js

        function moduleName(name :string) { return name; }
        let inspector= require(/* webpackIgnore: true */ moduleName('inspector')) as typeof import('inspector');
        if (inspector.url()!=undefined) return;  // запущено в дебаггере

        _enabled= true;
        const origLogMethod= console.log;
        const origErrorMethod = console.error;
        let _callee :string|undefined;

        for(let methodName of [
            'debug', 'info', 'log', 'warn', 'error', 'group', 'groupCollapsed', 'table', 'timeLog', 'timeEnd',
            'count', 'assert', 'dir', 'dirxml'
        ] satisfies (keyof typeof console)[])
        {
            const origMethod = console[methodName] as typeof console.log;

            console[methodName] = ((...args :any[]) => {
                if (!_enabled) return origMethod(...args);

                // Используем обычный Error.stack - tsx уже применяет source maps
                const stack = new Error().stack;
                if (!stack) return origMethod(...args);

                const lines = stack.split('\n');
                const callerLine = lines[2]; // 0=Error, 1=console wrapper, 2=caller

                if (!callerLine) return origMethod(...args);

                // Парсим строку: "at functionName (file:line:col)" или "at file:line:col"
                const match = callerLine.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
                if (!match) return origMethod(...args);

                const [, functionName, fileName, lineNumber, columnNumber] = match;
                const funcName = functionName || '<anonymous>';

                let fileAndLine = `${fileName}:${lineNumber}:${columnNumber}  ${funcName}`;
                fileAndLine = fileAndLine.replaceAll("\\","/");
                fileAndLine = fileAndLine.replace("webpack:///","");
                fileAndLine = fileAndLine.replace("?","");

                if (!fileAndLine.startsWith("./"))
                    if (!fileAndLine.toLowerCase().startsWith("file:///"))
                        fileAndLine = "file:///" + fileAndLine;

                // Для некоторых методов нужна особая обработка
                if (!methodName.match(/debug|info|log|warn|error|dirxml/)) {
                    _callee ??= fileAndLine;
                    return origMethod(...args);
                }

                if (_callee) {
                    fileAndLine = _callee;
                    _callee = undefined;
                }

                origMethod(...args, "", fileAndLine);
            }) as any;
        }
    }

}

if (1)
    setupLogs();

export function __LineFile(lvl = 0){
    const stack = new Error().stack;
    if (!stack) return "";

    const lines = stack.split('\n');
    const targetLine = lines[lvl + 2]; // +2: 0=Error, 1=__LineFile, 2=caller

    if (!targetLine) return "";

    // Парсим строку: "at functionName (file:line:col)" или "at file:line:col"
    const match = targetLine.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
    if (match) {
        const [, functionName, fileName, lineNumber, columnNumber] = match;
        const funcName = functionName || '<anonymous>';
        return `${fileName}:${lineNumber}:${columnNumber}  ${funcName}`;
    }

    return targetLine.trim();
}

// возвращает файл, строчку и позицию где был вызван, либо выше вызванная функция по номеру уровня.
// Позиции — как их видит V8: source maps применяются рантаймом (tsx / --enable-source-maps), не нами.
export function __LineFile2(lvl = 0){
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    type MyError= { stack: CallSite[]}
    let e = (new Error() as unknown as MyError).stack[lvl + 1];
    Error.prepareStackTrace = originalPrepareStackTrace;
    return `${e.getFileName()}:${e.getLineNumber()}:${e.getColumnNumber()}  ` + e.getFunctionName()
}

// стек диапазоном уровней, формат как у __LineFile2
export function __LineFiles(lvlStart = 0, lvlEnd: number|undefined = 5){
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    type MyError= { stack: CallSite[]}
    let e = (new Error() as unknown as MyError).stack.slice(lvlStart + 1, lvlEnd);
    const msgs = e.map(e=>`${e.getFileName()}:${e.getLineNumber()}:${e.getColumnNumber()}  ` + e.getFunctionName())
    Error.prepareStackTrace = originalPrepareStackTrace;
    return msgs
}
// // Tests:
// function ttt(){
//     console.log(__LineFile(1));
// }
// ttt()


// function test() {
//
//     console.log("LOG");
//     console.debug("DEBUG");
//     console.warn("WARN");
//     console.error("ERROR");
//     console.info("INFO");
//     console.time("ttt");
//     console.timeLog("ttt","TIME_LOG");
//     console.timeEnd("ttt");
//     console.count("COUNT");
//     console.group("GROUP");
//     console.groupEnd();
//     console.groupCollapsed("GROUP COLLAPSED");
//     console.groupEnd();
//     console.table([10,20,30]);
//     console.assert(false);
//     console.dir({DIR: 10, b: "str", c: { d: 1, e: [5,6,7] }})
//     console.dirxml("DIRXML",10,20,"hello", {a:5, b:"str"});
//     console.trace("TRACE");
// }

// test();

// Tests:
// console.log('%s %d', 'hi', 42);
// console.log({ a: 'foo', b: 'bar'});


