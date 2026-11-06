// Cosmetic threads in the viewport (layer `hole.threads`, order 35): each tapped hole's thread
// (ExtrudeFeature.thread, set by Hole) drawn as a helix at the thread's major diameter, one turn per
// pitch, faintly through the material, from the hole's sketch plane into the cut, round each of the
// hole's circles (h1, h2...), with its designation ("M6x1") beside the first. The solid is not
// changed. A thread of the hole's whole length ("" length) runs to the far side of the body.
// Reads the document; nobody pushes geometry into it.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { toModel, ydirOf } from '../sketch/plane';
import type { AppServices } from '../../types/app';
import type { ExtrudeFeature, SketchFeature, Vec3 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';
import { paletteOf } from '../../viewport/palette';

export const THREADS_LAYER = 'hole.threads';
/** Segments per turn of the helix, and the most turns drawn per thread (a long fine thread is thinned). */
const PER_TURN = 24;
const TURNS_MAX = 200;

/** One thread as drawn: its feature, where its label goes and its words. */
export interface DrawnThread {
  feature: string;
  designation: string;
  holes: number;
  length: number;
  label: Vec3;
}

/** A helix about `c` along `d` (unit), radius r, pitch p, length L, as segment pairs. */
export function helix(c: Vec3, d: Vec3, x: Vec3, r: number, p: number, L: number): number[] {
  const y: Vec3 = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
  const turns = Math.min(TURNS_MAX, L / p);
  const n = Math.max(2, Math.ceil(turns * PER_TURN));
  const out: number[] = [];
  let prev: Vec3 | null = null;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * L;
    const a = (2 * Math.PI * t) / (L / turns);
    const q: Vec3 = [0, 1, 2].map((k) => c[k] + d[k] * t + r * (Math.cos(a) * x[k] + Math.sin(a) * y[k])) as Vec3;
    if (prev) out.push(...prev, ...q);
    prev = q;
  }
  return out;
}

const overlays = new WeakMap<AppServices, ThreadOverlay>();
/** The app's thread overlay (tests read what it draws). */
export function threadOverlayOf(services: AppServices): ThreadOverlay | null {
  return overlays.get(services) ?? null;
}

export class ThreadOverlay {
  private readonly layer: OverlayLayer;
  private readonly mat: LineMaterial;
  private lines: LineSegments2[] = [];
  private labels: { el: HTMLSpanElement; at: Vec3 }[] = [];
  private readonly offs: (() => void)[] = [];
  private queued = false;
  private run = 0;
  /** What is drawn now. */
  drawn: DrawnThread[] = [];

  constructor(
    private readonly services: AppServices,
    private readonly handle: ViewportHandle,
  ) {
    this.layer = handle.addLayer(THREADS_LAYER, { order: 35, palette: (p) => (this.mat.color.setHex(p.constructLine), this.layer.changed()) });
    this.layer.html.dataset.threadsLayer = '1';
    // Seen through the material (a thread is inside its hole), faint.
    this.mat = new LineMaterial({ color: paletteOf(handle).constructLine, linewidth: 1.4, worldUnits: false, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
    this.offs.push(services.doc.state.subscribe(() => this.later()), handle.onFrame(() => this.place()));
    overlays.set(services, this);
    this.later();
  }

  private later(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.sync();
    });
  }

