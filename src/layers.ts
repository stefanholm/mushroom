import fs from "node:fs/promises";
import path from "node:path";
import { fromFile, type GeoTIFFImage } from "geotiff";
import proj4 from "proj4";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);

export function toSWEREF(lon: number, lat: number): [number, number] {
  const out = proj4("EPSG:4326", "EPSG:3006", [lon, lat]);
  return [out[0], out[1]];
}

export type RasterEntry = {
  id: string;
  file: string;
  nodata?: number;
  band?: number;
  recode?: Record<string, string>;
  // Extra GeoTIFF-filer (t.ex. patches/<fil>__patchA.tif) som täcker andra områden än huvudfilen.
  // Mosaic: huvudfilen frågas först, sedan patcharna i ordning. Patcharna får INTE överlappa varandra.
  patches?: string[];
};

export type VectorEntry = { id: string; file: string; crs?: string };

export type Manifest = {
  crs?: string;
  rasters?: RasterEntry[];
  vectors?: VectorEntry[];
  mask?: {
    file: string;
    forestClasses: number[];
    dilatePx?: number;
    dilateClasses?: number[];
    waterClasses?: number[];
    waterBufferM?: number;
    patches?: string[];
  };
};

export class MaskLayer {
  private allowed: Uint8Array | null = null;
  private block = 1; // >1 = masken är nedprovad till block (hela Sverige får inte plats i minnet annars)
  private gridW = 0;
  private gridH = 0;
  constructor(
    private image: GeoTIFFImage,
    readonly originX: number,
    readonly originY: number,
    readonly pixelX: number,
    readonly pixelY: number,
    private forestClasses: Set<number>,
    private dilatePx: number,
    private dilateClasses: Set<number>,
    private waterClasses: Set<number>,
    private waterBufferM: number,
  ) {
    this.gridW = this.width;
    this.gridH = this.height;
  }

  static async load(
    file: string,
    forestClasses: number[],
    dilatePx = 3,
    dilateClasses: number[] = [51, 52, 53, 54],
    waterClasses: number[] = [61, 62],
    waterBufferM = 50,
  ): Promise<MaskLayer> {
    const tiff = await fromFile(file);
    const image = await tiff.getImage();
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    if (!origin || !resolution) throw new Error(`${file}: saknar geotransform`);
    return new MaskLayer(
      image,
      origin[0],
      origin[1],
      resolution[0],
      resolution[1],
      new Set(forestClasses),
      dilatePx,
      new Set(dilateClasses),
      new Set(waterClasses),
      waterBufferM,
    );
  }

  get width(): number {
    return this.image.getWidth();
  }
  get height(): number {
    return this.image.getHeight();
  }

  // Test-patchar (andra områden än huvudmasken) — samma gränssnitt, frågas efter huvudmasken.
  private patchMasks: MaskLayer[] = [];
  addPatch(m: MaskLayer): void {
    this.patchMasks.push(m);
  }
  private covers(easting: number, northing: number): boolean {
    const s = this.pixelX * this.block;
    const px = Math.floor((easting - this.originX) / s);
    const py = Math.floor((northing - this.originY) / this.pixelY / this.block);
    return px >= 0 && py >= 0 && px < this.gridW && py < this.gridH;
  }
  private built = false;

  async build(): Promise<void> {
    if (this.built) return;
    this.built = true;
    await this.buildOwn();
    for (const p of this.patchMasks) await p.build();
  }

