/**
 * Research and scope metadata, reviewed 2026-10-22.
 * This is not a fitted model, an inference implementation, or evidence of skill.
 * Reconcile planned coverage with the released model's actual feature manifest.
 */

export type FirePredictorCoverage = "modeled" | "context" | "missing";
export type FirePredictorSourceKind =
  | "official"
  | "dataset"
  | "peer-reviewed"
  | "conference"
  | "workshop"
  | "preprint"
  | "author-code";

export interface FirePredictorSource {
  id: string;
  title: string;
  url: string;
  kind: FirePredictorSourceKind;
  year?: number;
}

export const FIRE_PREDICTOR_SOURCES = [
  { id: "independent-calibration", title: "scikit-learn: probability calibration and independent fitting data", url: "https://scikit-learn.org/stable/modules/calibration.html", kind: "official" },
  { id: "selection-bias", title: "On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation", url: "https://www.jmlr.org/beta/papers/v11/cawley10a.html", kind: "peer-reviewed", year: 2010 },
  { id: "global-activity", title: "Global data-driven prediction of fire activity", url: "https://www.nature.com/articles/s41467-025-58097-7", kind: "peer-reviewed", year: 2025 },
  { id: "dynamic-fuels", title: "A global fuel characteristic model and dataset for wildfire prediction", url: "https://bg.copernicus.org/articles/21/279/2024/index.html", kind: "peer-reviewed", year: 2024 },
  { id: "wsts-plus", title: "Improved Wildfire Spread Prediction with Time-Series Data and the WSTS+ Benchmark", url: "https://arxiv.org/abs/2502.12003", kind: "conference", year: 2026 },
  { id: "wsts-code", title: "WildfireSpreadTS author code and documented angle-feature issue", url: "https://github.com/SebastianGer/WildfireSpreadTS", kind: "author-code" },
  { id: "wsts-export", title: "WildfireSpreadTS dataset creation code", url: "https://github.com/SebastianGer/WildfireSpreadTSCreateDataset", kind: "author-code" },
  { id: "ndws", title: "Next Day Wildfire Spread dataset paper", url: "https://arxiv.org/abs/2112.02447", kind: "preprint", year: 2021 },
  { id: "ndws-export", title: "Google Research next-day wildfire export workflow", url: "https://github.com/google-research/google-research/tree/master/simulation_research/next_day_wildfire_spread", kind: "author-code" },
  { id: "gridmet", title: "gridMET producer documentation: variables, timing and limitations", url: "https://www.climatologylab.org/gridmet.html", kind: "dataset" },
  { id: "gridmet-bands", title: "gridMET band units and provisional status", url: "https://developers.google.com/earth-engine/datasets/catalog/IDAHO_EPSCOR_GRIDMET", kind: "dataset" },
  { id: "gfs", title: "NOAA Global Forecast System", url: "https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gfs.php", kind: "official" },
  { id: "landfire", title: "LANDFIRE surface, canopy and vegetation fuel products", url: "https://www.landfire.gov/fuel", kind: "official" },
  { id: "nfdrs", title: "US Forest Service National Fire Danger Rating System", url: "https://research.fs.usda.gov/firelab/projects/firedangerrating", kind: "official" },
  { id: "wind", title: "NWCG estimating winds for fire behavior", url: "https://www.nwcg.gov/publications/pms437/weather/estimating-winds-for-fire-behavior", kind: "official" },
  { id: "moisture", title: "NWCG weather and fuel moisture", url: "https://www.nwcg.gov/publications/pms425-1/11-weather-and-fuel-moisture", kind: "official" },
  { id: "stability", title: "NWCG atmospheric stability", url: "https://www.nwcg.gov/publications/pms425-1/4-atmospheric-stability", kind: "official" },
  { id: "spotting", title: "NWCG spotting fire behavior", url: "https://www.nwcg.gov/publications/pms437/crown-fire/spotting-fire-behavior", kind: "official" },
  { id: "haines", title: "NOAA Haines Index definition", url: "https://forecast.weather.gov/glossary.php?word=HAINES+INDEX", kind: "official" },
  { id: "glm", title: "NOAA Geostationary Lightning Mapper", url: "https://www.nesdis.noaa.gov/our-satellites/currently-flying/goes-east-west/geostationary-lightning-mapper-glm", kind: "official" },
  { id: "firms-limitations", title: "NASA explanation of active-fire detection limitations", url: "https://forum.earthdata.nasa.gov/viewtopic.php?t=5191", kind: "official" },
  { id: "snpp-outages", title: "NASA MODAPS: reported VIIRS/Suomi-NPP data outages", url: "https://modaps.modaps.eosdis.nasa.gov/services/production/outages_suomi_npp.html", kind: "official" },
  { id: "noaa20-outages", title: "NASA MODAPS: reported VIIRS/NOAA-20 data outages", url: "https://modaps.modaps.eosdis.nasa.gov/services/production/outages_noaa_20.html", kind: "official" },
  { id: "snpp-cessation", title: "NOAA October 19 notice: S-NPP data delivery ends November 2, 2026 at 13:00 UTC", url: "https://www.nesdis.noaa.gov/news/administrative-update-2-cessation-of-suomi-national-polar-orbiting-partnership-s-npp-data-users-november-02-2026-1300-utc-and-decommissioning-issued-october-19-2026-1400-utc", kind: "official", year: 2026 },
  { id: "nws-alerts", title: "NWS official alerts web service", url: "https://www.weather.gov/documentation/services-web-alerts", kind: "official" },
  { id: "nws-local", title: "NWS Chicago fire-weather criteria", url: "https://www.weather.gov/lot/firewx_definition", kind: "official" },
  { id: "nws-fuels", title: "NWS Grand Junction critical weather and fuel criteria", url: "https://www.weather.gov/gjt/firewxcriteria", kind: "official" },
  { id: "response", title: "USFS risk management and analytics in wildfire response", url: "https://research.fs.usda.gov/treesearch/59834", kind: "peer-reviewed", year: 2019 },
  { id: "initial-attack", title: "A Nationwide Benchmark for Wildfire Initial Attack Failure Prediction with Public Environmental Data", url: "https://arxiv.org/abs/2606.15529", kind: "preprint", year: 2026 },
  { id: "lfmc-model", title: "High-Resolution Live Fuel Moisture Content Maps from Multimodal Earth Observation Data", url: "https://arxiv.org/abs/2506.20132", kind: "workshop", year: 2025 },
  { id: "partial-observation", title: "Robust Wildfire Forecasting under Partial Observability", url: "https://arxiv.org/abs/2603.09042", kind: "preprint", year: 2026 },
] as const satisfies readonly FirePredictorSource[];

