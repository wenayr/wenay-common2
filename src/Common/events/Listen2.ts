// Compatibility entrypoint for the ./listen2 package subpath.
// Keep this thin so Listen, Listen2, and Listen3 share one identity registry.
export * from "./Listen3"
