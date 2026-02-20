import { CallSite } from "source-map-support";

// Тест обычного Error.stack
console.log("=== ОБЫЧНЫЙ ERROR.STACK ===");
console.log(new Error().stack);

// Тест с prepareStackTrace
console.log("=== PREPARE STACK TRACE ===");
const originalPrepareStackTrace = Error.prepareStackTrace;
Error.prepareStackTrace = (_, stack) => stack;
type MyError= { stack: CallSite[]}
const stack = (new Error() as unknown as MyError).stack;
Error.prepareStackTrace = originalPrepareStackTrace;

console.log("Stack frames:");
for (let i = 0; i < Math.min(stack.length, 3); i++) {
    const frame = stack[i];
    console.log(`Frame[${i}]: ${frame.getFileName()}:${frame.getLineNumber()}:${frame.getColumnNumber()}`);
}