  /** Each thread's helices from the document as built now. */
  private async sync(): Promise<void> {
    const run = ++this.run;
    const s = this.services.doc.state.get();
    const found: { f: ExtrudeFeature; holes: { c: Vec3; d: Vec3; x: Vec3 }[]; length: number | null; body: string | null }[] = [];
    for (const g of s.doc.features) {
      if (g.type !== 'extrude' || !g.thread || g.suppressed) continue;
      const f = g as ExtrudeFeature;
      const st = s.rebuild.features[f.id]?.state;
      if (st !== 'ok' && st !== 'warning') continue;
      const sketchId = f.profiles[0]?.sketch;
      const sk = s.doc.features.find((x) => x.id === sketchId) as SketchFeature | undefined;
      const out = sketchId ? (s.rebuild.outputs[sketchId] as SketchOutput | undefined) : undefined;
      if (!sk || !out || out.type !== 'sketch') continue;
      const n = out.plane.normal;
      const d: Vec3 = f.flip ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
      const x = out.plane.xdir as Vec3;
      const holes = sk.entities.filter((e) => e.kind === 'circle' && /^h\d+$/.test(e.id) && out.points[(e as { c: string }).c]).map((e) => ({ c: toModel(out.plane, out.points[(e as { c: string }).c]), d, x }));
      if (!holes.length) continue;
      const len = f.thread!.length ? this.services.doc.units.evaluate(f.thread!.length, 'length') : null;
      found.push({ f, holes, length: len && len.ok ? len.value : null, body: f.scope[0] ?? null });
    }
    // A thread of the hole's whole length runs to the far side of its body (its box along the hole).
    const drawn: { f: ExtrudeFeature; holes: { c: Vec3; d: Vec3; x: Vec3 }[]; length: number }[] = [];
    for (const t of found) {
      let L = t.length;
      if (L == null) {
        const b = s.rebuild.bodies.find((x) => x.id === t.body);
        if (!b) continue;
        try {
          const r = await this.services.kernel.call('props', { id: b.shape, bbox: 'fast' });
          const bb = r.result.bbox;
          if (!bb) continue;
          const c = t.holes[0].c;
          const d = t.holes[0].d;
          L = 0;
          for (const cx of [bb[0], bb[3]]) for (const cy of [bb[1], bb[4]]) for (const cz of [bb[2], bb[5]]) L = Math.max(L, (cx - c[0]) * d[0] + (cy - c[1]) * d[1] + (cz - c[2]) * d[2]);
        } catch {
          continue;
        }
        if (run !== this.run) return;
      }
      if (L > 0) drawn.push({ f: t.f, holes: t.holes, length: L });
    }
    if (run !== this.run) return;
    this.draw(drawn);
  }

  private draw(list: { f: ExtrudeFeature; holes: { c: Vec3; d: Vec3; x: Vec3 }[]; length: number }[]): void {
    this.clear();
    for (const t of list) {
      const th = t.f.thread!;
      const pos: number[] = [];
      for (const h of t.holes) pos.push(...helix(h.c, h.d, h.x, th.major / 2, th.pitch, t.length));
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pos);
      const line = new LineSegments2(geo, this.mat);
      line.renderOrder = 35;
      this.layer.group.add(line);
      this.lines.push(line);
      // The label just outside the first hole's mouth.
      const h0 = t.holes[0];
      const y = ydirOf({ origin: h0.c, normal: h0.d, xdir: h0.x });
      const at: Vec3 = [0, 1, 2].map((k) => h0.c[k] + (th.major * 0.75) * (h0.x[k] + y[k]) * Math.SQRT1_2) as Vec3;
      const el = this.layer.html.ownerDocument.createElement('span');
      el.className = 'cad-thread-label';
      el.dataset.thread = t.f.name;
      el.textContent = th.designation;
      el.style.cssText = 'position:absolute;font:11px/1.2 system-ui,sans-serif;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.85);color:#333;pointer-events:none;white-space:nowrap;transform:translate(4px,-50%)';
      this.layer.html.appendChild(el);
      this.labels.push({ el, at });
      this.drawn.push({ feature: t.f.name, designation: th.designation, holes: t.holes.length, length: t.length, label: at });
    }
    this.layer.changed();
  }

  private place(): void {
    if (!this.lines.length) return;
    const [rw, rh] = this.handle.lineResolution();
    this.mat.resolution.set(rw, rh);
    for (const l of this.labels) {
      const p = this.handle.project(l.at);
      l.el.style.display = p ? '' : 'none';
      if (p) {
        l.el.style.left = `${p[0]}px`;
        l.el.style.top = `${p[1]}px`;
      }
    }
  }

  private clear(): void {
    for (const l of this.lines) {
      this.layer.group.remove(l);
      l.geometry.dispose();
    }
    for (const l of this.labels) l.el.remove();
    this.lines = [];
    this.labels = [];
    this.drawn = [];
  }

  dispose(): void {
    this.run++;
    for (const off of this.offs.splice(0)) off();
    this.clear();
    this.mat.dispose();
    this.layer.dispose();
    overlays.delete(this.services);
  }
}

/** Keep a thread overlay on whichever viewport the app has. Returns the uninstall. */
export function installThreads(services: AppServices): () => void {
  let handle: ViewportHandle | null = null;
  let overlay: ThreadOverlay | null = null;
  const attach = (next: ViewportHandle | null) => {
    if (next === handle) return;
    overlay?.dispose();
    overlay = null;
    handle = next;
    if (!handle || typeof handle.addLayer !== 'function') return;
    overlay = new ThreadOverlay(services, handle);
  };
  attach(services.viewport.get().handle);
  const off = services.viewport.subscribe((st) => attach(st.handle));
  return () => {
    off();
    attach(null);
  };
}
