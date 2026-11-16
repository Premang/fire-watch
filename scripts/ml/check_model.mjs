#!/usr/bin/env node
// Run with Node >=22: node --experimental-strip-types scripts/ml/check_model.mjs ARTIFACT_DIRECTORY
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {predictFire,makeFireFeatures} from '../../lib/fire-predictor.ts';

if(!process.argv[2])throw new Error('Usage: node --experimental-strip-types scripts/ml/check_model.mjs ARTIFACT_DIRECTORY (containing model, evaluation, replays and parity JSON)');
const directory=resolve(process.argv[2]);
const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=name=>JSON.parse(readFileSync(resolve(directory,name),'utf8'));
const modelBytes=readFileSync(resolve(directory,'model.json'));
const model=JSON.parse(modelBytes);const report=read('evaluation.json');const parity=read('parity.json');
const hash=createHash('sha256').update(modelBytes).digest('hex');
assert.equal(hash,report.modelSha256);assert.equal(hash,parity.modelSha256);
assert.equal(parity.vectors.length,report.test.model.cells);assert.equal(parity.vectors.length,parity.probabilities.length);
let maxError=0;
parity.vectors.forEach((x,i)=>{const error=Math.abs(predictFire(model,x)-parity.probabilities[i]);assert.ok(error<5e-12,`Score mismatch at cell ${i}: ${error}`);maxError=Math.max(maxError,error);});
const replays=read('replays.json');const cells=replays.flatMap(r=>r.cells);
assert.equal(cells.length,parity.vectors.length);
cells.forEach((cell,i)=>assert.ok(Math.abs(cell.p-parity.probabilities[i])<=.000005000001,`Replay rounding mismatch ${i}`));
const fixture=JSON.parse(readFileSync(resolve(app,'tests/fixtures/fire-features.json'),'utf8'));
let featureCases=0;
for(const c of fixture.cases)for(const q of c.queries){
  const actual=makeFireFeatures(q.row,q.col,c.size,c.recent,c.prior,c.elevation,q.weather,q.gfs);
  actual.forEach((v,i)=>{if(q.expected[i]===null)assert.equal(v,null);else assert.ok(Math.abs(v-q.expected[i])<=1e-10,`Feature ${i} mismatch in ${c.name}`);});
  assert.equal(actual[4],q.expected[4]);assert.equal(actual[5],q.expected[5]);
  assert.ok(Math.abs(predictFire(model,actual)-predictFire(model,q.expected))<5e-12,`Feature-to-score mismatch in ${c.name}`);featureCases++;
}
const prior=model.features.indexOf('distance_prior_km');
const priorThresholds=model.trees.flatMap(t=>t.filter(n=>!n[6]&&n[1]===prior).map(n=>n[2]));
console.log(JSON.stringify({modelSha256:hash,heldoutCells:parity.vectors.length,maxAbsoluteScoreError:maxError,replayCells:cells.length,featureCases,maximumPriorDistanceSplitKm:priorThresholds.length?Math.max(...priorThresholds):null},null,2));
