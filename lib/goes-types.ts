export type GoesPlatform = "18" | "19";
export type GoesBounds = { west: number; south: number; east: number; north: number };
export type GoesFrameMetadata = {
  key: string;
  url: string;
  platform: GoesPlatform;
  scanStart: string;
  scanEnd: string;
  productCreatedAt: string;
  publishedAt: string | null;
  sizeBytes: number | null;
};
export type GoesTimeline = {
  platform: GoesPlatform;
  satellite: string;
  product: "ABI-L2-FDCC";
  coverage: "CONUS";
  nominalCadenceMinutes: 5;
  fetchedAt: string;
  hours: number;
  frames: GoesFrameMetadata[];
  latestKey: string | null;
  warnings: string[];
};
export type GoesDetection = {
  type: "Feature";
  id: string;
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    id: string; platform: GoesPlatform; sensor: "GOES ABI";
    lat: number; lon: number;
    acquiredAt: string;
    mask: number;
    quality: "processed" | "saturated";
    temporallyFiltered: boolean;
    frp: number | null;
    footprint: "satellite pixel; not fire perimeter";
  };
};
export type GoesFrame = {
  frame: GoesFrameMetadata;
  fetchedAt: string;
  nominalResolutionKmAtNadir: 2;
  qualityClasses: number[];
  sourcePixelCount: number;
  highConfidencePixelCount: number;
  detectionCount: number;
  features: { type: "FeatureCollection"; features: GoesDetection[] };
  warnings: string[];
};
export type GoesProjection = {
  semiMajorAxis: number;
  semiMinorAxis: number;
  perspectivePointHeight: number;
  longitudeOfProjectionOrigin: number;
};
