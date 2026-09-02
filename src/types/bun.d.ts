/**
 * Ambient types for Bun-runtime globals used by scripts/*.ts and serve.ts.
 *
 * The repo installs `bun` as the runtime but not `@types/bun` (kept lean on
 * purpose); these minimal declarations let `tsc --noEmit` pass without
 * pulling the full Bun type package. Add more members if scripts need them.
 */

declare namespace Bun {
  interface Glob {
    scanSync(options?: { cwd?: string }): Iterable<string>;
  }
  const Glob: { new (pattern: string): Glob };
  interface ShellPromise extends Promise<{ stdout: string }> {
    quiet(): ShellPromise;
    nothrow(): ShellPromise;
  }
  const $: (strings: TemplateStringsArray, ...values: unknown[]) => ShellPromise;
  interface FileBlob extends Blob {
    exists(): Promise<boolean>;
  }
  function file(path: string): FileBlob;
  function sleep(ms: number): Promise<void>;
  const password: {
    hash(
      password: string,
      options?: { algorithm?: "argon2id" | "argon2i" | "argon2d" | "bcrypt" },
    ): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
  interface ServeOptions {
    port: number;
    hostname?: string;
    fetch(req: Request): Response | Promise<Response>;
  }
  function serve(options: ServeOptions): unknown;
}

declare interface ImportMeta {
  /** Absolute path of the containing file's directory (Bun extension). */
  dir: string;
}
