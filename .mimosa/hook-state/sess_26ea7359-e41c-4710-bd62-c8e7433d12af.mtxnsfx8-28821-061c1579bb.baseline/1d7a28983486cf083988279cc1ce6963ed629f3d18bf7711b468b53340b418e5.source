/**
 * Out-of-tree ambient types for the DSH APIs this surface touches directly.
 * Runtime implementations come from the installed `@deepseek-ai/*` packages
 * in the active profile — these declarations only keep `tsc` honest locally.
 * Service shapes live structurally in `src/core/types.ts`, which is what the
 * surface programs against for cross-release tolerance.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    get(name: string): any
    on(event: string, listener: (...args: any[]) => unknown, options?: any): () => void
    effect(fn: () => unknown): void
    provide(name: string, value: unknown): void
    [key: string]: any
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T> {
    default(value: T): Schema<T>
    required(): Schema<T>
  }
  export interface Z {
    string(): Schema<string>
    boolean(): Schema<boolean>
    object<T = any>(shape: Record<string, Schema<any>>): Schema<T>
  }
  const z: Z
  export default z
}
