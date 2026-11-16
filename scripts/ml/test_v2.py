#!/usr/bin/env python3
"""Numerical protocol checks using tiny synthetic unit inputs, never fire evidence."""
import unittest
import numpy as np
from train_v2 import fit_offset, threshold, export_predict, paired_bootstrap

class ProtocolTests(unittest.TestCase):
    def test_offset_is_regularized_bounded_and_weight_normalized(self):
        y=np.r_[np.ones(10),np.zeros(90)];w=np.ones(100);raw=np.full(100,.1)
        self.assertAlmostEqual(fit_offset(y,raw,w,True),0,places=7)
        high=fit_offset(y,np.full(100,.001),w,True)
        self.assertTrue(0<high<=2)
        self.assertAlmostEqual(high,fit_offset(y,np.full(100,.001),w*100,True),places=7)
        self.assertEqual(fit_offset(y,np.full(100,.001),w,False),0)

    def test_threshold_grid_resolves_rare_events(self):
        self.assertAlmostEqual(threshold(np.array([0,1]),np.array([.001,.003]),np.ones(2)),.003)

    def test_export_branches_calibration_then_mixture(self):
        model={'base':0.,'trees':[[[0,0,.5,1,1,2,0],[1.,0,0,0,0,0,1],[-1.,0,0,0,0,0,1]]],
               'calibration':{'slope':1.,'intercept':-.2},'mixture':{'treeWeight':.25,'baselineFeatureIndex':0,'baselineRates':[.02,.6]}}
        actual=export_predict(model,np.array([[0.],[1.]]))
        expected=.25/(1+np.exp(-np.array([.8,-1.2])))+.75*np.array([.02,.6])
        np.testing.assert_allclose(actual,expected,rtol=0,atol=1e-15)
        model['mixture']['treeWeight']=0
        np.testing.assert_array_equal(export_predict(model,np.array([[0.],[1.]])),[.02,.6])

    def test_paired_bootstrap_preserves_zero_positive_brier_draws(self):
        events=[{'event':'a','y':np.array([1,0])},{'event':'b','y':np.array([0,0])}]
        y=np.array([1,0,0,0]);p=np.array([.4,.1,.1,.1]);w=np.ones(4)
        predictions={name:p.copy() for name in ('model','previousVersion','smoothedPersistence','persistence','logistic')}
        ci,comparison=paired_bootstrap(events,[['a'],['b']],y,predictions,w)
        self.assertEqual(ci['bootstrapReplicates'],1000)
        self.assertGreater(ci['undefinedPrAucDraws'],0)
        self.assertAlmostEqual(ci['brier'][0],.01)
        self.assertEqual(comparison['previousVersion']['brierDelta95'],[0.,0.])
        self.assertEqual(comparison['previousVersion']['prAucDelta95'],[0.,0.])

if __name__=='__main__':unittest.main()
