export type TokenClaims = {
    sub: string;
    exp: number;
    jti: string;
} & {
    [claim: string]: unknown;
};
export type IssueClaims = {
    sub: string;
};
export type tTokenFailure = 'malformed' | 'signature' | 'expired';
export type tTokenVerdict = {
    ok: true;
    claims: TokenClaims;
} | {
    ok: false;
    reason: tTokenFailure;
};
type tHmacCreator = (algorithm: string, key: string) => {
    update: (data: string) => {
        digest: (encoding: 'hex') => string;
    };
};
export type TokenCodecDeps = {
    secret: string;
    ttlMs?: number;
    hmac?: tHmacCreator;
    now?: () => number;
};
export declare function createTokenCodec(deps: TokenCodecDeps): {
    issue: <T extends IssueClaims>(claims: T, options?: {
        ttlMs?: number;
    }) => string;
    verify: (token: unknown) => tTokenVerdict;
};
export type TokenCodec = ReturnType<typeof createTokenCodec>;
export {};