  private async buildOwn(): Promise<void> {
    if (this.allowed) return;
    const w = this.width;
    const h = this.height;
    const pxM = Math.abs(this.pixelX) || 10;
    // Hela Sverige vid 10 m blir miljarder px — läs då i remsor och nedprova till block
    // så att rutnätet håller sig ≤ ~120M celler (annars fail-closed tom karta live).
    if (w * h > 128_000_000) {
      const block = Math.ceil(Math.sqrt((w * h) / 120_000_000));
      const bw = Math.ceil(w / block);
      const bh = Math.ceil(h / block);
      const forest = new Uint8Array(bw * bh);
      const blocked0 = new Uint8Array(bw * bh);
      const water0 = new Uint8Array(bw * bh);
      const stripRows = Math.max(1, Math.floor(32_000_000 / w));
      for (let y0 = 0; y0 < h; y0 += stripRows) {
        const rows = Math.min(stripRows, h - y0);
        // geotiff-fönster är hörn-till-hörn [x0, y0, x1, y1] — INTE [x, y, w, h]
        const data = (await this.image.readRasters({ window: [0, y0, w, y0 + rows], interleave: true })) as ArrayLike<number>;
        for (let y = 0; y < rows; y++) {
          const by = Math.floor((y0 + y) / block);
          const rowBase = y * w;
          const brow = by * bw;
          for (let x = 0; x < w; x++) {
            const v = data[rowBase + x];
            if (typeof v !== "number") continue;
            const c = Math.round(v);
            const k = brow + Math.floor(x / block);
            if (this.forestClasses.has(c)) forest[k] = 1;
            if (this.dilateClasses.has(c)) blocked0[k] = 1;
            if (this.waterClasses.has(c)) water0[k] = 1;
          }
        }
      }
      const dilateB = (src: Uint8Array, r: number): Uint8Array => {
        const out = new Uint8Array(bw * bh);
        const tmp = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            let m = 0;
            for (let dx = -r; dx <= r && !m; dx++) {
              const xx = x + dx;
              if (xx >= 0 && xx < bw && src[y * bw + xx]) m = 1;
            }
            tmp[y * bw + x] = m;
          }
        }
        for (let x = 0; x < bw; x++) {
          for (let y = 0; y < bh; y++) {
            let m = 0;
            for (let dy = -r; dy <= r && !m; dy++) {
              const yy = y + dy;
              if (yy >= 0 && yy < bh && tmp[yy * bw + x]) m = 1;
            }
            out[y * bw + x] = m;
          }
        }
        return out;
      };
      const blockM = pxM * block;
      const blocked = dilateB(blocked0, Math.max(1, Math.round((this.dilatePx * pxM) / blockM)));
      const water = dilateB(water0, Math.max(1, Math.round(this.waterBufferM / blockM)));
      this.allowed = new Uint8Array(bw * bh);
      for (let k = 0; k < bw * bh; k++) this.allowed[k] = forest[k] && !blocked[k] && !water[k] ? 1 : 0;
      this.block = block;
      this.gridW = bw;
      this.gridH = bh;
      console.warn(`NMD-mask nedprovad ${block}x (${bw}x${bh} block, ~${Math.round(blockM)} m/cell) — hel-Sverige-mask`);
      return;
    }
    const data = (await this.image.readRasters({ interleave: true })) as ArrayLike<number>;
    const dilate = (src: Uint8Array, r: number): Uint8Array => {
      const out = new Uint8Array(w * h);
      const tmp = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let m = 0;
          for (let dx = -r; dx <= r && !m; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && src[y * w + xx]) m = 1;
          }
          tmp[y * w + x] = m;
        }
      }
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          let m = 0;
          for (let dy = -r; dy <= r && !m; dy++) {
            const yy = y + dy;
            if (yy >= 0 && yy < h && tmp[yy * w + x]) m = 1;
          }
          out[y * w + x] = m;
        }
      }
      return out;
    };
    const forest = new Uint8Array(w * h);
    const blocked0 = new Uint8Array(w * h);
    const water0 = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const v = data[k];
      if (typeof v !== "number") continue;
      const c = Math.round(v);
      if (this.forestClasses.has(c)) forest[k] = 1;
      if (this.dilateClasses.has(c)) blocked0[k] = 1;
      if (this.waterClasses.has(c)) water0[k] = 1;
    }
    const blocked = dilate(blocked0, Math.max(1, this.dilatePx));
    const water = dilate(water0, Math.max(1, Math.round(this.waterBufferM / pxM)));
    this.allowed = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) this.allowed[k] = forest[k] && !blocked[k] && !water[k] ? 1 : 0;
    this.gridW = w;
    this.gridH = h;
  }

  has(easting: number, northing: number): boolean {
    if (this.covers(easting, northing)) return true;
    return this.patchMasks.some((p) => p.has(easting, northing));
  }

  allows(easting: number, northing: number): boolean {
    if (this.covers(easting, northing)) {
      if (!this.allowed) return false;
      const px = Math.floor((easting - this.originX) / (this.pixelX * this.block));
      const py = Math.floor((northing - this.originY) / (this.pixelY * this.block));
      if (px < 0 || py < 0 || px >= this.gridW || py >= this.gridH) return false;
      return this.allowed[py * this.gridW + px] === 1;
    }
    for (const p of this.patchMasks) {
      if (p.has(easting, northing)) return p.allows(easting, northing);
    }
    return false;
  }
}

