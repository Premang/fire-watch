// GENERATED from data-research/v3-final.json (scripts/ml/train_v3_final.py). Do not edit by hand.
// Line-aware step fitted on 32 fires from 2020 with real completed fire lines, tested once on 2021.
// new score = sigmoid(logit(model score) + weight for the square's position behind a line).
export const FIRELINE_MODEL = {
  weights: { near: -0.203, mid: -0.308, far: -0.687, cutOff: -0.968 },
  fires: 32, squaresBehindLine: 4023, burnedBehindLine: 54,
  test2021: { fires: 27, squaresBehindLine: 4933, burnedBehindLine: 105, brierWithout: 0.03658, brierWith: 0.03664, improved: false },
} as const;
