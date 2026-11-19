#!/usr/bin/env node
/**
 * Replace the bundled spec with the live deployment OpenAPI document while
 * preserving SDK method-name compatibility (issue #13).
 *
 * Strategy:
 * - Routes that exist in BOTH the old route manifest and the live spec (matched
 *   by HTTP method + path) keep their old operationId, so generate-client.ts's
 *   normalizeMethodName reproduces the identical methodName — no breaking
 *   rename for existing consumers.
 * - New live-only routes get synthesized verb-first operationIds in the same
 *   style as the old spec (e.g. POST /api/{appId}/tickets/search/paged →
 *   postAppIdPeopleSearchPaged-style naming).
 * - Old-only routes (removed upstream, e.g. legacy /api/projects/*) are dropped:
 *   that removal is the documented breaking change in issue #13.
 *
 * Usage: pnpm exec tsx ./scripts/parser/update-spec-from-live.ts <live-openapi.json> [old-manifest.json]
 * Writes: src/spec/openapi.yaml (converted live spec)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const [livePath, manifestPathArg] = process.argv.slice(2);
if (!livePath) {
  console.error('Usage: update-spec-from-live.ts <live-openapi.json> [old-manifest.json]');
  process.exit(1);
}

const manifestPath = manifestPathArg ?? path.join(projectRoot, 'src/generated/sdk-route-manifest.json');
const liveSpecPath = path.resolve(projectRoot, livePath);
const outSpecPath = path.join(projectRoot, 'src/spec/openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const VERB_BY_METHOD: Record<(typeof HTTP_METHODS)[number], string> = {
  get: 'get',
  post: 'post',
  put: 'put',
  patch: 'patch',
  delete: 'delete',
};

interface ManifestEntry {
  methodName: string;
  operationId: string;
  path: string;
  httpMethod: string;
}

type Spec = {
  paths: Record<string, Record<string, { operationId?: string } & Record<string, unknown>>>;
};

const oldManifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const live: Spec = JSON.parse(fs.readFileSync(liveSpecPath, 'utf8'));

const compatByRoute = new Map<string, ManifestEntry>();
for (const entry of oldManifest) {
  compatByRoute.set(`${entry.httpMethod} ${entry.path}`, entry);
}

const pascal = (s: string): string =>
  s
    .replace(/[{}]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const synthesizeOperationId = (method: string, pathKey: string): string => {
  const rest = pathKey.replace(/^\/api\//, '');
  return `${VERB_BY_METHOD[method as (typeof HTTP_METHODS)[number]]}${pascal(rest)}`;
};

let kept = 0;
let synthesized = 0;
let removedOld = 0;

const oldRoutes = new Set(oldManifest.map(e => `${e.httpMethod} ${e.path}`));
const liveRoutes = new Set<string>();

for (const [pathKey, pathItem] of Object.entries(live.paths ?? {})) {
  for (const method of HTTP_METHODS) {
    const operation = (pathItem as Record<string, Record<string, unknown>> | undefined)?.[method];
    if (!operation) continue;
    liveRoutes.add(`${method.toUpperCase()} ${pathKey}`);

    const compat = compatByRoute.get(`${method.toUpperCase()} ${pathKey}`);
    if (compat) {
      operation['operationId'] = compat.operationId; // preserve methodName exactly
      (operation as Record<string, unknown>)['x-tdx-domain'] = compat.domain; // preserve domain bucket
      kept += 1;
    } else {
      let candidate = synthesizeOperationId(method, pathKey);
      operation['operationId'] = candidate;
      synthesized += 1;
      void candidate;
    }
  }
}

for (const route of oldRoutes) {
  if (!liveRoutes.has(route)) removedOld += 1;
}

// Collision safety: verify no two live routes resolve to the same operationId.
const seen = new Map<string, string>();
let collisions = 0;
for (const [pathKey, pathItem] of Object.entries(live.paths ?? {})) {
  for (const method of HTTP_METHODS) {
    const op = (pathItem as Record<string, Record<string, unknown>> | undefined)?.[method];
    if (!op) continue;
    const oid = String(op['operationId']);
    const prev = seen.get(oid);
    if (prev) {
      console.error(`COLLISION: operationId ${oid} on ${prev} and ${method} ${pathKey}`);
      collisions += 1;
    }
    seen.set(oid, `${method} ${pathKey}`);
  }
}
if (collisions > 0) process.exit(1);

// Sanitize live-spec quirks that break openapi-typescript (redoc validator):
// 1. `nullable: true` is only valid alongside a `type` — instances without one
//    (including alongside $ref/oneOf) get `nullable` dropped. SDK types widen
//    slightly; runtime behavior is unaffected (validation is zod-side).
// 2. Paths differing only by path-parameter name (live API ambiguity, e.g.
//    /api/people/{uid} vs /api/people/{username}) — redoc rejects them. The
//    variant covered by the old SDK manifest wins; otherwise the first wins.
let nullableDrops = 0;
const sanitizeNullable = (node: unknown): void => {
  if (Array.isArray(node)) {
    node.forEach(sanitizeNullable);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['nullable'] !== undefined && obj['type'] === undefined) {
    delete obj['nullable'];
    nullableDrops += 1;
  }
  for (const value of Object.values(obj)) sanitizeNullable(value);
};

const signatureOf = (p: string): string => p.replace(/\{[^}]+\}/g, '{}');
const winners = new Map<string, string>(); // signature -> winning path key
const losers: string[] = [];
for (const pathKey of Object.keys(live.paths ?? {})) {
  const sig = signatureOf(pathKey);
  const winner = winners.get(sig);
  if (winner === undefined) {
    winners.set(sig, pathKey);
    continue;
  }
  // Keep the variant the old SDK covered (compat), else keep the first.
  const winnerHasCompat = [...compatByRoute.values()].some(e => e.path === winner);
  const candidateHasCompat = [...compatByRoute.values()].some(e => e.path === pathKey);
  if (!winnerHasCompat && candidateHasCompat) {
    winners.set(sig, pathKey);
    losers.push(winner);
  } else {
    losers.push(pathKey);
  }
}
for (const loser of losers) delete live.paths[loser];

// 3. Parameter-level `default` siblings (redoc only allows `default` inside
//    `schema`) — relocated into `schema` when present, dropped otherwise.
let defaultMoves = 0;
for (const pathItem of Object.values(live.paths ?? {})) {
  for (const op of Object.values(pathItem as Record<string, unknown>)) {
    if (op === null || typeof op !== 'object') continue;
    const params = (op as Record<string, unknown>)['parameters'];
    if (!Array.isArray(params)) continue;
    for (const param of params) {
      if (param === null || typeof param !== 'object') continue;
      const p = param as Record<string, unknown>;
      if (p['default'] === undefined) continue;
      const schema = (p['schema'] ??= {}) as Record<string, unknown>;
      if (schema['default'] === undefined) schema['default'] = p['default'];
      delete p['default'];
      defaultMoves += 1;
    }
  }
}

// 4. Path/parameter name mismatches in the live spec (e.g. path declares
//    `{appID}` but the operation names the parameter `appId`) — parameters are
//    renamed to the path's placeholder; missing ones are synthesized.
let paramRenames = 0;
let paramSynth = 0;
for (const [pathKey, pathItem] of Object.entries(live.paths ?? {})) {
  const placeholders = [...pathKey.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  for (const op of Object.values(pathItem as Record<string, unknown>)) {
    if (op === null || typeof op !== 'object') continue;
    const params = (op as Record<string, unknown>)['parameters'];
    if (!Array.isArray(params)) continue;
    const byLower = new Map<string, Record<string, unknown>>();
    for (const param of params) {
      if (param === null || typeof param !== 'object') continue;
      const p = param as Record<string, unknown>;
      if (p['in'] === 'path' && typeof p['name'] === 'string') byLower.set(p['name'].toLowerCase(), p);
    }
    for (const placeholder of placeholders) {
      const match = byLower.get(placeholder.toLowerCase());
      if (match === undefined) {
        (params as unknown[]).push({
          name: placeholder,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
        paramSynth += 1;
      } else if (match['name'] !== placeholder) {
        match['name'] = placeholder;
        paramRenames += 1;
      }
    }
  }
}

sanitizeNullable(live);

fs.mkdirSync(path.dirname(outSpecPath), { recursive: true });
fs.writeFileSync(outSpecPath, yaml.dump(live, { lineWidth: 240, noRefs: true }), 'utf8');

console.log(
  `Spec updated: ${liveRoutes.size} live routes (${kept} compat-named, ${synthesized} synthesized), ${removedOld} old routes dropped, ${nullableDrops} invalid nullable fields dropped, ${losers.length} param-ambiguous paths dropped, ${defaultMoves} parameter defaults relocated, ${paramRenames} parameter names aligned, ${paramSynth} missing path parameters synthesized.`,
);
