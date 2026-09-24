"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceLeader = createServiceLeader;
const crypto_1 = require("crypto");
const scale_authority_1 = require("../Common/scale/scale-authority");
const funcTimeWait_1 = require("../Common/funcTimeWait");
const store_1 = require("../Common/Observe/store");
const auth_token_1 = require("../server/auth-token");
const access_1 = require("./access");
const input_schema_1 = require("./input-schema");
const Listen_1 = require("../Common/events/Listen");
const resource_session_1 = require("./resource-session");
const resource_budget_1 = require("./resource-budget");
const rpc_scope_1 = require("../Common/rcp/rpc-scope");
const definition_1 = require("./definition");
function randomKey(prefix) {
    return prefix + '-' + (0, crypto_1.randomBytes)(32).toString('base64url');
}
function createServiceLeader(deps) {
    const { definition } = deps;
    (0, resource_budget_1.resourceBudgets)(deps.resourceOptions);
    for (const resource of Object.values(definition.resources ?? {})) {
        if (resource.placement != 'authority')
            throw new Error('Only authority resource placement is supported');
    }
    const commands = definition.commands;
    const initial = (0, store_1.cloneStoreValue)(definition.initial);
    const nodeToken = deps.secrets?.nodeToken ?? randomKey('node');
    const tokenSecret = deps.secrets?.tokenSecret ?? randomKey('auth');
    const codec = (0, auth_token_1.createTokenCodec)({ secret: tokenSecret });
    function rolesOf(account) {
        if (account == definition_1.SYSTEM_ACCOUNT)
            return ['system'];
        return definition.access?.rolesOf?.(authority.line.control.store.snapshot(), account) ?? [];
    }
    const commandWindows = (0, funcTimeWait_1.createRateWindow)();
    function domainCommands() {
        const map = {};
        for (const name of Object.keys(commands)) {
            const command = commands[name];
            const schemaValidate = command.input ? (0, input_schema_1.buildInputValidate)(command.input) : null;
            map[name] = function runDomainCommand(ctx, input) {
                const roles = rolesOf(ctx.account);
                if (command.allow && !command.allow.some(role => roles.includes(role))) {
                    throw new Error(`forbidden: ${name} needs one of: ${command.allow.join(', ')}`);
                }
                if (command.limit && ctx.account != definition_1.SYSTEM_ACCOUNT) {
                    const key = ctx.account + ':' + name;
                    if (commandWindows.sumWeight(key, 60_000) >= command.limit.perMinute) {
                        throw new Error(`rate limit: ${name} allows ${command.limit.perMinute} per minute — retry later`);
                    }
                    commandWindows.add({ type: key, weight: 1 });
                }
                schemaValidate?.(input);
                command.validate?.(input);
                return command.apply({ ...ctx, roles, state: authority.line.control.store.state }, input);
            };
        }
        return map;
    }
    const authority = (0, scale_authority_1.createAuthority)({
        line: {
            storeId: definition.storeId,
            originId: definition.originId,
            nodeId: 'leader',
            lineId: definition.name + '-leader',
            initial,
            ...(deps.durable ? { durable: deps.durable } : {}),
        },
        ...(deps.durableControl ? { control: { durable: deps.durableControl } } : {}),
        roster: { url: deps.selfUrl, weight: 1 },
        corridor: {
            commands: domainCommands(),
            limits: { perMinute: definition.limits?.perMinute ?? 60, budgetOf: account => account == definition_1.SYSTEM_ACCOUNT ? Infinity : definition.limits?.perMinute ?? 60 },
        },
        identity: {
            issue: function issueCodecToken(account) {
                return codec.issue({ sub: account });
            },
            verify: function verifyCodecToken(presented) {
                const verdict = codec.verify(presented);
                if (!verdict.ok)
                    throw new Error('token rejected: ' + verdict.reason);
                if (verdict.claims.sub == definition_1.SYSTEM_ACCOUNT)
                    throw new Error('token rejected: reserved account');
                return { account: verdict.claims.sub, expiresAt: verdict.claims.exp };
            },
        },
        ...(deps.log ? { log: deps.log } : {}),
    });
    try {
        const store = authority.line.control.store;
        const version = definition.version ?? 1;
        const restored = authority.view.restored();
        const archived = store.state['$version'];
        if (restored?.fromArchive && (archived ?? 1) < version) {
            if (!definition.migrate) {
                throw new Error(`${definition.name}: the archive is at schema version ${archived ?? 1}, the definition at ${version}, and no migrate() is declared`);
            }
            const next = (0, store_1.cloneStoreValue)(definition.migrate(store.snapshot(), archived ?? 1));
            const state = store.state;
            for (const key of Object.keys(state))
                if (!(key in next) && key != '$version')
                    delete state[key];
            for (const [key, value] of Object.entries(next))
                if (key != '$version')
                    state[key] = value;
            state['$version'] = version;
            deps.log?.(`${definition.name}: migrated the archive from schema version ${archived ?? 1} to ${version}`);
        }
        else if (archived == undefined) {
            store.state['$version'] = version;
        }
    }
    catch (error) {
        try {
            authority.close();
        }
        catch { }
        throw error;
    }
    const access = (0, access_1.createServiceAccess)({ definition, store: authority.line.control.store });
    const [emitResourceError, resourceErrors] = (0, Listen_1.listen)();
    const resourceConnections = new Set();
    function resourceConnection() {
        const owned = (0, resource_session_1.createResourceSession)({ registry: definition.resources ?? {}, options: deps.resourceOptions,
            principalOf: access.principalOf,
            changes: callback => authority.line.control.store.on(callback), report: emitResourceError,
        });
        const link = authority.serve.connection({ principal: owned.update });
        let completion;
        function close() {
            if (completion)
                return completion;
            completion = owned.close();
            link.close();
            resourceConnections.delete(connection);
            return completion;
        }
        const hooks = (0, rpc_scope_1.inheritRpcScopes)(owned.hooks, { onDispose() { void close().catch(function observed() { }); } });
        function attach(control) {
            link.attach({ ...control, revoke(...args) {
                    owned.suspend();
                    return control.revoke(...args);
                } });
        }
        const connection = { ...link, hooks, attach, close };
        resourceConnections.add(connection);
        return connection;
    }
    function closeResources() {
        const work = [...resourceConnections].map(connection => connection.close());
        return Promise.allSettled(work).then(function finished(results) {
            const errors = results.filter(result => result.status == 'rejected').map(result => result.reason);
            if (errors.length)
                throw new AggregateError(errors, 'Service resources cleanup failed');
        });
    }
    function readerView() {
        return definition.readerFacet?.(authority.line.control.store.state);
    }
    const legacyView = (definition.readerFacet ? { view: readerView } : {});
    function loginWith(credentials) {
        const login = definition.access?.login;
        if (!login)
            throw new Error('this service has no credential login');
        (0, input_schema_1.buildInputValidate)(login.input)(credentials);
        const account = login.resolve(authority.line.control.store.snapshot(), credentials);
        if (!account || account == definition_1.SYSTEM_ACCOUNT)
            throw new Error('login refused');
        return authority.identity.login(account);
    }
    function signupWith(requestId, input) {
        const signup = definition.access?.signup;
        if (!signup)
            throw new Error('this service has no signup');
        (0, input_schema_1.buildInputValidate)(signup.input)(input);
        return authority.corridor.execute(definition_1.SYSTEM_ACCOUNT, signup.command, requestId, input);
    }
    function browserFragment(_account) {
        const { identity: { renew }, ...base } = authority.serve.browser('anonymous');
        const identity = definition.access?.login
            ? { login: loginWith, renew, ...(definition.access.signup ? { signup: signupWith } : {}) }
            : { renew };
        const views = access.publicViews();
        if (views)
            return { roster: base.roster, identity, views, ...legacyView };
        return { ...base, identity, ...legacyView };
    }
    function readFragment() {
        const views = access.publicViews();
        if (views)
            return { views, ...legacyView };
        return { ...authority.serve.reader(), ...legacyView };
    }
    function scaleConnection() {
        return authority.serve.connection({ principal: access.principal });
    }
    function drain(nodeId) {
        if (nodeId == 'leader')
            throw new Error('the leader cannot drain itself');
        return { ok: authority.roster.control.drain(nodeId) };
    }
    return {
        secrets: { nodeToken, tokenSecret },
        line: authority.line,
        roster: authority.roster,
        identity: authority.identity,
        corridor: { ...authority.corridor, system: authority.corridor.fragment(definition_1.SYSTEM_ACCOUNT) },
        access,
        resources: { errors: resourceErrors },
        control: { start: authority.start, drain, revoke: authority.identity.revoke, close() {
                const finished = closeResources();
                access.close();
                authority.close();
                void finished.catch(function observed() { });
                return finished;
            } },
        serve: {
            browserFragment,
            readFragment,
            scaleConnection,
            resourceConnection,
            nodeLinkFragment: authority.serve.nodeLink,
            login: loginWith,
            signup: signupWith,
        },
        view: {
            ...authority.view,
            commandNames: authority.corridor.names,
            state: () => authority.line.control.store.state,
            reader: readerView,
        },
    };
}
