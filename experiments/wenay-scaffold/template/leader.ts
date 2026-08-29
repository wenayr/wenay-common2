// =====================================================================
// Service leader — a thin mapping of the definition onto Scale.createAuthority
// =====================================================================
// TEMPLATE-OWNED: a service author never edits this file. Everything the old
// version of this file hand-wired (~360 lines: replica line, node directory,
// command receipts, end-to-end token verification, replicated deny list,
// gated connection blocks) is the public facade Scale.createAuthority now;
// this factory only maps serviceDefinition + secrets onto its deps and
// retransmits its facets. The DOMAIN arrives as data through deps.definition —
// see ./service.ts, the only author-owned file.
//
// Host boundary (doc/DYNAMIC-RUNTIME.md): this factory owns no env, no
// transports, no process exit. Token CRYPTOGRAPHY stays in THIS host layer —
// the codec is built from the corridor secret and handed down as the
// identity {issue, verify} adapter; the authority owns no crypto and no
// token format. Corridor secrets arrive (or default per-run) as plain
// strings and are returned so the ENTRYPOINT can hand them to node
// processes through env.
//
// TODO(graduation): the '../../../src/...' imports below become the package
// entrypoints ('wenay-common2', 'wenay-common2/server/auth') when this
// template graduates out of the incubator into its own package.

import type {CommandCtx} from '../../../src/Common/command/command-host'
import {createAuthority} from '../../../src/Common/scale/scale-authority'
import {createTokenCodec} from '../../../src/server/auth-token'

// ============================================================
// the definition contract — what the domain module must export
// ============================================================
// The contract lives with its consumer (this host layer); ./service.ts
// validates against it with `satisfies` and stays the source of its own type.

/** What a command sees: the verified account, the request identity, and the STORE. */
export type ServiceCommandCtx<S> = CommandCtx & {state: S}

export type tServiceCommand<S> = {
    /** Throw on bad input BEFORE any effect; a throw commits nothing. */
    validate: (input: any) => void
    /** Mutate ctx.state; the returned value becomes the client's receipt. */
    apply: (ctx: ServiceCommandCtx<S>, input: any) => unknown
}

export type tServiceDefinition<
    S extends Record<string, any> = Record<string, any>,
    Cmds extends Record<string, tServiceCommand<S>> = Record<string, tServiceCommand<S>>,
> = {
    /** Wire identity: every surface is served wrapped under this key. */
    name: string
    /** Replica-line coordinates; nodes must match them to join the line. */
    storeId: string
    originId: string
    initial: S
    commands: Cmds
    /** Read policy: the projection an anonymous reader is served. */
    readerFacet: (state: S) => unknown
}

/** The library command map derived from the definition: validate, then apply on the store. */
type tDomainCommandMap<S extends Record<string, any>, Cmds extends Record<string, tServiceCommand<S>>> = {
    [K in keyof Cmds & string]: (ctx: CommandCtx, input: Parameters<Cmds[K]['apply']>[1]) => ReturnType<Cmds[K]['apply']>
}

// ============================================================
// the leader factory
// ============================================================

export type ServiceLeaderDeps<
    S extends Record<string, any>,
    Cmds extends Record<string, tServiceCommand<S>>,
> = {
    definition: tServiceDefinition<S, Cmds>
    /** Client-reachable origin of the leader process; read lazily (the port binds late). */
    selfUrl: () => string
    /**
     * Corridor secrets; per-run random by default. The ENTRYPOINT pins them
     * from env when node processes must join across leader restarts —
     * cryptography stays a host concern, this layer only consumes the strings.
     */
    secrets?: {nodeToken?: string, tokenSecret?: string}
    log?: (line: string) => void
}