export type FirePredictorSourceId = (typeof FIRE_PREDICTOR_SOURCES)[number]["id"];

export interface FirePredictorVariable {
  id: string;
  label: string;
  coverage: FirePredictorCoverage;
  influence: string;
  sourceIds: readonly FirePredictorSourceId[];
  publicSourceUrls: readonly string[];
  freshness: string;
  limitations: readonly string[];
  /** Conceptual inputs; the fitted artifact's manifest owns exact column names. */
  modelFeatures?: readonly string[];
}

export interface FirePredictorCategory {
  id: string;
  title: string;
  summary: string;
  variables: readonly FirePredictorVariable[];
}

function variable(value: Omit<FirePredictorVariable, "publicSourceUrls">): FirePredictorVariable {
  return {
    ...value,
    publicSourceUrls: value.sourceIds.map((id) => {
      const source = FIRE_PREDICTOR_SOURCES.find((entry) => entry.id === id);
      if (!source) throw new Error(`Unknown fire predictor research source: ${id}`);
      return source.url;
    }),
  };
}

export const FIRE_PREDICTOR_SCOPE = {
  reviewedOn: "2026-10-22",
  status: "Research plan; actual coverage and skill must come from the fitted model artifact.",
  target: "Next UTC-day satellite activity outlook issued after 06Z using yesterday's detections: NOAA-20 VIIRS 375 m detected-active-fire occupancy (model trained on S-NPP), aggregated to 1.5 km cells within a known-fire vicinity.",
  targetWindow: "Issue day I after 06:00 UTC and only after the I00Z GFS run is actually available; predict I+1 00:00–24:00 UTC.",
  inputTiming: {
    recentFire: "I−1 complete UTC day",
    priorFire: "I−2 complete UTC day",
    gridmet: "I−2 nominal day, ending at 07:00 UTC on I−1; require actual availability",
    gfs: "I00Z run valid on issue day I; antecedent forecast conditions, not target-day weather",
    fourDayTrainingWindow: "Consecutive a,b,c,d: prior fire a, recent fire b, gridMET a, GFS c bands 18/20/21, target labels d; issue day c.",
  },
  observation: "NOAA-20 detection centres at nominal 375 m are assigned to 1.5 km cells; a 1.5 km occupied cell does not mean its entire area is burning.",
  spatialResolutionMeters: 1500,
  geography: "Only the geographic and seasonal domain supported by training and held-out evaluation; a CONUS dataset does not establish Alaska or Hawaii coverage.",
  sampling: "Conditional on an existing, recently detected fire and the fitted vicinity selection rule; not a nationwide new-ignition model.",
  plannedAlgorithm: "Fit and calibrate a supervised model on historical labels; compare against persistence and simple statistical baselines before selecting an architecture.",
  plannedInputs: [
    "Two days of NOAA-20 active-fire masks and spatial history",
    "Terrain",
    "Lagged gridMET weather, fuel-danger and drought proxies with recorded observation windows",
    "Issue-day GFS temperature, specific humidity and vector-mean wind speed as antecedent conditions from the available I00Z run",
  ],
  coverageDefinitions: {
    modeled: "Planned fitted-model input, subject to the released artifact's feature manifest; this research file does not prove training or validation.",
    context: "Useful public contextual information, excluded from the initial fitted model; availability must be reported when displayed.",
    missing: "Not represented reliably in the initial model; some quantities are only partially observable or require operational/field records.",
  } satisfies Record<FirePredictorCoverage, string>,
  excludedInputs: [
    { id: "forecast-precipitation-17", reason: "Project audit found invalid accumulation semantics in benchmark forecast band 17. Exclude it; valid live precipitation is context, and audited lagged gridMET precipitation is a separate input." },
    { id: "forecast-wind-direction-19", reason: "Project audit found corrupt benchmark forecast direction in band 19. Exclude it; correct live direction may be displayed as context without claiming the model uses it." },
    { id: "ndvi", reason: "Exclude from the initial model until historical composite availability, product parity and live freshness can be established." },
    { id: "annual-land-cover", reason: "Exclude from the initial model to avoid using annual products unavailable at historical issue time; public land-cover maps remain context." },
  ],
  mandatoryGates: [
    "The issue-time audit must establish forecast publication and observation availability, not merely model initialization or file date.",
    "The clock being past 06Z is necessary but not sufficient: the issue-day I00Z forecast must actually be available. No target-day weather is fitted.",
    "A retrospective benchmark with unavailable-at-issue inputs must be labeled retrospective and cannot establish operational forecast skill.",
    "Expose missing observations, input ages, product versions and unsupported-domain status.",
    "Abstain when the required NOAA-20 windows are missing, incomplete, from another platform, or carry an unrecognized confidence vocabulary; never substitute NOAA-21 or S-NPP detections.",
  ],
  sensorContinuity: {
    sourceId: "snpp-cessation",
    announcedDeliveryEnd: "2026-11-02T13:00:00Z",
    consequence: "S-NPP delivery ended. Live inputs now come from NOAA-20. The unchanged S-NPP-trained v2 model passed a predeclared one-shot retrospective NOAA-20 holdout (35 eligible 2021 events, 19 footprint clusters): PR-AUC 0.369 vs 0.225 for NOAA-20 persistence (paired 95% interval of the gain +0.03 to +0.21); its Brier gains over persistence and logistic baselines are not statistically resolved. A NOAA-20 refit did not beat it.",
    nextPriority: "Shadow-run the NOAA-20 live path with predeclared acceptance and rollback criteria; validate near-real-time feed parity and live calibration before any operational claim.",
  },
  notPredicted: [
    "Exact flame front, fire perimeter or flame arrival time",
    "New wildfire ignition probability across all U.S. land",
    "All burning hidden by clouds, smoke, overpass gaps or detection limits",
    "NWS Red Flag Warning issuance or official fire-danger classification",
    "Evacuation safety, containment success, optimal crew placement or suppression effectiveness",
  ],
  warningBoundary: "Display actual NWS alerts separately. NFDRS indices, local Red Flag criteria and learned detected-activity probabilities describe different quantities.",
} as const;

