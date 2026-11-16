import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import {priorContextPadding} from '../lib/fire-prior-context.ts';
import type {FittedFireModel} from '../lib/fire-predictor';
const released=JSON.parse(readFileSync(new URL('../public/data/ml/model.json',import.meta.url),'utf8')) as FittedFireModel;
test('released model satellite context covers every active prior-distance branch plus footprint rounding',()=>{
 const index=released.features.indexOf('distance_prior_km');
 const distance=(8.5+priorContextPadding(released))*1.5;
 for(const tree of released.trees)for(const node of tree)if(!node[6]&&node[1]===index)assert.ok(distance>=node[2]+1.5);
});
test('a 38 km split expands context beyond the previous 30 km lookup',()=>{
 const model={features:['distance_prior_km'],trees:[[[0,0,38.418745,0,1,2,0]]]} as FittedFireModel;
 assert.equal(priorContextPadding(model),19);
 model.trees[0][0][2]=151;
 assert.throws(()=>priorContextPadding(model),/Unsupported/);
 model.trees[0][0][2]=NaN;
 assert.throws(()=>priorContextPadding(model),/Unsupported/);
});
