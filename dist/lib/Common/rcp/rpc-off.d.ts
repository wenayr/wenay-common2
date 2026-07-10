import { rpcEndCallback } from "./rpc-walk";
export declare const endCallback: typeof rpcEndCallback;
type tThenable<V> = {
    then: Promise<V>['then'];
    catch: Promise<V>['catch'];
    finally: Promise<V>['finally'];
};
export type Off<V = void, X extends object = {}> = (() => void) & tThenable<V> & X;
export declare function makeOff<V, X extends object = {}>(promise: Promise<V>, stop: () => void, extra?: X): Off<V, X>;
export {};