export const FIRE_PREDICTOR_CATEGORIES: readonly FirePredictorCategory[] = [
  {
    id: "observations", title: "Recent fire and observation quality",
    summary: "The model starts from observed fire activity; observation gaps remain a source of uncertainty.",
    variables: [
      variable({ id: "recent-fire", label: "Two-day fire history and nearby activity", coverage: "modeled", influence: "Recent activity and nearby detections describe persistence and the spatial context for tomorrow's detected activity.", sourceIds: ["wsts-plus", "firms-limitations", "snpp-cessation", "noaa20-outages"], freshness: "Complete UTC days I−1 and I−2, with data delivery times recorded; issue after 06Z on I.", limitations: ["A detected hotspot is not a complete perimeter or proof that a whole cell burns.", "Missing overpasses and hidden fires can look like disappearance.", "Vicinity selection must use past observations only.", "S-NPP delivery ended November 2, 2026 at 13Z. Live masks use NOAA-20, validated only retrospectively for this S-NPP-trained model; abstain on missing required observations and never substitute another sensor."], modelFeatures: ["day-1 occupancy", "day-2 occupancy", "local fire density", "distance to prior detections"] }),
      variable({ id: "observation-quality", label: "Clouds, smoke, sensor geometry and missing observations", coverage: "context", influence: "Detection opportunities determine how much confidence to place in a satellite label or missing detection.", sourceIds: ["firms-limitations", "snpp-outages", "partial-observation"], freshness: "Per acquisition or daily mask; distinguish observed clear non-fire from unknown wherever the source supports it.", limitations: ["The live outlook checks NASA’s reported outage intervals and abstains on overlapping input days or an unavailable check. No listed outage does not establish complete coverage.", "A FIRMS point-only feed does not provide a complete observed-negative mask.", "Unknown target pixels must not silently become negative training labels.", "Sensor substitution requires validation; GOES, MODIS and VIIRS masks are not interchangeable."] }),
      variable({ id: "thermal-energy", label: "FRP and thermal intensity", coverage: "context", influence: "Radiative power can provide additional evidence about detected thermal activity.", sourceIds: ["firms-limitations"], freshness: "Acquisition-specific, with sensor and quality metadata.", limitations: ["Excluded from the initial model unless the feature manifest explicitly includes it.", "Sensor-dependent FRP is not flame length, ground temperature, total burned area or crew demand."] }),
    ],
  },
  {
    id: "weather", title: "Weather, drying and rain",
    summary: "Past conditions describe drying; issued forecasts describe future conditions. Their time windows must remain distinct.",
    variables: [
      variable({ id: "temperature", label: "Temperature and specific humidity", coverage: "modeled", influence: "Thermal and moisture conditions affect drying and fuel receptivity.", sourceIds: ["gfs", "gridmet", "moisture"], freshness: "gridMET I−2 plus I00Z GFS forecast valid on issue day I, actually available by issuance after 06Z.", limitations: ["Specific humidity in kg/kg is not relative humidity in percent.", "Pin temperature units, height, daily aggregation and forecast lead to the training definition.", "GFS inputs are antecedent conditions on I, not target-day I+1 weather.", "Realized future weather or retrospective analysis is not an issued forecast."], modelFeatures: ["lagged minimum and maximum temperature", "lagged specific humidity", "antecedent GFS temperature", "antecedent GFS specific humidity"] }),
      variable({ id: "humidity-vpd", label: "Relative humidity, VPD and nighttime humidity recovery", coverage: "context", influence: "Atmospheric drying demand and poor overnight recovery can indicate conditions favorable to continued burning.", sourceIds: ["moisture", "nws-fuels", "gridmet"], freshness: "Hourly current/forecast values when available; source and valid time must be displayed.", limitations: ["Not a fitted input merely because temperature and specific humidity are present.", "Air humidity does not directly measure live or dead fuel moisture."] }),
      variable({ id: "lagged-rain", label: "Lagged rainfall and antecedent wetting", coverage: "modeled", influence: "Past precipitation affects wetting and subsequent drying of fuels.", sourceIds: ["gridmet", "gridmet-bands", "moisture"], freshness: "Audited lagged daily precipitation; gridMET days nominally end at 07:00 UTC and publication may follow.", limitations: ["Preserve mm/day and the accumulation window.", "Recent gridMET values are preliminary and can change.", "A regional daily total does not establish local wetting at a particular fire."], modelFeatures: ["lagged gridMET precipitation"] }),
      variable({ id: "forecast-rain", label: "Forecast rainfall and dry thunderstorms", coverage: "context", influence: "Expected rain can wet fuels; thunderstorms may also supply lightning and variable winds.", sourceIds: ["gfs", "nws-fuels"], freshness: "Use a correctly accumulated, issued forecast for contextual display.", limitations: ["Benchmark forecast band 17 is excluded after the project's accumulation audit.", "Do not silently replace that training band with a correct live field; retrain and validate first."] }),
      variable({ id: "solar-radiation", label: "Solar heating and shading", coverage: "context", influence: "Sun exposure, canopy shade and cloud cover influence fuel temperature and drying.", sourceIds: ["moisture", "gridmet"], freshness: "Hourly forecast or lagged daily estimate, with explicit source.", limitations: ["Not an initial fitted input.", "gridMET radiation is for a planar surface and is not automatically terrain-corrected."] }),
    ],
  },
  {
    id: "wind", title: "Wind and directional changes",
    summary: "Lagged wind and antecedent forecast speed are represented; current/forecast direction, gusts and local fireground winds are context.",
    variables: [
      variable({ id: "wind-speed", label: "Lagged wind and antecedent forecast vector-mean speed", coverage: "modeled", influence: "Wind changes heat transfer and can support faster activity expansion.", sourceIds: ["gfs", "gridmet", "wind"], freshness: "gridMET I−2 plus I00Z GFS summary valid on issue day I, with the training aggregation reproduced exactly.", limitations: ["Magnitude of a mean wind vector is different from mean scalar wind speed; directional cancellation matters.", "Coarse weather does not resolve local terrain-channelled winds.", "Ten-meter wind is not twenty-foot or midflame wind.", "Target-day GFS winds may appear as context but are not fitted inputs."], modelFeatures: ["lagged gridMET wind speed", "antecedent GFS vector-mean wind speed"] }),
      variable({ id: "lagged-wind-direction", label: "Lagged gridMET wind direction", coverage: "modeled", influence: "Earlier wind orientation provides antecedent context alongside the previous fire pattern.", sourceIds: ["gridmet", "wind", "wsts-code"], freshness: "gridMET I−2, encoded with both sine and cosine.", limitations: ["This describes past direction; it does not incorporate tomorrow's direction or sudden shifts.", "Spatial averaging must be circular: averaging 359 and 1 degrees arithmetically gives an incorrect 180 degrees.", "Preserve meteorological direction convention and reproduce the fitted preprocessing in inference."], modelFeatures: ["lagged wind direction sine", "lagged wind direction cosine"] }),
      variable({ id: "wind-direction", label: "Current/forecast wind direction and abrupt shifts", coverage: "context", influence: "Direction relative to terrain, fuels and an existing fire affects where activity may progress.", sourceIds: ["wind", "wsts-code", "wsts-export"], freshness: "Correct current/forecast vector direction can be shown with valid time.", limitations: ["Benchmark forecast band 19 is excluded following the project audit.", "The initial model cannot claim to use a current/forecast contextual wind arrow.", "Any future directional feature must preserve quadrant, from/to convention and both circular components."] }),
      variable({ id: "gusts-local-wind", label: "Gusts, vertical wind and local fire-induced circulation", coverage: "context", influence: "Short bursts, changing wind profiles and fire-generated circulation can produce behavior absent from daily averages.", sourceIds: ["wind", "stability"], freshness: "Hourly forecasts and nearby stations can supply partial context.", limitations: ["Not an initial fitted input.", "Public surface forecasts do not fully observe canopy-level winds or the fire's own circulation."] }),
    ],
  },
  {
    id: "fuels", title: "Fuel moisture, amount and structure",
    summary: "Danger indices are fuel-related proxies. They do not supply a complete, current inventory of live and dead fuels.",
    variables: [
      variable({ id: "fuel-danger", label: "Lagged ERC and available fuel-moisture proxies", coverage: "modeled", influence: "Lagged fire-danger variables summarize accumulated weather effects on modeled fuel conditions.", sourceIds: ["gridmet", "nfdrs"], freshness: "Lagged gridMET date, preliminary status and exact fields must be recorded in the fitted feature manifest.", limitations: ["gridMET ERC and BI use reference fuel model G (conifer forest), not each cell's actual fuel type.", "An index is not a calibrated probability.", "Do not claim every NFDRS component or fuel-moisture class is represented if only ERC is fitted."], modelFeatures: ["lagged ERC", "only explicitly audited fuel-danger fields in the fitted manifest"] }),
      variable({ id: "dead-live-moisture", label: "Dead-fuel time-lag classes and live herb/woody moisture", coverage: "missing", influence: "Fine and heavy dead fuels respond on different timescales; live moisture and curing also affect ignition and sustained burning.", sourceIds: ["nfdrs", "dynamic-fuels", "lfmc-model"], freshness: "Field samples are sparse; modeled daily products and satellite estimates have product-specific latency.", limitations: ["The initial model lacks a complete direct live/dead moisture state.", "Air humidity, NDVI and ERC are not interchangeable with measured fuel moisture.", "Any adopted modeled moisture product needs availability and uncertainty validation."] }),
      variable({ id: "fuel-load-type", label: "Fuel load, type, depth and continuity", coverage: "context", influence: "Available biomass and connected fuel beds help determine whether and how burning can sustain itself.", sourceIds: ["landfire", "dynamic-fuels"], freshness: "LANDFIRE release and disturbance year must accompany contextual maps.", limitations: ["Excluded from the initial fitted feature set.", "Fuel maps are not continuous field observations; treatments, disturbance and regrowth can change conditions.", "High weather danger can coexist with insufficient burnable fuel."] }),
      variable({ id: "canopy", label: "Canopy cover, height, base height and bulk density", coverage: "context", influence: "Canopy structure and ladder fuels influence transition to and propagation of crown fire.", sourceIds: ["landfire", "spotting"], freshness: "Versioned vegetation/fuel product; not a live canopy survey.", limitations: ["Not an initial fitted input.", "Canopy characteristics alone do not establish active crown fire or ember production."] }),
      variable({ id: "ndvi-cover", label: "NDVI, vegetation phenology and annual land cover", coverage: "context", influence: "Vegetation condition, seasonality and land cover can contextualize fuel amount and curing.", sourceIds: ["wsts-plus", "landfire", "dynamic-fuels"], freshness: "Record composite interval, actual publication time, product version and land-cover reference year.", limitations: ["NDVI and annual land cover are excluded from the initial model because historical/live availability parity is unresolved.", "A same-year annual map or future-containing composite can introduce hindsight.", "Substituting MODIS for VIIRS vegetation data requires retraining or validated harmonization."] }),
    ],
  },
  {
    id: "land-water", title: "Drought, soil and snow",
    summary: "Slow drying matters, but broad drought indices do not measure each fuel bed's current moisture.",
    variables: [
      variable({ id: "drought", label: "Lagged drought state", coverage: "modeled", influence: "Antecedent moisture deficits provide context for prolonged fuel drying.", sourceIds: ["gridmet", "gridmet-bands"], freshness: "Use the most recent eligible PDSI observation and its actual period/date; do not assume it updates daily.", limitations: ["Keep packed-value scale/offset and missing-value handling correct.", "Drought is not a substitute for fine-fuel moisture or an ignition source."], modelFeatures: ["lagged PDSI"] }),
      variable({ id: "soil-snow", label: "Soil moisture, snow cover and snowmelt", coverage: "context", influence: "Water availability and seasonal snow affect vegetation stress, fuel exposure and the timing of drying.", sourceIds: ["dynamic-fuels", "moisture"], freshness: "Satellite or land-surface-model products have distinct observation windows and delivery delays.", limitations: ["Not initial fitted inputs.", "Soil moisture is not identical to leaf or dead-fuel moisture; snow and vegetation can limit retrievals."] }),
    ],
  },
  {
    id: "terrain", title: "Terrain and barriers",
    summary: "Terrain is comparatively stable, while barriers and their effectiveness can change during an incident.",
    variables: [
      variable({ id: "topography", label: "Elevation, slope and aspect", coverage: "modeled", influence: "Terrain modifies exposure, moisture and the spatial setting for activity expansion.", sourceIds: ["wsts-plus", "wind", "moisture"], freshness: "Versioned elevation-derived terrain; preserve projection, units and aggregation to the 1.5 km grid.", limitations: ["Use both sine and cosine if aspect is fitted; slope is not an angle encoding substitute.", "Aggregated terrain cannot resolve every drainage or slope feature.", "Terrain features do not create fine-scale wind predictions."], modelFeatures: ["elevation", "slope", "aspect only if correctly encoded and included in the manifest"] }),
      variable({ id: "barriers", label: "Water, roads, recent burns, treatments and constructed lines", coverage: "context", influence: "Fuel discontinuities and constructed lines may limit surface spread or alter access.", sourceIds: ["landfire", "spotting", "response"], freshness: "Use dated public layers; live line status and effectiveness often require incident records.", limitations: ["Not an initial fitted input.", "Roads and rivers do not guarantee containment; spotting can cross barriers.", "A historical burn or mapped line does not establish current fuel absence or a safe route."] }),
    ],
  },
  {
    id: "ignition", title: "Ignition sources",
    summary: "The model is conditional on already observed fire activity and does not forecast new ignitions.",
    variables: [
      variable({ id: "lightning", label: "Lightning and dry-lightning conditions", coverage: "context", influence: "Lightning can provide an ignition source when receiving fuels are receptive.", sourceIds: ["glm", "nws-fuels"], freshness: "Lightning observations and precipitation must be aligned in space and time.", limitations: ["GLM measures total lightning, including flashes that do not establish a ground ignition.", "Excluded from the initial model; nearest-flash proximity does not establish cause."] }),
      variable({ id: "human-context", label: "Human ignition opportunity", coverage: "context", influence: "Population, roads, land use and infrastructure can indicate where human ignition opportunities occur.", sourceIds: ["global-activity", "initial-attack"], freshness: "Versioned contextual maps; actual activity and incidents may be unavailable.", limitations: ["Excluded from the initial model.", "Proximity is not proof of cause or a forecast of an individual's behavior."] }),
      variable({ id: "future-ignitions", label: "Future ignition timing, location and cause", coverage: "missing", influence: "An ignition is required for new fire; the exact trigger is generally unknown in advance.", sourceIds: ["global-activity", "glm"], freshness: "Usually becomes known only after observation or investigation.", limitations: ["No nationwide ignition-probability claim follows from training on existing-fire patches.", "Never use post-discovery cause or outcome records as if they were known before ignition."] }),
    ],
  },
  {
    id: "extreme-behavior", title: "Atmospheric instability and spotting",
    summary: "These processes can dominate exceptional behavior and are only partially described by the planned daily inputs.",
    variables: [
      variable({ id: "instability", label: "Vertical stability, Haines, mixing height and inversions", coverage: "context", influence: "Atmospheric structure can encourage or limit vertical motion and affect plume behavior.", sourceIds: ["stability", "haines"], freshness: "Issued model profiles or official derived indices, with valid time and terrain applicability.", limitations: ["Not initial fitted inputs.", "Haines does not encode surface wind or provide a universal ignition probability.", "A daily surface summary does not model pyroconvection or all fire-atmosphere feedbacks."] }),
      variable({ id: "embers", label: "Ember production, lofting and spot ignition", coverage: "missing", influence: "Firebrands can ignite receptive fuels beyond the main activity region or across barriers.", sourceIds: ["spotting"], freshness: "Event-specific production, transport and receiving-fuel state are not comprehensively observed by the app.", limitations: ["The model has no explicit spotting mechanism or measured ember distribution.", "A maximum spotting distance is not the likelihood of ignition at that distance.", "Do not present a deterministic wind arrow as a spot-fire forecast."] }),
    ],
  },
  {
    id: "response", title: "Suppression, exposure and official warnings",
    summary: "Operational decisions and public warnings require information beyond detected-activity predictions.",
    variables: [
      variable({ id: "suppression", label: "Crews, aircraft, tactics and containment actions", coverage: "missing", influence: "Response can change observed outcomes, while resource allocation is itself driven by perceived danger.", sourceIds: ["response", "initial-attack"], freshness: "Dispatch, resource availability and tactical records are incomplete or unavailable in public environmental feeds.", limitations: ["No crew placement, route safety or suppression-effectiveness recommendation is supported.", "Association between resources and final size is confounded by incident severity.", "Final size and containment times are future outcomes, not valid discovery-time inputs."] }),
      variable({ id: "exposure", label: "People, buildings, infrastructure and access", coverage: "context", influence: "Exposure helps assess potential consequences separately from the probability of detected fire activity.", sourceIds: ["response", "initial-attack"], freshness: "Dated asset/access datasets; road status, evacuation conditions and vulnerability may change rapidly.", limitations: ["Not initial fitted inputs.", "A model score alone does not establish evacuation need, road passability or a safe operating location."] }),
      variable({ id: "official-alerts", label: "Official NWS watches and Red Flag Warnings", coverage: "context", influence: "Official alerts communicate critical fuel and weather conditions using local criteria and forecaster judgment.", sourceIds: ["nws-alerts", "nws-local", "nws-fuels", "nfdrs"], freshness: "Use active NWS products with issue, update and expiration times; preserve affected zones when geometry is absent.", limitations: ["Display separately from learned probabilities and NFDRS indices.", "No single national wind/humidity threshold reproduces all local warning criteria.", "The model does not issue an official warning or imply that no alert means no risk."] }),
    ],
  },
];

