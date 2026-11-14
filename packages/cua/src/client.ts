/**
 * The seam between the engine and Cua Driver: one `call(tool, args)` over the
 * in-process runtime `@trycua/cua-driver` loads, and nothing else. The
 * surface programs against this interface, so unit tests script it without
 * the native library or a Windows desktop, and a daemon-backed client
 * (`CuaDriver.connect`) can replace it without touching the engine.
 */

/** One image Cua Driver attached to a tool result. */
export interface DriverImage {
  readonly mimeType: string;
  readonly dataBase64: string;
}

/** The part of Cua Driver's `ToolResult` the engine reads. */
export interface DriverToolResult {
  readonly text: string;
  readonly images: readonly DriverImage[];
  /** JSON of the tool's `structuredContent`, when the tool produced one. */
  readonly structuredJson?: string | undefined;
  readonly isError: boolean;
  readonly errorCode?: string | undefined;
}

/** What the engine needs from Cua Driver. */
export interface DriverClient {
  /** Runs one Cua Driver tool by its MCP name with JSON arguments. */
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<DriverToolResult>;
  /** Stops accepting operations and releases the native handle. Idempotent. */
  shutdown(): Promise<void>;
}

/** Mints the client for one worker; the seam unit tests script. */
export type ClientFactory = () => DriverClient;

interface NativeDriver {
  callTool(name: string, argumentsJson: string, options?: { signal: AbortSignal }): Promise<DriverToolResult>;
  shutdown(options?: { signal: AbortSignal }): Promise<void>;
  uniffiDestroy?(): void;
}

/**
 * The production client: a same-process Cua Driver runtime, created on the
 * first call, so loading the config never loads the native library and a
 * host without one fails inside `init`, where the runner reports it as
 * infrastructure.
 */
export function createDriverClient(): DriverClient {
  let driver: Promise<NativeDriver> | undefined;
  let closed = false;
  const open = (): Promise<NativeDriver> => {
    driver ??= import('@trycua/cua-driver').then((sdk) => sdk.CuaDriver.create(undefined) as unknown as NativeDriver);
    return driver;
  };
  return {
    async call(name, args, signal) {
      if (closed) throw new Error('the Cua Driver client is shut down');
      const runtime = await open();
      return runtime.callTool(name, JSON.stringify(args), { signal });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (driver === undefined) return;
      const runtime = await driver.catch(() => undefined);
      driver = undefined;
      if (runtime === undefined) return;
      try {
        await runtime.shutdown();
      } finally {
        runtime.uniffiDestroy?.();
      }
    },
  };
}

/** Parses a tool result's structured content; an empty object when the tool produced none. */
export function structured(result: DriverToolResult): Record<string, unknown> {
  if (result.structuredJson === undefined || result.structuredJson === '') return {};
  try {
    const parsed: unknown = JSON.parse(result.structuredJson);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
