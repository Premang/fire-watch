import { File } from "jsfive";
// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { numericAttribute, readGoesAttributes } from "./goes-hdf.ts";
// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { HIGH_CONFIDENCE_FIRE_CLASSES, goesToLonLat, isHighConfidenceFire, pixelFootprint } from "./goes-projection.ts";
import type { GoesDetection, GoesFrame, GoesFrameMetadata, GoesProjection } from "./goes-types";

const AXIS_ATTRIBUTES = new Set(["scale_factor", "add_offset", "units"]);
const PROJECTION_ATTRIBUTES = new Set(["semi_major_axis", "semi_minor_axis", "perspective_point_height", "longitude_of_projection_origin", "latitude_of_projection_origin", "sweep_angle_axis"]);

/** Decodes only the 16-bit fire mask and two short coordinate vectors.
 * Never materializes lat/lon grids or the full FRP/temperature arrays.
 * jsfive inflates chunks without WASM, eval, Node filesystem, or subprocesses.
 */
export function decodeGoesFrame(buffer: ArrayBuffer, frame: GoesFrameMetadata): GoesFrame {
  if (buffer.byteLength > 8_000_000) throw new Error("NOAA file exceeds the decoder's size limit.");
  const file = new File(buffer, frame.key);
  const maskDataset = file.get("Mask");
  const [height, width] = maskDataset.shape;
  if (maskDataset.shape.length !== 2 || height !== 1500 || width !== 2500 || !/[iu]2$/.test(maskDataset.dtype)) {
    throw new Error("Unexpected NOAA CONUS fire-mask dimensions or datatype.");
  }
  const maskAttributes = readGoesAttributes(maskDataset, new Set(["flag_values", "flag_meanings"]));
  const values = maskAttributes.flag_values;
  const meanings = typeof maskAttributes.flag_meanings === "string" ? maskAttributes.flag_meanings.split(/\s+/) : [];
  const expected = ["good_fire_pixel", "saturated_fire_pixel", "temporally_filtered_good_fire_pixel", "temporally_filtered_saturated_fire_pixel"];
  if (!Array.isArray(values) || HIGH_CONFIDENCE_FIRE_CLASSES.some((category, i) => meanings[values.indexOf(category)] !== expected[i])) {
    throw new Error("NOAA fire-mask category metadata has changed.");
  }
  const xDataset = file.get("x"), yDataset = file.get("y");
  if (xDataset.shape.length !== 1 || yDataset.shape.length !== 1 || xDataset.shape[0] !== width || yDataset.shape[0] !== height) {
    throw new Error("NOAA coordinate dimensions do not match the fire mask.");
  }
  const xAttributes = readGoesAttributes(xDataset, AXIS_ATTRIBUTES);
  const yAttributes = readGoesAttributes(yDataset, AXIS_ATTRIBUTES);
  const projectionAttributes = readGoesAttributes(file.get("goes_imager_projection"), PROJECTION_ATTRIBUTES);
  if (xAttributes.units !== "rad" || yAttributes.units !== "rad" || projectionAttributes.sweep_angle_axis !== "x" || numericAttribute(projectionAttributes, "latitude_of_projection_origin") !== 0) {
    throw new Error("Unsupported NOAA coordinate reference system.");
  }
  const projection: GoesProjection = {
    semiMajorAxis: numericAttribute(projectionAttributes, "semi_major_axis"),
    semiMinorAxis: numericAttribute(projectionAttributes, "semi_minor_axis"),
    perspectivePointHeight: numericAttribute(projectionAttributes, "perspective_point_height"),
    longitudeOfProjectionOrigin: numericAttribute(projectionAttributes, "longitude_of_projection_origin"),
  };
  const xScale = numericAttribute(xAttributes, "scale_factor"), xOffset = numericAttribute(xAttributes, "add_offset");
  const yScale = numericAttribute(yAttributes, "scale_factor"), yOffset = numericAttribute(yAttributes, "add_offset");
  const xs = xDataset.value.map((value) => value * xScale + xOffset);
  const ys = yDataset.value.map((value) => value * yScale + yOffset);
  const dx = xs[1] - xs[0], dy = ys[1] - ys[0];
  if (![dx, dy].every((value) => Number.isFinite(value) && Math.abs(value) > 0 && Math.abs(value) < 0.001)) {
    throw new Error("Invalid NOAA coordinate spacing.");
  }
  const mask = maskDataset.value;
  if (mask.length !== width * height) throw new Error("Incomplete NOAA fire-mask grid.");
  const features: GoesDetection[] = [];
  let highConfidencePixelCount = 0;
  for (let index = 0; index < mask.length; index++) {
    const category = mask[index];
    if (!isHighConfidenceFire(category)) continue;
    highConfidencePixelCount++;
    if (highConfidencePixelCount > 10_000) throw new Error("NOAA detection count exceeds this lightweight viewer's processing limit.");
    const row = Math.floor(index / width), column = index % width;
    const point = goesToLonLat(xs[column], ys[row], projection);
    const ring = pixelFootprint(xs[column], ys[row], dx, dy, projection);
    if (!point || !ring) continue;
    const id = `G${frame.platform}:${frame.scanStart}:${row}:${column}`;
    features.push({
      type: "Feature", id, geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        id, platform: frame.platform, sensor: "GOES ABI",
        lon: Number(point[0].toFixed(6)), lat: Number(point[1].toFixed(6)),
        acquiredAt: frame.scanStart, mask: category,
        quality: category === 11 || category === 31 ? "saturated" : "processed",
        temporallyFiltered: category >= 30, frp: null,
        footprint: "satellite pixel; not fire perimeter",
      },
    });
  }
  return {
    frame, fetchedAt: new Date().toISOString(), nominalResolutionKmAtNadir: 2,
    qualityClasses: [...HIGH_CONFIDENCE_FIRE_CLASSES], sourcePixelCount: width * height,
    highConfidencePixelCount, detectionCount: features.length,
    features: { type: "FeatureCollection", features },
    warnings: [
      "These are NOAA satellite pixel footprints, not mapped flame fronts or incident perimeters. Footprints grow away from the satellite's nadir.",
      "Only processed and saturated fire classes 10, 11, 30, and 31 are shown. Clouds, missed small fires, and low-confidence detections can leave gaps; an empty cell does not mean no fire.",
      "Scan start is a frame timestamp; the satellite samples different pixels during the scan interval. FRP is not decoded in this lightweight view.",
      ...(features.length < highConfidencePixelCount ? ["Some edge-of-Earth pixels could not be navigated and were omitted."] : []),
    ],
  };
}
