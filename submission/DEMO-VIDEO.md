# Demo video: the two cuts, shot lists and subtitles

## The length rule
The Space Apps Project Submission Guide allows a demo video of **30 seconds or less**, with English
subtitles, and says projects that exceed the limit are not eligible for Global Judging. So:

| File in this folder | Length | Use |
|---|---|---|
| `ember-atlas-demo.mp4` | 30 s | Fits the rule. This is the one to link as the Project Demo. |
| `ember-atlas-demo-60s.mp4` | 60 s | The longer cut, with every scene given more time. Too long to be the official demo link. |

Both were made with Remotion (project in `work/video`). Both have burned-in captions and licensed
music, and no voice yet. `VOICE-SCRIPT.md` has the narration for each and how to add it. Subtitle
files: `demo-subtitles.srt` (30 s) and `demo-subtitles-60s.srt` (60 s).

## Wording
The on-screen text and captions were rewritten on 15 November to say what the project does in plain
words. Instrument names appear only as small labels ("MODIS · since 2000", "VIIRS · since 2012");
the narration says "older and newer satellites", "fire calendar", "the usual fire activity" and
"error". The sequence counter and timecode were removed from the frame.

## The opening, in both cuts
- **The fire shot** is filmed from the site's own 3D fire view (`/scene?demo=cordoba-night`): the
  Córdoba fire of 5 October 2020 at ground level, then the climb to a top view. The label says it is
  a 3D illustration built from real terrain and the satellite's fire locations, with simulated flames
  and smoke.
- **The operator shot.** The top view turns out to be the site on a monitor; the camera pulls back
  past an operator, the cursor clicks "Back to the atlas", and the camera pushes back in.
  - The operator and the room are an **AI-generated image** (OpenAI image generation), not a photo of
    a real person. The shot shows the mark "AI-generated image (SI): operator and room", which the
    Space Apps rules require for generated pictures.
  - The picture on the monitor is the real site, placed on the screen in the video project.

## One-minute cut
| Time | What is on screen |
|---|---|
| 0:00–0:05 | The fire at ground level, then the climb to a top view. |
| 0:05–0:11 | Pull-back to the operator, the click, the push back in. |
| 0:11–0:20 | The world's fire seasons: one full year, with seven regions named as their months arrive (from the site's own world grid). |
| 0:20–0:25 | "Same fire. Two different counts.": one fire at the older satellites' 1 km squares (3 detections) and the newer satellites' 375 m squares (12). Marked as an illustration, with the measured figure next to it (the older satellite reports about 75% fewer detections). |
| 0:25–0:29 | "One scale. One calendar.": older counts are converted to the newer scale; Córdoba's calendar and its July–September season. |
| 0:29–0:37 | October 2020 at 2.4× the usual fire activity for October (higher than 9 in 10 other Octobers), then the site's own month panel and its "See this month's biggest fire day in 3D" link. |
| 0:37–0:44 | The 3D fire view that link opens: the night pass of 5 October 2020 (NOAA-20, 421 detections). The site's page, then a flight from 3 km down along the fire line to 20 m beside the flames. A panel says what is real (the land, where the satellite saw fire, the wind) and what is simulated (the flames and the smoke). |
| 0:44–0:53 | "We tested it on years it had never seen.": error in monthly fire counts 75% → 16%, plus 29% in regions it had never seen, 15% when run back in time, and above-normal months caught 8% → 58%. |
| 0:53–0:56 | Any place on Earth: three other calendars; live check, data download, share link, English/Español. |
| 0:56–1:00 | End card: "A fire calendar for any place on Earth." |

Where the 3D scene differs from the site: the link opens that night's pass at ground level; the video
starts from a higher view of the same pass, which a visitor reaches by zooming out and turning.

## 30-second cut
| Time | What is on screen |
|---|---|
| 0:00–0:05 | The fire at ground level, then the climb to a top view. |
| 0:05–0:09 | Pull-back to the operator, the click, the push back in. |
| 0:09–0:11 | The world's fire seasons. |
| 0:11–0:14 | "Same fire. Two different counts.": the same illustration as the one-minute cut, played faster. |
| 0:14–0:16 | "One scale. One calendar." |
| 0:16–0:20 | Córdoba, October 2020: 2.4× the usual fire activity. |
| 0:20–0:25 | Tested on years it never saw: 75% → 16%, 29% in regions it had never seen, above-normal months caught 8% → 58%. |
| 0:25–0:30 | Any place on Earth; end card. |

The shot list below is the older plan for a hand-recorded take.

| Time | Screen | Subtitle |
|---|---|---|
| 0:00–0:05 | Landing on **Córdoba, Argentina**. The summary card is visible: the season and how the latest month compares with usual. | "When does Córdoba burn, and is this year unusual? 25 years of NASA fire satellites, one scale." |
| 0:05–0:11 | Slow move down the calendar. The Jul–Sep band glows in every year, and the early 2000s stand out. | "MODIS and VIIRS hotspots, harmonized into one calendar: the season peaks July–September." |
| 0:11–0:17 | Click **vs usual**. The colours switch to anomaly. Click **Oct 2020**, the month of the large Sierras de Córdoba fires. The month detail shows 2.38×, the 91st percentile and full coverage. | "Unusual months stand out: October 2020 burned 2.4× its usual level." |
| 0:17–0:24 | Cut to the Evidence page's three headline numbers: 75% → 16% regional error, 29% in withheld regions, 35% → 61% months classed like the reference. | "Raw Aqua counts sit 75% below VIIRS. Harmonized, error drops to 16%, tested on years and regions never seen." |
| 0:24–0:30 | Back on the calendar: click **Calendar CSV**, then **Copy share link**, then **ES**. No live drawing; the map is visible. | "Any place on Earth. Download the evidence and share the view, in English or Spanish." |

## Seven-slide alternative
The rules allow up to 7 slides instead of a video. The outline is in `SLIDES.md`.

## Recording tips
- Reload with `?place=admin1:AR-X` so the default view is identical every take; `&color=anomaly&month=2020-10` jumps straight to shot 3.
- To show "Right now" live, click it before recording. It caches NASA's 7-day files for 10
  minutes, so the take stays fast.