export const FIRE_PREDICTOR_RECENT_RESEARCH = [
  { sourceId: "global-activity", year: 2025, status: "Peer-reviewed; Nature Communications", takeaway: "Combining weather, fuel and ignition context mattered more than increasing model complexity in the authors' experiments.", application: "Prioritize audited features and calibrated tree baselines before a larger neural architecture.", limitation: "Published results concern the authors' target, data and validation; they are not Ember Atlas performance." },
  { sourceId: "wsts-plus", year: 2026, status: "Accepted at WACV 2026", takeaway: "Multi-day history improved benchmark prediction; evaluation across years exposed distribution shift.", application: "Use prior fire sequences and hold out entire events and years.", limitation: "Satellite activity benchmarks do not establish precise flame-front forecasts or nationwide ignition probabilities." },
  { sourceId: "lfmc-model", year: 2025, status: "ICML 2025 TerraBytes workshop paper", takeaway: "Multimodal pretrained Earth-observation models offer a way to estimate live fuel moisture from sparse field supervision.", application: "A later experiment could add validated, available-at-issue live-moisture estimates.", limitation: "Estimated moisture is not a direct measurement everywhere; historical/live parity and local validity remain necessary." },
  { sourceId: "partial-observation", year: 2026, status: "Preprint; submitted to IEEE for review", takeaway: "Probabilistic reconstruction before forecasting improved robustness to simulated missing observations in WSTS experiments.", application: "Track observation masks and study uncertainty under missing data before adding learned reconstruction.", limitation: "Simulated masking is not a complete operational validation. Reconstructed fire must remain labeled inferred, not observed." },
  { sourceId: "initial-attack", year: 2026, status: "Preprint", takeaway: "A public-data benchmark studies initial-attack outcomes using discovery-time environmental and contextual inputs.", application: "Borrow its emphasis on forbidden future features and chronological evaluation.", limitation: "Its final-size-based label is a proxy for initial-attack failure, and naturally caused fires do not represent every ignition. It does not validate crew decisions." },
] as const satisfies readonly { sourceId: FirePredictorSourceId; year: number; status: string; takeaway: string; application: string; limitation: string }[];

