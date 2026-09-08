"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMAND_RECEIPTS_TOTAL = exports.COMMAND_RECEIPTS_PER_ACCOUNT = exports.COMMAND_RECEIPT_KEEP_MS = void 0;
exports.createCommandHost = createCommandHost;
exports.forwardCommands = forwardCommands;
const common_1 = require("../core/common");
const funcTimeWait_1 = require("../funcTimeWait");
const command_fragment_1 = require("./command-fragment");
const command_receipts_1 = require("./command-receipts");
exports.COMMAND_RECEIPT_KEEP_MS = 10 * 60_000;
exports.COMMAND_RECEIPTS_PER_ACCOUNT = 1024;
exports.COMMAND_RECEIPTS_TOTAL = 8192;
function requiredName(value, label, max = 200) {
    if (typeof value != 'string' || value.length == 0 || value.length > max) {
        throw new Error(`command host: ${label} must be a non-empty string up to ${max} chars`);
    }
    return value;
}
function createCommandHost(deps) {
    const { commands, now = Date.now } = deps;
    const keepMs = deps.receipts?.keepMs ?? exports.COMMAND_RECEIPT_KEEP_MS;
    const maxPerAccount = deps.receipts?.maxPerAccount ?? exports.COMMAND_RECEIPTS_PER_ACCOUNT;
    const maxTotal = deps.receipts?.maxTotal ?? exports.COMMAND_RECEIPTS_TOTAL;
    const perMinute = deps.limits?.perMinute ?? 0;
    const budgetOf = deps.limits?.budgetOf;
    const rate = perMinute > 0 || budgetOf ? (0, funcTimeWait_1.createRateWindow)({ now }) : null;
    const accounts = new Map();
    let line = null;
    let totalReceipts = 0;
    let executions = 0;
    let duplicates = 0;
    let closed = false;
    function accountReceipts(account) {
        let receipts = accounts.get(account);
        if (!receipts)
            receipts = new Map();
        else
            accounts.delete(account);
        accounts.set(account, receipts);
        return receipts;
    }
    function dropReceipt(account, receipts, requestId) {
        const receipt = receipts.get(requestId);
        if (!receipt)
            return;
        receipts.delete(requestId);
        totalReceipts--;
        if (line && !receipt.pending)
            line.delete(receipt.lineKey ?? (0, command_receipts_1.commandReceiptKey)(account, requestId));
    }
    function dropAccount(account, receipts) {
        if (line) {
            for (const [requestId, receipt] of receipts) {
                if (!receipt.pending)
                    line.delete(receipt.lineKey ?? (0, command_receipts_1.commandReceiptKey)(account, requestId));
            }
        }
        totalReceipts -= receipts.size;
        accounts.delete(account);
        if (rate && rate.sumWeight(account, 60_000) == 0)
            rate.drop(account);
    }
    function sweep(account, receipts) {
        const deadline = now() - keepMs;
        for (const [requestId, receipt] of receipts) {
            if (receipt.pending)
                continue;
            if (receipt.ts > deadline && receipts.size <= maxPerAccount)
                break;
            dropReceipt(account, receipts, requestId);
        }
    }
    function accountExpired(receipts, deadline) {
        for (const receipt of receipts.values()) {
            if (receipt.pending || receipt.ts > deadline)
                return false;
        }
        return true;
    }
    function compact() {
        const deadline = now() - keepMs;
        for (const [account, receipts] of accounts) {
            if (!accountExpired(receipts, deadline))
                break;
            dropAccount(account, receipts);
        }
        for (let guard = accounts.size + totalReceipts; totalReceipts > maxTotal && guard > 0; guard--) {
            const first = accounts.entries().next();
            if (first.done)
                break;
            const [account, receipts] = first.value;
            let evicted = false;
            for (const [requestId, receipt] of receipts) {
                if (receipt.pending)
                    continue;
                dropReceipt(account, receipts, requestId);
                evicted = true;
                break;
            }
            if (receipts.size == 0)
                dropAccount(account, receipts);
            else if (!evicted) {
                accounts.delete(account);
                accounts.set(account, receipts);
            }
        }
    }
    function spendBudget(account) {
        if (!rate)
            return;
        const budget = budgetOf?.(account) ?? perMinute;
        if (!Number.isFinite(budget) || budget <= 0)
            return;
        if (rate.sumWeight(account, 60_000) >= budget) {
            throw new Error('command rate limit exceeded — retry later');
        }
        rate.add({ type: account, weight: 1 });
    }
    async function execute(account, command, requestId, input) {
        if (closed)
            throw new Error('command host is closed');
        requiredName(account, 'account');
        requiredName(requestId, 'requestId');
        const run = commands[requiredName(command, 'command')];
        if (typeof run != 'function')
            throw new Error(`unknown command: ${command}`);
        const receipts = accountReceipts(account);
        const previous = receipts.get(requestId);
        if (previous) {
            if (previous.command != command) {
                throw new Error(`requestId was already used for another command: ${previous.command}`);
            }
            duplicates++;
            if (previous.pending) {
                return previous.pending.then(function cloneInFlightAnswer() {
                    return (0, common_1.clone)(previous.result);
                });
            }
            return (0, common_1.clone)(previous.result);
        }
        try {
            spendBudget(account);
        }
        catch (error) {
            if (receipts.size == 0)
                accounts.delete(account);
            throw error;
        }
        executions++;
        const receipt = { command, ts: now() };
        let resolvePending;
        let rejectPending;
        const pending = new Promise(function reserveCommand(resolve, reject) {
            resolvePending = resolve;
            rejectPending = reject;
        });
        receipt.pending = pending;
        receipts.set(requestId, receipt);
        totalReceipts++;
        function ownsReceipt() {
            return !closed && accounts.get(account) == receipts && receipts.get(requestId) == receipt;
        }
        async function runCommandOnce() {
            const result = await run({ account, requestId, command }, input);
            receipt.result = (0, common_1.clone)(result);
            receipt.pending = undefined;
            receipt.ts = now();
            if (line && ownsReceipt()) {
                line.set({ account, requestId, command, ts: receipt.ts, result: (0, common_1.clone)(receipt.result) });
            }
            return result;
        }
        void runCommandOnce().then(resolvePending, rejectPending);
        if (ownsReceipt()) {
            sweep(account, receipts);
            compact();
        }
        try {
            return await pending;
        }
        catch (error) {
            if (ownsReceipt())
                dropReceipt(account, receipts, requestId);
            throw error;
        }
    }
    function adopt(next) {
        line = null;
        accounts.clear();
        totalReceipts = 0;
        if (!next)
            return;
        const records = Object.entries(next.snapshot()).filter((entry) => entry[1] != undefined);
        records.sort(function byCommitTime(a, b) { return a[1].ts - b[1].ts; });
        for (const [lineKey, record] of records) {
            const receipts = accountReceipts(record.account);
            const previous = receipts.get(record.requestId);
            if (previous?.lineKey != undefined)
                next.delete(previous.lineKey);
            else
                totalReceipts++;
            receipts.set(record.requestId, { command: record.command, ts: record.ts, result: record.result, lineKey });
        }
        line = next;
        for (const [account, receipts] of [...accounts])
            sweep(account, receipts);
        compact();
    }
    if (deps.receipts?.line)
        adopt(deps.receipts.line);
    const names = Object.keys(commands);
    function fragment(account) {
        requiredName(account, 'account');
        return (0, command_fragment_1.bindCommandNames)(names, function bindAccountCommand(name) {
            return function boundCommand(requestId, input) {
                return execute(account, name, requestId, input);
            };
        });
    }
    function forwardFragment() {
        return (0, command_fragment_1.bindCommandNames)(names, function bindTrustedCommand(name) {
            return function forwardedCommand(account, requestId, input) {
                return execute(account, name, requestId, input);
            };
        });
    }
    function stats() {
        return { accounts: accounts.size, receipts: totalReceipts, executions, duplicates };
    }
    return {
        execute,
        fragment,
        forwardFragment,
        names,
        stats,
        adopt,
        close() {
            closed = true;
            for (const account of accounts.keys())
                rate?.drop(account);
            accounts.clear();
            totalReceipts = 0;
        },
    };
}
function forwardCommands(deps) {
    function fragment(account) {
        requiredName(account, 'account');
        return (0, command_fragment_1.bindCommandNames)(deps.names, function bindMirrorCommand(name) {
            return function forwardedToAuthority(requestId, input) {
                return Promise.resolve(deps.upstream[name](account, requestId, input));
            };
        });
    }
    return { fragment, names: deps.names };
}
