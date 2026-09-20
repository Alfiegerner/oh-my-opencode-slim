import { AGENT_ALIASES } from './constants';
import type {
  AgentOverrideConfig,
  Preset,
  PresetDefinition,
  PresetInput,
} from './schema';
import { PresetAgentsSchema } from './schema';

/** Recursively merge JSON objects; arrays and scalar values are replaced. */
export function deepMerge<T extends Record<string, unknown>>(
  base?: T,
  override?: T,
): T | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      typeof overrideVal === 'object' &&
      overrideVal !== null &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Merge agent layers while preserving the explicit model inheritance policy.
 * A missing model normally keeps the lower layer's model, while
 * `inheritModelFrom` intentionally clears it for later model resolution.
 */
export function mergeAgentOverrides(
  base: Record<string, AgentOverrideConfig>,
  override: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const canonicalBase = canonicalizeAgentAliases(base);
  const canonicalOverride = canonicalizeAgentAliases(override);
  const merged = deepMerge(canonicalBase, canonicalOverride) ?? canonicalBase;
  // Alias fields are merged first, so an alias model can temporarily appear
  // beside a canonical inheritModelFrom directive. Remember that directive
  // from the original layer before clearing the inherited model below.
  const canonicalInheritanceDirectives = new Set(
    Object.entries(override)
      .filter(([name]) => {
        const canonicalName = AGENT_ALIASES[name] ?? name;
        const canonicalValue = override[canonicalName];
        return (
          canonicalName !== name &&
          canonicalValue?.model === undefined &&
          canonicalValue?.inheritModelFrom !== undefined
        );
      })
      .map(([name]) => AGENT_ALIASES[name] ?? name),
  );
  for (const [name, agentOverride] of Object.entries(canonicalOverride)) {
    if (
      !canonicalInheritanceDirectives.has(name) &&
      (agentOverride.model !== undefined ||
        agentOverride.inheritModelFrom === undefined)
    ) {
      continue;
    }
    const entry = merged[name];
    if (entry) {
      const updatedEntry = { ...entry };
      delete updatedEntry.model;
      merged[name] = updatedEntry;
    }
  }
  return merged;
}

/**
 * Collapse legacy agent aliases before merging fields. The canonical record is
 * applied second, so it wins field-by-field while fields that only exist on
 * the alias remain available. This also prevents alias keys from being
 * mistaken for custom agents by downstream consumers.
 */
function canonicalizeAgentAliases(
  agents: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const result: Record<string, AgentOverrideConfig> = {};

  for (const [name, override] of Object.entries(agents)) {
    const canonicalName = AGENT_ALIASES[name] ?? name;
    if (canonicalName === name) {
      result[name] = deepMerge(result[name], override) as AgentOverrideConfig;
      continue;
    }

    result[canonicalName] = deepMerge(
      result[canonicalName],
      override,
    ) as AgentOverrideConfig;
  }

  // Canonical keys are authoritative when both forms are present. Process
  // them after aliases regardless of their insertion order.
  for (const name of Object.keys(agents)) {
    if (AGENT_ALIASES[name] === undefined) continue;
    const canonicalName = AGENT_ALIASES[name];
    if (!Object.hasOwn(agents, canonicalName)) continue;
    result[canonicalName] = deepMerge(
      result[canonicalName],
      agents[canonicalName],
    ) as AgentOverrideConfig;
  }

  return result;
}

/** Error raised when a selected preset cannot be resolved completely. */
export class PresetResolutionError extends Error {
  readonly kind: 'missing-parent' | 'cycle';
  readonly chain: readonly string[];

  constructor(kind: 'missing-parent' | 'cycle', chain: readonly string[]) {
    const message =
      kind === 'missing-parent'
        ? chain.length > 1
          ? `Preset "${chain[chain.length - 2]}" extends missing preset "${chain[chain.length - 1]}" (chain: ${chain.join(' -> ')})`
          : `Preset "${chain[0]}" was not found`
        : `Preset inheritance cycle detected: ${chain.join(' -> ')}`;
    super(message);
    this.name = 'PresetResolutionError';
    this.kind = kind;
    this.chain = chain;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert every accepted external syntax to one canonical representation. */
export function normalizePreset(input: PresetInput): PresetDefinition {
  if (isRecord(input) && isRecord(input.agents)) {
    const isPresetAgentMap = PresetAgentsSchema.safeParse(input.agents);
    if (isPresetAgentMap.success) {
      const { agents, extends: parent, ...inlineEntries } = input;
      const normalized: PresetDefinition = {
        agents: deepMerge(inlineEntries as Preset, agents as Preset) as Preset,
      };
      if (typeof parent === 'string') {
        normalized.extends = parent;
      }
      return normalized;
    }
  }

  const record = input as Record<string, unknown>;
  const hasParent = typeof record.extends === 'string';
  const agentEntries = hasParent
    ? Object.fromEntries(
        Object.entries(record).filter(([name]) => name !== 'extends'),
      )
    : record;
  const normalized: PresetDefinition = {
    agents: agentEntries as Preset,
  };
  if (hasParent) {
    normalized.extends = record.extends as string;
  }
  return normalized;
}

export type PresetMap = Record<string, PresetInput>;
export type ResolvedPresetMap = Record<string, Preset>;

/**
 * Resolve one named preset with depth-first traversal.
 *
 * The cache is populated only after a complete ancestor chain is resolved, so
 * callers never receive a partially selected preset after an error.
 */
export function resolvePreset(name: string, presets: PresetMap): Preset {
  const cache = new Map<string, Preset>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (current: string): Preset => {
    const cached = cache.get(current);
    if (cached) return cached;

    const definition = presets[current];
    if (!definition) {
      throw new PresetResolutionError('missing-parent', [...stack, current]);
    }
    if (visiting.has(current)) {
      const cycleStart = stack.indexOf(current);
      throw new PresetResolutionError('cycle', [
        ...stack.slice(cycleStart),
        current,
      ]);
    }

    visiting.add(current);
    stack.push(current);
    const normalized = normalizePreset(definition);
    const parent = normalized.extends
      ? visit(normalized.extends)
      : ({} as Preset);
    const resolved = mergeAgentOverrides(parent, normalized.agents);
    stack.pop();
    visiting.delete(current);
    cache.set(current, resolved);
    return resolved;
  };

  return visit(name);
}

/** Resolve all named presets atomically. */
export function resolvePresets(presets: PresetMap): ResolvedPresetMap {
  const resolved: ResolvedPresetMap = {};
  for (const name of Object.keys(presets)) {
    resolved[name] = resolvePreset(name, presets);
  }
  return resolved;
}
