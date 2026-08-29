// =====================================================================
// Scale namespace — the deployment triangle: authority, node, cluster client
// =====================================================================
// createAuthority owns the single point of order, createStoreNode is one
// serving node from config (also exported under Observe — same factory), and
// createClusterClient is one consumer with sticky placement. Hosts keep env,
// transports, crypto and process exit (doc/DYNAMIC-RUNTIME.md boundary).

export * from './scale-authority'
export * from './scale-client'
export * from '../Observe/store-node'
