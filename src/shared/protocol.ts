/**
 * Zero-dependency wire constants shared by the Host debugger routes and the
 * browser half. Keeping them out of the Host modules lets the client bundle
 * import the paths without pulling any Host dependency into the bundle.
 *
 * The debugger rides the shared `/api` carrier as exact Fetch routes: the
 * Connection plugin mounts that prefix, applies its Host/Origin fence and
 * browser authentication, and dispatches our paths before its Remote fallback.
 */

/** Exact route returning the full read-only debugger snapshot. */
export const DOG_DEBUG_SNAPSHOT_PATH = '/api/dog/snapshot'
/** Exact route returning one goal's bounded runtime trace. */
export const DOG_RUNTIME_TRACE_PATH = '/api/dog/goal-runtime'
