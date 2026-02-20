
import console_ from "console";

declare global {
    var console : typeof console_; //Awaited<typeof import("console")> //
}