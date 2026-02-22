export const Pkt = { CALL: 0, RESP: 1, CB: 2, MAP: 3, STRICT: 4, CB_END: 5 } as const;

export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