export const FIRE_PREDICTOR_VALIDATION_CHECKS = [
  { id: "availability", label: "Issue-time availability", requirement: "Record observation window, acquisition/publication time, forecast initialization, lead and delivery time. No information from after issuance may enter a genuine forecast." },
  { id: "feature-parity", label: "Training and live feature parity", requirement: "Use identical units, grids, aggregations, source products, missing-value rules and feature ordering. Exclude audited-invalid bands 17 and 19; do not silently substitute a corrected live product." },
  { id: "label", label: "Satellite label and sampling audit", requirement: "Keep unknown separate from observed non-fire, retain extinguished/no-activity targets, and select known-fire vicinities using only past data. Do not select samples based on tomorrow having fire." },
  { id: "splits", label: "Independent evaluation", requirement: "Separate whole events, years and geographic groups; prevent overlapping fire neighborhoods crossing splits. Fit transformations and calibration only on their assigned training/validation data." },
  { id: "baselines", label: "Compare against simple alternatives", requirement: "Report persistence and simple statistical baselines alongside the fitted model, including performance on newly occupied cells rather than persistence alone." },
  { id: "calibration", label: "Probability calibration", requirement: "Evaluate PR-AUC, Brier score and reliability plus threshold precision/recall and alert burden. Preserve deployment prevalence or correct for negative subsampling before interpreting probabilities." },
  { id: "robustness", label: "Uncertainty and coverage", requirement: "Report event-level uncertainty and subgroup/domain results; assess stale, missing and shifted inputs. Unsupported conditions must remain visible rather than receiving unwarranted confidence." },
  { id: "artifact", label: "Reproducible fitted artifact", requirement: "Save data/split hashes, feature manifest, training command, fitted weights/trees, calibration and held-out predictions. Verify application inference against reference predictions." },
  { id: "claims", label: "Product claim boundary", requirement: "Show training period, evaluation scope, issue/valid times and actual input ages. Do not present research citations as our model's scores, or equate detections with flame fronts, ignitions, warnings or safe crew actions." },
] as const;