export class RasterLayer {
  private constructor(
    readonly id: string,
    private image: GeoTIFFImage,
    readonly originX: number,
    readonly originY: number,
    readonly pixelX: number,
    readonly pixelY: number,
    private nodata: number | undefined,
    private band: number,
    readonly recode?: Record<string, string>,
  ) {}

  // Test-patchar (andra områden än huvudfilen) — mosaic: huvudfilen frågas först, sedan patcharna.
  private patchLayers: RasterLayer[] = [];
  addPatch(layer: RasterLayer): void {
    this.patchLayers.push(layer);
  }
  private covers(easting: number, northing: number): boolean {
    const px = Math.floor((easting - this.originX) / this.pixelX);
    const py = Math.floor((northing - this.originY) / this.pixelY);
    return px >= 0 && py >= 0 && px < this.width && py < this.height;
  }
  private locate(easting: number, northing: number): RasterLayer | null {
    if (this.covers(easting, northing)) return this;
    for (const p of this.patchLayers) if (p.covers(easting, northing)) return p;
    return null;
  }

  static async load(
    file: string,
    id: string,
    nodata?: number,
    band = 1,
    recode?: Record<string, string>,
  ): Promise<RasterLayer> {
    const tiff = await fromFile(file);
    const image = await tiff.getImage();
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    if (!origin || !resolution || resolution[0] === 0 || resolution[1] === 0) {
      throw new Error(`${file}: saknar geotransform`);
    }
    return new RasterLayer(id, image, origin[0], origin[1], resolution[0], resolution[1], nodata, band, recode);
  }

  get width(): number {
    return this.image.getWidth();
  }

  get height(): number {
    return this.image.getHeight();
  }

  private data: ArrayLike<number> | null = null;

  bands(): number {
    return this.image.getSamplesPerPixel();
  }

  private ensured = false;
  async ensureData(): Promise<void> {
    if (!this.ensured) {
      this.ensured = true;
      await this.ensureOwn();
    }
    for (const p of this.patchLayers) await p.ensureData();
  }

  private async ensureOwn(): Promise<void> {
    if (this.data) return;
    if (this.width * this.height * this.bands() <= 128_000_000) {
      const rasters = await this.image.readRasters({ interleave: true });
      this.data = rasters as ArrayLike<number>;
    } else {
      // För stort för hel-cachen (t.ex. hela Sverige vid 10 m): sampleSync ger då null.
      // Proppa ner filen med gdalwarp till ~50–100 m eller klipp region — annars blir kartan tom.
      console.warn(
        `VARNING: raster "${this.id}" är ${this.width}x${this.height} (${this.width * this.height * this.bands()} px) — för stort för minnet, sampleSync ger null. Nedprova med gdalwarp -tr 50 50 (alt. klipp region).`,
      );
    }
  }

  get cached(): boolean {
    return this.data !== null && this.patchLayers.every((p) => p.cached);
  }

  get tooBig(): boolean {
    return this.width * this.height * this.bands() > 128_000_000 || this.patchLayers.some((p) => p.tooBig);
  }

