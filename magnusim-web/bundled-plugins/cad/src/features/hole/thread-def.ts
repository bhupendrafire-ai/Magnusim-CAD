// The thread feature type (Hole's tapped hole, modelled): the ISO metric internal thread of a
// tapped hole cut into its wall. `hole` names the hole's own cut (an extrude with `thread`); at each
// rebuild the thread reads that cut's sketch (its circles h1, h2...: centres and the tap drill's
// radius), its direction and depth, and the thread's size, so it follows the hole.
// The groove is the basic profile's: 60 deg flanks, a flat P/8 wide at the major diameter, running
// from just inside the hole's wall out to the major diameter. Each hole's groove is one kernel
// loft_regions through that profile in planes round the axis (PER_TURN per turn, each a pitch's
// fraction further along it: a helical sweep), and every hole's groove is cut from the body in one
// boolean. `length` "": the whole hole (a blind one stops a pitch short of its bottom, clear of it;
// a through one runs past its far side), else that far from the face. The body keeps its id; the
// groove's faces are F:<id>:thread:<hole>.<k>.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { faceName } from '../../naming/names';
import { namesFromResult } from '../../naming/result';
import type { ExtrudeFeature, SketchFeature, ThreadFeature, Vec3 } from '../../types/doc';
import type { ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { RegionSection, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { SketchOutput } from '../../types/sketch';
import type { UnitsService } from '../../types/units';
import { toModel } from '../sketch/plane';
import { kernelStep } from '../solids/build';
import { bodyFor } from '../solids/local';

/** Profile planes per turn of the helix (16 holds the groove's volume within 0.2% of a true helix). */
const PER_TURN = 16;
/** The most turns one hole's thread may have (a long fine thread past it is refused with the reason). */
export const THREAD_TURNS_MAX = 120;
/** How far inside the hole's wall the groove starts (a fraction of the pitch), so its cut meets no face edge-on. */
const INSIDE = 0.02;
/** A thread with an outline (24 viewBox): a bolt's shank with its crests. */
export const THREAD_ICON = 'M9 3h6v3H9z M8 6h8 M9 9l6 2 M9 12l6 2 M9 15l6 2 M9 18l6 2 M9 6v15h6V6';

/** The thread's length in mm, or null for the whole hole. */
export interface ThreadValues {
  length: number | null;
}

/** The length's value, or the problem in words. */
export function resolveThread(f: Pick<ThreadFeature, 'length'>, units: UnitsService): ResolveResult<ThreadValues> {
  const t = typeof f.length === 'string' ? f.length.trim() : '';
  if (!t) return { ok: true, values: { length: null } };
  const r = units.evaluate(t, 'length');
  if (!r.ok) return { ok: false, message: `Length: ${r.error}` };
  if (!(r.value > 0)) return { ok: false, message: 'Length must be more than 0' };
  return { ok: true, values: { length: r.value } };
}

/** One hole of the thread: its centre on the face, the direction into the cut, and the sketch's x (where each turn starts). */
interface ThreadHole {
  c: Vec3;
  d: Vec3;
  x: Vec3;
}

/**
 * The groove's profile planes for one hole: the basic profile (r from rIn to R, a P/8 flat at R,
 * 60 deg flanks) in the plane through the axis at each angle, a pitch per turn along it.
 */
function grooveSections(h: ThreadHole, rIn: number, R: number, P: number, turns: number, key: string): RegionSection[] {
  const { c, d, x } = h;
  const y: Vec3 = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
  const crest = P / 8;
  const wIn = crest + 2 * (R - rIn) * Math.tan(Math.PI / 6);
  // In each plane u runs out from the axis and v = normal x u runs against d: a point a along the axis has v = -a.
  const pts: [number, number][] = [
    [rIn, wIn / 2],
    [R, crest / 2],
    [R, -crest / 2],
    [rIn, -wIn / 2],
  ];
  const curves = pts.map((a, j) => ({ id: `t${j}`, kind: 'line' as const, a, b: pts[(j + 1) % 4] }));
  const n = Math.max(2, Math.ceil(turns * PER_TURN));
  const out: RegionSection[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (turns * i) / n;
    const th = 2 * Math.PI * t;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const xdir: Vec3 = [0, 1, 2].map((k) => cs * x[k] + sn * y[k]) as Vec3;
    const normal: Vec3 = [0, 1, 2].map((k) => -sn * x[k] + cs * y[k]) as Vec3;
    const origin: Vec3 = [0, 1, 2].map((k) => c[k] + d[k] * P * t) as Vec3;
    out.push({ plane: { origin, normal, xdir }, curves, regions: [key] });
  }
  return out;
}

export const threadDef: FeatureTypeDef<ThreadFeature, ThreadValues> = {
  type: 'thread',
  label: 'Thread',
  icon: THREAD_ICON,
  create(doc, init = {}) {
    return { id: newId('f'), type: 'thread', name: nextName('Thread', doc.features.map((f) => f.name)), hole: '', body: '', length: '', ...init } as ThreadFeature;
  },
  resolve: (f, units) => resolveThread(f, units),
  incomplete(f, units) {
    if (!f.hole) return 'Pick the tapped hole to thread';
    const r = resolveThread(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => (f.hole ? [f.hole] : []),
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => (f.length ? [{ path: 'length', expr: f.length } as ExprField] : []),
  mapExprs: (f, fn) => (f.length ? { ...f, length: fn(f.length) } : f),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    // ---- the hole: its cut, its thread, its sketch's circles
    const hole = ctx.doc.features.find((g) => g.id === f.hole) as ExtrudeFeature | undefined;
    if (!hole || hole.type !== 'extrude') return { ok: false, message: `${f.name} failed: its tapped hole is gone` };
    const th = hole.thread;
    if (!th) return { ok: false, message: `${f.name} failed: ${hole.name} is not a tapped hole (it has no thread)` };
    const sketchId = hole.profiles[0]?.sketch;
    const sk = ctx.doc.features.find((g) => g.id === sketchId) as SketchFeature | undefined;
    const out = sketchId ? ctx.outputs.get(sketchId) : undefined;
    if (!sk || !out || out.type !== 'sketch') return { ok: false, message: `${f.name} failed: the sketch of ${hole.name} did not build` };
    const so = out as SketchOutput;
    const circles = sk.entities.flatMap((e) => (e.kind === 'circle' && /^h\d+$/.test(e.id) && so.points[e.c] ? [e] : []));
    if (!circles.length) return { ok: false, message: `${f.name} failed: ${hole.name}'s sketch has no hole circles` };
    const rHole = so.radii[circles[0].id] ?? circles[0].r;
    const n = so.plane.normal;
    const d: Vec3 = hole.flip ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
    const holes: ThreadHole[] = circles.map((e) => ({ c: toModel(so.plane, so.points[(e as { c: string }).c]), d, x: so.plane.xdir as Vec3 }));
    const P = th.pitch;
    const R = th.major / 2;
    if (!(R > rHole)) return { ok: false, message: `${f.name} failed: ${th.designation}'s major diameter (${th.major} mm) is not wider than ${hole.name} (${2 * rHole} mm): nothing to cut` };
    const rIn = rHole - INSIDE * P;
    if (R - rIn > 0.75 * P) return { ok: false, message: `${f.name} failed: ${hole.name} (${2 * rHole} mm) is too small for ${th.designation}: its tap drill is ${th.major - P} mm` };

    // ---- the body and how far the thread runs
    const b = bodyFor(f.name, f.body, ctx);
    if (!b.ok) return b;
    const body = b.value;
    let L: number;
    if (hole.extent.kind === 'blind') {
      const depth = ctx.units.evaluate(hole.extent.distance, 'length');
      if (!depth.ok) return { ok: false, message: `${f.name} failed: ${hole.name}'s depth: ${depth.error}` };
      // A blind hole: clear of its bottom by a pitch.
      L = Math.abs(depth.value) - P;
    } else {
      // Through: past the body's far side along the hole (its box), and a pitch more.
      const bb = await ctx.bbox(body.shape);
      const c0 = holes[0].c;
      L = 0;
      for (const cx of [bb[0], bb[3]]) for (const cy of [bb[1], bb[4]]) for (const cz of [bb[2], bb[5]]) L = Math.max(L, (cx - c0[0]) * d[0] + (cy - c0[1]) * d[1] + (cz - c0[2]) * d[2]);
      L += P;
    }
    if (v.length != null) {
      if (v.length > L + 1e-9) return { ok: false, message: `${f.name} failed: a length of ${v.length} mm is more than ${hole.name} allows (${Math.round(L * 1000) / 1000} mm${hole.extent.kind === 'blind' ? ', a pitch short of its bottom' : ''})` };
      L = v.length;
    }
    if (!(L >= P)) return { ok: false, message: `${f.name} failed: ${hole.name} is too shallow for a thread of pitch ${P} mm` };
    const turns = L / P;
    if (turns > THREAD_TURNS_MAX) return { ok: false, message: `${f.name} failed: ${Math.ceil(turns)} turns of ${th.designation} is more than ${THREAD_TURNS_MAX}: give a shorter length` };

    // ---- the grooves, then one cut
    const made: ShapeId[] = [];
    try {
      const probe = grooveSections(holes[0], rIn, R, P, 0, '');
      const regions = await kernelStep(f.name, () => ctx.kernel.call('sketch_regions', { plane: probe[0].plane, curves: probe[0].curves }));
      if (!regions.ok) return regions;
      const key = regions.value.result.regions[0]?.key;
      if (!key) return { ok: false, message: `${f.name} failed: the thread's profile made no region` };
      const tools: { shape: ShapeId; names: FaceNames }[] = [];
      for (const [i, h] of holes.entries()) {
        const lo = await kernelStep(f.name, () => ctx.kernel.call('loft_regions', { sections: grooveSections(h, rIn, R, P, turns, key), ruled: false }));
        if (!lo.ok) return lo;
        made.push(lo.value.result.id);
        if (lo.value.result.valid === false) return { ok: false, message: `${f.name} failed: the thread of hole ${i + 1} is not a valid solid` };
        const count = lo.value.result.faces ?? 0;
        tools.push({ shape: lo.value.result.id, names: { faces: Array.from({ length: count }, (_, k) => faceName(f.id, 'thread', `${i + 1}.${k}`)) } });
      }
      const cut = await kernelStep(f.name, () => ctx.kernel.call('boolean', { op: 'cut', targets: [body.shape], tools: tools.map((t) => t.shape) }));
      if (!cut.ok) return cut;
      const res = cut.value.result;
      if (res.valid === false) {
        await ctx.release([res.id]);
        return { ok: false, message: `${f.name} failed: cutting the thread gave an invalid solid${res.reason ? `: ${res.reason}` : ''}` };
      }
      const names = namesFromResult(f.id, res, new Map<ShapeId, FaceNames | null>([[body.shape, body.names], ...tools.map((t) => [t.shape, t.names] as [ShapeId, FaceNames])]));
      return { ok: true, bodies: [{ id: f.body, shape: res.id, valid: true, names }], removed: [] };
    } finally {
      if (made.length) await ctx.release(made).catch(() => {});
    }
  },
};
