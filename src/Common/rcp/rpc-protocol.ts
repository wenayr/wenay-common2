export const Pkt = { CALL: 0, RESP: 1, CB: 2, MAP: 3, STRICT: 4, CB_END: 5, PIPE: 6 } as const;

// Сентинел конца стрима. Едет ПО ПРОВОДУ первым аргументом колбэка —
// поэтому строка (Symbol через JSON не проедет); значение менять нельзя (wire compat).
export const RPC_STOP = "___STOP";

// Серверная пометка «этот узел — Listen-обёртка» (не путешествует по проводу;
// по проводу сервер декларирует АДРЕСА таких узлов 4-м элементом Pkt.MAP).
export const IS_RPC_LISTEN = Symbol.for("isRpcListen");

export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
