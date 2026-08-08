"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callerLines = exports.callerLine = void 0;
exports.enable = enable;
exports.disable = disable;
exports.installConsoleCallerAnnotations = installConsoleCallerAnnotations;
exports.__LineFile = __LineFile;
exports.__LineFile2 = __LineFile2;
exports.__LineFiles = __LineFiles;
const { self, window } = globalThis;
let _enabled = false;
let _installed = false;
function enable(flag = true) {
    if (!flag) {
        disable();
        return;
    }
    installConsoleCallerAnnotations();
}
function disable() { _enabled = false; }
function installConsoleCallerAnnotations() {
    _enabled = true;
    if (_installed)
        return;
    if (typeof self == 'object' || typeof window == 'object')
        return;
    function moduleName(name) { return name; }
    const inspector = require(moduleName('inspector'));
    if (inspector.url() != undefined)
        return;
    _installed = true;
    let _callee;
    for (const methodName of [
        'debug', 'info', 'log', 'warn', 'error', 'group', 'groupCollapsed', 'table', 'timeLog', 'timeEnd',
        'count', 'assert', 'dir', 'dirxml'
    ]) {
        const origMethod = console[methodName];
        console[methodName] = function consoleCallerAnnotated(...args) {
            if (!_enabled)
                return origMethod(...args);
            const stack = new Error().stack;
            if (!stack)
                return origMethod(...args);
            const lines = stack.split('\n');
            const callerLine = lines[2];
            if (!callerLine)
                return origMethod(...args);
            const match = callerLine.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
            if (!match)
                return origMethod(...args);
            const [, functionName, fileName, lineNumber, columnNumber] = match;
            const funcName = functionName || '<anonymous>';
            let fileAndLine = `${fileName}:${lineNumber}:${columnNumber}  ${funcName}`;
            fileAndLine = fileAndLine.replaceAll('\\', '/');
            fileAndLine = fileAndLine.replace('webpack:///', '');
            fileAndLine = fileAndLine.replace('?', '');
            if (!fileAndLine.startsWith('./'))
                if (!fileAndLine.toLowerCase().startsWith('file:///'))
                    fileAndLine = 'file:///' + fileAndLine;
            if (!methodName.match(/debug|info|log|warn|error|dirxml/)) {
                _callee ??= fileAndLine;
                return origMethod(...args);
            }
            if (_callee) {
                fileAndLine = _callee;
                _callee = undefined;
            }
            origMethod(...args, '', fileAndLine);
        };
    }
}
function __LineFile(lvl = 0) {
    const stack = new Error().stack;
    if (!stack)
        return "";
    const lines = stack.split('\n');
    const targetLine = lines[lvl + 2];
    if (!targetLine)
        return "";
    const match = targetLine.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
    if (match) {
        const [, functionName, fileName, lineNumber, columnNumber] = match;
        const funcName = functionName || '<anonymous>';
        return `${fileName}:${lineNumber}:${columnNumber}  ${funcName}`;
    }
    return targetLine.trim();
}
function __LineFile2(lvl = 0) {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    let e = new Error().stack[lvl + 1];
    Error.prepareStackTrace = originalPrepareStackTrace;
    return `${e.getFileName()}:${e.getLineNumber()}:${e.getColumnNumber()}  ` + e.getFunctionName();
}
function __LineFiles(lvlStart = 0, lvlEnd = 5) {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    let e = new Error().stack.slice(lvlStart + 1, lvlEnd);
    const msgs = e.map(e => `${e.getFileName()}:${e.getLineNumber()}:${e.getColumnNumber()}  ` + e.getFunctionName());
    Error.prepareStackTrace = originalPrepareStackTrace;
    return msgs;
}
exports.callerLine = __LineFile2;
exports.callerLines = __LineFiles;
