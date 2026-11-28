/**
 * `@bindTool(def)`: TC39 stage-3 class decorator associating a `ToolDefinition` with a `ToolImpl`
 * class. Different implementations of the same tool (`CloudBashTool` / `LocalBashTool`) can each
 * use `@bindTool(BashToolDef)`.
 *
 * `toRuntimeTool(instance)`: Converts a decorated class instance to a `RuntimeTool`; PiTurnRunner
 * accepts `RuntimeTool[]`.
 *
 * Decorator timing: TC39 stage-3 decorators run during class evaluation, so `CLASS_TO_DEF.set`
 * completes when the decorated class's file is imported. `toRuntimeTool` can find the definition
 * any time after instantiation.
 */

import type { TSchema } from '@sinclair/typebox';

import type { RuntimeTool, ToolDefinition, ToolExecutionContext, ToolImpl } from './types.js';

// eslint-disable-next-line @typescript-eslint/ban-types
const CLASS_TO_DEF = new WeakMap<Function, ToolDefinition>();

/**
 * Class decorator associating a `ToolDefinition` with a `ToolImpl<S, TCtx>` implementation class.
 *
 * ```ts
 * @bindTool(BashToolDef)
 * export class CloudBashTool implements ToolImpl<typeof BashToolDef.schema, CloudRuntimeContext> {
 *   async execute(ctx, input) { ... }   // input is inferred as Static<typeof BashToolDef.schema>
 * }
 * ```
 */
export function bindTool<S extends TSchema>(def: ToolDefinition<S>) {
  return function <
    TCtx extends ToolExecutionContext,
    C extends new (...args: never[]) => ToolImpl<S, TCtx>,
  >(target: C, _context: ClassDecoratorContext<C>): C {
    // eslint-disable-next-line @typescript-eslint/ban-types
    CLASS_TO_DEF.set(target as Function, def as ToolDefinition);
    return target;
  };
}

/**
 * Converts a decorated class instance to a `RuntimeTool`. Throws for undecorated classes:
 * forgetting `@bindTool` is a programming error and must not silently degrade.
 */
export function toRuntimeTool<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
>(instance: ToolImpl<S, TCtx>): RuntimeTool<S, TCtx> {
  const def = CLASS_TO_DEF.get(instance.constructor) as ToolDefinition<S> | undefined;
  if (!def) {
    throw new Error(
      `toRuntimeTool: ${instance.constructor.name} is missing the @bindTool(...) decorator`,
    );
  }
  return { def, impl: instance };
}
