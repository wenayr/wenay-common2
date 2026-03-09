
import console_ from "console";

declare global {
    // @ts-ignore
    var console : typeof console_; //Awaited<typeof import("console")> //
}