  sampleSync(easting: number, northing: number): number | null {
    const L = this.locate(easting, northing);
    if (!L) return null;
    if (L !== this) return L.sampleSync(easting, northing);
    if (!this.data) return null;
    const px = Math.floor((easting - this.originX) / this.pixelX);
    const py = Math.floor((northing - this.originY) / this.pixelY);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    const v = this.data[(py * this.width + px) * this.bands() + (this.band - 1)];
    if (typeof v !== "number" || (this.nodata !== undefined && v === this.nodata)) return null;
    return v;
  }

  sampleGridSync(easting: number, northing: number, spacingM = 250): number[][] | null {
    const L = this.locate(easting, northing);
    if (!L) return null;
    if (L !== this) return L.sampleGridSync(easting, northing, spacingM);
    if (!this.data) return null;
    const px = Math.floor((easting - this.originX) / this.pixelX);
    const py = Math.floor((northing - this.originY) / this.pixelY);
    const r = Math.max(1, Math.round(spacingM / Math.abs(this.pixelX)));
    const x0 = px - r;
    const y0 = py - r;
    if (x0 < 0 || y0 < 0 || x0 + 2 * r >= this.width || y0 + 2 * r >= this.height) return null;
    const w = 2 * r + 1;
    const step = Math.max(1, Math.floor(w / 9));
    const bands = this.bands();
    const grid: number[][] = [];
    for (let j = 0; j < w; j += step) {
      const row: number[] = [];
      for (let i = 0; i < w; i += step) {
        const v = this.data[((y0 + j) * this.width + (x0 + i)) * bands + (this.band - 1)];
        if (typeof v !== "number" || (this.nodata !== undefined && v === this.nodata)) return null;
        row.push(v);
      }
      grid.push(row);
    }
    return grid;
  }

  async readWindow(x0: number, y0: number, x1: number, y1: number): Promise<ArrayLike<number>> {
    const rasters = await this.image.readRasters({ window: [x0, y0, x1, y1], interleave: true });
    return rasters as ArrayLike<number>;
  }

  private valid(v: number): number | null {
    if (typeof v !== "number" || (this.nodata !== undefined && v === this.nodata)) return null;
    return v;
  }

  has(easting: number, northing: number): boolean {
    return this.locate(easting, northing) !== null;
  }

  async sample(easting: number, northing: number): Promise<number | null> {
    const L = this.locate(easting, northing);
    if (!L) return null;
    if (L !== this) return L.sample(easting, northing);
    await this.ensureData();
    const px = Math.floor((easting - this.originX) / this.pixelX);
    const py = Math.floor((northing - this.originY) / this.pixelY);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    const bands = this.bands();
    if (this.data) return this.valid(this.data[(py * this.width + px) * bands + (this.band - 1)]);
    const arr = await this.readWindow(px, py, px + 1, py + 1);
    return this.valid(arr[this.band - 1]);
  }

  async sampleGrid(easting: number, northing: number, spacingM = 50): Promise<number[][] | null> {
    const L = this.locate(easting, northing);
    if (!L) return null;
    if (L !== this) return L.sampleGrid(easting, northing, spacingM);
    await this.ensureData();
    const px = Math.floor((easting - this.originX) / this.pixelX);
    const py = Math.floor((northing - this.originY) / this.pixelY);
    const r = Math.max(1, Math.round(spacingM / Math.abs(this.pixelX)));
    const x0 = px - r;
    const y0 = py - r;
    if (x0 < 0 || y0 < 0 || x0 + 2 * r >= this.width || y0 + 2 * r >= this.height) return null;
    const bands = this.bands();
    const w = 2 * r + 1;
    const arr = this.data ?? (await this.readWindow(x0, y0, x0 + 2 * r + 1, y0 + 2 * r + 1));
    const grid: number[][] = [];
    for (let j = 0; j < w; j++) {
      const row: number[] = [];
      for (let i = 0; i < w; i++) {
        const v = arr[((y0 + j) * this.width + (x0 + i)) * bands + (this.band - 1)];
        const val = this.valid(v);
        if (val === null) return null;
        row.push(val);
      }
      grid.push(row);
    }
    return grid;
  }
}

