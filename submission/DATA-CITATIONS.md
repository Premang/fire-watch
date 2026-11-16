# Data and references

*Before submitting, check each DOI against the FIRMS citation guidance
(https://www.earthdata.nasa.gov/data/tools/firms/faq, "How should I cite FIRMS data?").*

## NASA data (all data shown in the app)
- **NASA FIRMS.** "We acknowledge the use of data from NASA's Fire Information for Resource
  Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Science Data and
  Information System (ESDIS)."
- MODIS Collection 6.1 active fire detections, standard processing (MCD14ML), Terra and Aqua,
  2000–2025. Downloaded as FIRMS yearly "all countries" archives:
  https://firms.modaps.eosdis.nasa.gov/data/country/. doi:10.5067/FIRMS/MODIS/MCD14ML
- VIIRS 375 m active fire detections, standard processing:
  - Suomi NPP (VNP14IMG), 2012–2025
  - NOAA-20 / JPSS-1 (VJ114IMG), 2018–2025

  Downloaded as FIRMS yearly "all countries" archives.
- Near-real-time feeds, read live for the "right now" panel:
  - MODIS C6.1 NRT (MCD14DL): doi:10.5067/FIRMS/MODIS/MCD14DL.NRT.0061
  - VIIRS NOAA-20 375 m NRT (VJ114IMGTDL_NRT): doi:10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002
  - VIIRS NOAA-21 375 m NRT (VJ214IMGTDL_NRT): doi:10.5067/FIRMS/VIIRS/VJ214IMGT_NRT.002

## Algorithms the harmonization builds on
- Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection
  algorithm and fire products. *Remote Sensing of Environment*, 178, 31–41.
  https://doi.org/10.1016/j.rse.2016.02.054
- Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire
  detection data product: Algorithm description and initial assessment. *Remote Sensing of
  Environment*, 143, 85–96. https://doi.org/10.1016/j.rse.2013.12.008

## Other resources
- **Boundaries:** Natural Earth Admin 0 (countries) and Admin 1 (states and provinces), 1:10m, public
  domain. https://www.naturalearthdata.com/
- **Basemap:** Esri World Dark Gray Canvas (base and reference layers). Attribution is shown on the
  map.
- **Software:** Leaflet 1.9.4 (BSD-2-Clause), React and Next.js (MIT), DuckDB (MIT), pandas and NumPy
  (BSD), Shapely (BSD), Lucide icons (ISC).
- **Photo credit for the challenge:** The National Commission on Space Activities of Argentina
  (CONAE).

## Demo video
- Operator and room in the opening shot: AI-generated image (OpenAI image generation through the Codex CLI), marked on screen as AI-generated. It is not a photograph of a real person or place. The picture on the monitor is the real site.
- Music: "Lightless Dawn" by Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).
- 3D fire view (in the app and in the demo video):
  - Fire positions: NASA FIRMS VIIRS 375 m active fire detections (Suomi NPP, NOAA-20, NOAA-21).
  - Elevation: Mapzen Terrain Tiles on AWS Open Data (https://registry.opendata.aws/terrain-tiles/), built from SRTM and other open sources.
  - Ground imagery: Esri World Imagery. Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community.
  - Wind: Open-Meteo (https://open-meteo.com, CC BY 4.0). Past dates use the ERA5 reanalysis (Hersbach et al., Copernicus Climate Change Service / ECMWF); the last few days use the weather-model analysis.
  - Plants: photo-scanned models from Poly Haven (https://polyhaven.com, CC0): grass_medium_02, wild_rooibos_bush, searsia_lucida, searsia_burchellii, island_tree_02, tree_small_02.
  - Rendering: three.js (MIT licence). Flames, smoke and embers are simulated by the app.
