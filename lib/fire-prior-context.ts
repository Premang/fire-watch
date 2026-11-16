import type {FittedFireModel} from './fire-predictor';

/** Cover every active distance split, plus a full cell for footprint rounding.
 * Output centers are at least 8.5 cells inside the 33-cell feature grid.
 * More distant detections cannot change a tree branch; keep the 150 km cap.
 */
export function priorContextPadding(model:FittedFireModel):number {
  const feature=model.features.indexOf('distance_prior_km');
  if(feature<0)throw new Error('Missing prior-distance feature');
  const thresholds=model.mixture?.treeWeight===0?[]:model.trees.flatMap(tree=>tree.filter(node=>!node[6]&&node[1]===feature).map(node=>node[2]));
  if(thresholds.some(value=>!Number.isFinite(value)||value<0||value>150))throw new Error('Unsupported fitted prior-distance context');
  const maximum=Math.max(0,...thresholds);
  return Math.max(12,Math.ceil(maximum/1.5)+1-8);
}