function randomKey(prefix: string) {
    return prefix + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

export function createServiceLeader<
    S extends Record<string, any>,
    Cmds extends Record<string, tServiceCommand<S>>,
>(deps: ServiceLeaderDeps<S, Cmds>) {
    const {definition} = deps
    // per-run trust for node links; the entrypoint hands it to node processes through env
    const nodeToken = deps.secrets?.nodeToken ?? randomKey('node')
    // shared secret of the write corridor: every node verifies client tokens itself
    const tokenSecret = deps.secrets?.tokenSecret ?? randomKey('auth')
    const codec = createTokenCodec({secret: tokenSecret})

    // ============== definition + secrets → authority deps: the WHOLE mapping ==============
    // Validation runs before apply so a refused input never touches the store
    // and the corridor remembers nothing for it (honest retry). ctx.state binds
    // LATE to the authority's own replica store: commands only run after
    // createAuthority has returned.
    function domainCommands() {
        const map = {} as tDomainCommandMap<S, Cmds>
        for (const name of Object.keys(definition.commands) as (keyof Cmds & string)[]) {
            const command = definition.commands[name]
            map[name] = function runDomainCommand(ctx: CommandCtx, input: any) {
                command.validate(input)
                return command.apply({...ctx, state: authority.line.control.store.state}, input)
            } as tDomainCommandMap<S, Cmds>[typeof name]
        }
        return map
    }

    const authority = createAuthority<S, tDomainCommandMap<S, Cmds>>({
        storeId: definition.storeId,
        originId: definition.originId,
        // the old wiring's coordinates, pinned: the row is 'leader' at weight 1 —
        // the leader owns the writes, readers should prefer the nodes
        nodeId: 'leader',
        lineId: definition.name + '-leader',
        initial: definition.initial,
        selfUrl: deps.selfUrl,
        weight: 1,
        commands: domainCommands(),
        limits: {perMinute: 60},
        identity: {
            issue: function issueCodecToken(account: string) {
                return codec.issue({sub: account})
            },
            verify: function verifyCodecToken(presented: unknown) {
                const verdict = codec.verify(presented)
                if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
                return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
            },
        },
        ...(deps.log ? {log: deps.log} : {}),
    })

    // ============== the read policy: the ONE piece the authority does not own ==============
    function readerView() {
        return definition.readerFacet(authority.line.control.store.state)
    }

    /** Participant surface (ungated): the authority block plus the read projection. */
    function browserFragment(account: string) {
        return {...authority.serve.browser(account), view: readerView}
    }

    /** Lean ungated read surface: the leader AS a node, shape-identical to a node's. */
    function readFragment() {
        return {...authority.serve.reader(), view: readerView}
    }

    /** Drain is DATA: the node sees its own row draining and leaves by itself. */
    function drain(nodeId: string) {
        if (nodeId == 'leader') throw new Error('the leader cannot drain itself')
        return {ok: authority.directory.control.drain(nodeId)}
    }

    return {
        /** Per-run corridor secrets; the entrypoint hands them to node processes through env. */
        secrets: {nodeToken, tokenSecret},
        // the authority facets, retransmitted whole — the honest addressing system
        line: authority.line,
        directory: authority.directory,
        identity: authority.identity,
        /** The write corridor; a REST relay serves corridor.byToken() verbatim. */
        corridor: authority.corridor,
        control: {start: authority.start, drain, revoke: authority.identity.revoke, close: authority.close},
        /** Connection surfaces by audience; the entrypoint binds each to its socket key. */
        serve: {
            browserFragment,
            readFragment,
            scaleConnection: authority.serve.connection,
            nodeLinkFragment: authority.serve.nodeLink,
        },
        view: {
            ...authority.view,
            commandNames: authority.corridor.names,
            /** Host-side raw snapshot; wire surfaces serve the readerFacet projection. */
            state: () => authority.line.control.store.state,
            reader: readerView,
        },
    }
}
export type ServiceLeader<
    S extends Record<string, any> = Record<string, any>,
    Cmds extends Record<string, tServiceCommand<S>> = Record<string, tServiceCommand<S>>,
> = ReturnType<typeof createServiceLeader<S, Cmds>>
