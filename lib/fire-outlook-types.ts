import type {PredictionInputs} from './prediction-inputs';
import type {OutlookCell} from './fire-predictor';
import type {SatelliteSourceHealth} from './satellite-source-health';
export type FireOutlook = {
 schemaVersion:1; status:'experimental'|'abstained'; modelId:string; fetchedAt:string; point:{lat:number;lon:number};
 issueDate:string;targetDate:string;recentFireDate:string;priorFireDate:string;weatherDate:string;
 cells:OutlookCell[]; inputs:PredictionInputs|null; reasons:string[]; warnings:string[];
 fireSource:{url:string;sensor:string;lastModified:string|null;latestDetection:string|null;recentCount:number;priorCount:number;observationalCoverage:'unknown'}|null;
 satelliteHealth:SatelliteSourceHealth|null;
 featureCoverage:{completeCells:number;totalCells:number};
 /** Internal (trial archiving only; never set by the public API): grid geometry and per-cell features. */
 grid?:{zone:number;left:number;top:number;cell:number;size:number};
 cellFeatures?:Record<string,{row:number;col:number;features:(number|null)[]}>;
};
