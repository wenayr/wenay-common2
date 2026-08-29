// =====================================================================
// Command token envelope — the end client's principal across hops
// =====================================================================
// Two explicit trust modes exist for a relayed command corridor:
//
//   trusted-mirror (command-host.ts `forwardCommands`) — the relaying node is
//   authenticated by the authority and ASSERTS the end client's account; the
//   authority must fully trust it.
//
//   end-to-end (this file) — every call carries the END client's raw token;
//   the relay copies it opaquely and only the authority resolves it to an
//   account. A compromised relay forges nothing: the worst it can do is replay
//   a call the `(account, requestId)` receipts already de-duplicate.
//
// This layer owns NO cryptography and NO token format: `accountOf` is the
// application's verifier (a `createTokenCodec` verify, a deny-list check, an
// external IdP) and a throw from it rejects the call. Transport authentication
// of the relay itself stays in RPC auth (`doc/RPC-AUTH.md`) — this envelope
// rides inside already-authenticated calls and never replaces it.

import type {CommandFragment, CommandHost, tCommandMap} from './command-host'

/** Per-call envelope: the same fragment shape with the raw token prepended. */
export type CommandTokenFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (token: unknown, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>
}

// ============================================================
// authority side: open the envelope, then execute
// ============================================================

export type VerifyCommandsDeps<Cmds extends tCommandMap> = {
    /** The executing command host; only its execute/names contract is required. */
    host: Pick<CommandHost<Cmds>, 'execute' | 'names'>
    /** Token -> verified account. Throw to reject the call (nothing is committed). */
    accountOf: (token: unknown) => string | Promise<string>
}

/** Authority entry for token-carrying hops: verify EVERY call, never trust the relay. */
export function verifyCommands<Cmds extends tCommandMap>(deps: VerifyCommandsDeps<Cmds>) {
    const {host, accountOf} = deps
    function fragment() {
        const verified = {} as CommandTokenFragment<Cmds>
        for (const name of host.names) {
            verified[name] = async function verifiedCommand(token: unknown, requestId: string, input: any) {
                return host.execute(await accountOf(token), name, requestId, input)
            } as CommandTokenFragment<Cmds>[typeof name]
        }
        return verified
    }
    return {fragment, names: host.names}
}
export type VerifiedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof verifyCommands<Cmds>>

// ============================================================
// relay side: the client-facing shape, token copied opaquely
// ============================================================

export type ForwardCommandsByTokenDeps<Cmds extends tCommandMap> = {
    /** The authority's verifyCommands fragment, usually an RPC proxy. */
    upstream: CommandTokenFragment<Cmds>
    /** Command names to expose; an RPC proxy cannot be enumerated, so they are explicit. */
    names: readonly (keyof Cmds & string)[]
}

/** A relay's per-principal fragment: shape-identical to the authority's, identity never asserted. */
export function forwardCommandsByToken<Cmds extends tCommandMap>(deps: ForwardCommandsByTokenDeps<Cmds>) {
    function fragment(token: unknown) {
        const bound = {} as CommandFragment<Cmds>
        for (const name of deps.names) {
            bound[name] = function forwardedWithToken(requestId: string, input: any) {
                return Promise.resolve(deps.upstream[name](token, requestId, input))
            } as CommandFragment<Cmds>[typeof name]
        }
        return bound
    }
    return {fragment, names: deps.names}
}
export type TokenForwardedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof forwardCommandsByToken<Cmds>>
