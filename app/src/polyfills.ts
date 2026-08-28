/** Must be the FIRST import of the entry module: dependency chunks (anchor,
 * pump-sdk) reference Buffer at module-evaluation time. */
import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