export class VectorLayer {
  private constructor(
    readonly id: string,
    private polys: [number, number][][],
  ) {}

  static async load(file: string, id: string, crs = "EPSG:3006"): Promise<VectorLayer> {
    const gj = JSON.parse(await fs.readFile(file, "utf8")) as {
      features?: { geometry?: { type: string; coordinates: unknown } }[];
    };
    const convert = (ring: unknown): [number, number][] =>
      (ring as [number, number][]).map(([x, y]) =>
        crs === "EPSG:3006" ? [x, y] : (proj4(crs, "EPSG:3006", [x, y]) as [number, number]),
      );
    const polys: [number, number][][] = [];
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates as [number, number][][]) polys.push(convert(ring));
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates as [number, number][][][]) {
          for (const ring of poly) polys.push(convert(ring));
        }
      }
    }
    return new VectorLayer(id, polys);
  }

  contains(easting: number, northing: number): boolean {
    for (const ring of this.polys) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (easting < minX || easting > maxX || northing < minY || northing > maxY) continue;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > northing !== yj > northing && easting < ((xj - xi) * (northing - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) return true;
    }
    return false;
  }
}

export class LayerStore {
  rasters = new Map<string, RasterLayer>();
  vectors = new Map<string, VectorLayer>();
  mask: MaskLayer | null = null;
  missing: string[] = [];
  private lastEmptyAttempt = 0;

  get empty(): boolean {
    return this.rasters.size === 0 && this.vectors.size === 0;
  }

  static async load(dir: string): Promise<LayerStore> {
    const store = new LayerStore();
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as Manifest;
    } catch {
      return store;
    }
    for (const r of manifest.rasters ?? []) {
      try {
        const layer = await RasterLayer.load(path.join(dir, r.file), r.id, r.nodata, r.band ?? 1, r.recode);
        for (const pf of r.patches ?? []) {
          try {
            layer.addPatch(await RasterLayer.load(path.join(dir, pf), `${r.id}#${path.basename(pf)}`, r.nodata, r.band ?? 1, r.recode));
          } catch {
            store.missing.push(pf);
          }
        }
        await layer.ensureData();
        store.rasters.set(r.id, layer);
      } catch {
        store.missing.push(r.file);
      }
    }
    for (const v of manifest.vectors ?? []) {
      try {
        store.vectors.set(v.id, await VectorLayer.load(path.join(dir, v.file), v.id, v.crs ?? "EPSG:3006"));
      } catch {
        store.missing.push(v.file);
      }
    }
    if (manifest.mask) {
      try {
        const mask = await MaskLayer.load(
          path.join(dir, manifest.mask.file),
          manifest.mask.forestClasses,
          manifest.mask.dilatePx ?? 3,
          manifest.mask.dilateClasses ?? [51, 52, 53, 54],
          manifest.mask.waterClasses ?? [61, 62],
          manifest.mask.waterBufferM ?? 50,
        );
        for (const pf of manifest.mask.patches ?? []) {
          try {
            mask.addPatch(
              await MaskLayer.load(
                path.join(dir, pf),
                manifest.mask.forestClasses,
                manifest.mask.dilatePx ?? 3,
                manifest.mask.dilateClasses ?? [51, 52, 53, 54],
                manifest.mask.waterClasses ?? [61, 62],
                manifest.mask.waterBufferM ?? 50,
              ),
            );
          } catch {
            store.missing.push(pf);
          }
        }
        await mask.build();
        store.mask = mask;
      } catch {
        store.missing.push(manifest.mask.file);
      }
    }
    return store;
  }

  shouldRetryEmpty(): boolean {
    if (!this.empty) return false;
    const now = Date.now();
    if (now - this.lastEmptyAttempt < 60_000) return false;
    this.lastEmptyAttempt = now;
    return true;
  }
}
