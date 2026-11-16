# Narration scripts for ElevenLabs

Both videos already carry this narration (ElevenLabs, Eleven v4, voice "Marcus K - Calm Documentary Narrator"), fitted by `work/video/scripts/voice-fit.py`. The text below is what was read.

There are two cuts of the demo video, each with its own script:

| Cut | File | Length | Narration file to add |
|---|---|---|---|
| One minute | `submission/ember-atlas-demo-60s.mp4` | 60 s | `work/video/public/voice-60.mp3` |
| 30 seconds | `submission/ember-atlas-demo.mp4` | 30 s | `work/video/public/voice.mp3` |

Space Apps limits the demo video to 30 seconds (Project Submission Guide: projects that exceed the
limit are not eligible for Global Judging). The 30-second cut is the one that fits that rule.

Both have captions burned in and music under them. The project that makes them is in `work/video`.

The wording was rewritten on 15 November to say what the project does in plain words: no instrument
names in the narration, "fire calendar" for the product, "older and newer satellites" for MODIS and
VIIRS, and "error" for the test result.

## One-minute cut: text to paste into ElevenLabs
Paste the whole block as one generation. The blank lines give short pauses between scenes.

```
Córdoba, Argentina. October twenty-twenty.

NASA satellites spot fires like this from space.

Fire Watch turns twenty-six years of those sightings into a fire calendar for any place.

Fire moves around the world with the seasons.

Fire seasons come at different times in different places.

The catch: newer satellites pick up far more fire than the older ones.

Fire Watch converts the old counts to the new scale, so every year can be compared.

Now an unusual month stands out. October twenty-twenty had two point four times the usual fire activity.

Open that month’s biggest fire day in three D.

The land and the fire locations are real. Flames and smoke are simulated.

Tested on years it had never seen, the error in monthly fire counts drops from seventy-five percent to sixteen.

Pick any place or draw your own area, in English or Spanish.

Fire Watch. A fire calendar for any place on Earth.
```

### Timing each line has to fit (one-minute cut)
| Line | Starts | Must end by | On screen |
|---|---|---|---|
| Córdoba, Argentina. October… | 0:00.4 | 0:02.6 | the fire at ground level |
| NASA satellites spot… | 0:03.0 | 0:05.8 | the climb to the top view |
| Fire Watch turns… | 0:06.0 | 0:10.7 | the operator at the screen |
| Fire moves around… | 0:11.2 | 0:14.0 | the world map, month by month |
| Fire seasons come… | 0:14.6 | 0:18.4 | regions named as their months arrive |
| The catch: newer… | 0:20.0 | 0:24.6 | the same fire at the older and newer satellites' pixel sizes |
| Fire Watch converts… | 0:24.9 | 0:29.5 | the calendar |
| Now an unusual… | 0:29.9 | 0:36.0 | the 2.4× month, then the site's month panel |
| Open that month’s… | 0:37.2 | 0:39.9 | the site's 3D page for that night |
| The land and… | 0:40.2 | 0:44.4 | the flight down to the fire line |
| Tested on years… | 0:45.0 | 0:50.8 | the before and after bars |
| Pick any place… | 0:52.7 | 0:56.3 | other places |
| Fire Watch. A… | 0:56.7 | 0:59.9 | end card |

About 153 spoken words in 13 lines. Most lines have room; "Fire Watch converts…" and
"Pick any place…" need a steady pace.

## 30-second cut: text to paste into ElevenLabs
```
Córdoba, Argentina. October twenty-twenty.

NASA satellites spot fires like this from space.

Fire Watch turns twenty-six years of that into one fire calendar.

Fire follows the seasons.

Old and new satellites count fire differently.

Fire Watch puts them on one scale.

October twenty-twenty: two point four times the usual fire activity.

Tested on years it never saw, the error drops from seventy-five percent to sixteen.

A fire calendar for any place on Earth. Fire Watch.
```

### Timing each line has to fit (30-second cut)
| Line | Starts | Must end by | On screen |
|---|---|---|---|
| Córdoba, Argentina. October… | 0:00.3 | 0:02.5 | the fire at ground level |
| NASA satellites spot… | 0:02.7 | 0:05.5 | the climb to the top view |
| Fire Watch turns… | 0:05.7 | 0:08.9 | the operator at the screen |
| Fire follows the… | 0:09.1 | 0:10.8 | the world map |
| Old and new… | 0:11.0 | 0:13.5 | the same fire, two counts |
| Fire Watch puts… | 0:13.8 | 0:16.2 | the calendar |
| October 2020: 2.4… | 0:16.5 | 0:20.4 | the 2.4× month |
| Tested on years… | 0:20.6 | 0:24.6 | the before and after bars |
| A fire calendar… | 0:24.9 | 0:29.5 | other places, end card |

About 75 spoken words in 9 short lines, so it needs a steady, slightly brisk pace, and the
total must stay under 30 seconds. Generating each line separately is the easiest way to hit the times.

## Suggested ElevenLabs settings
- A calm documentary voice. Stability about 50%, similarity about 75%, style 0–20%.
- Speed 1.0. If a read runs over its "must end by" time, raise the speed to 1.05–1.1 and regenerate.
- Generating each line separately makes it easier to hit the times.
- Export as MP3.

## Putting the voice into the video
1. Save the file as `work/video/public/voice-60.mp3` (one-minute cut) or `work/video/public/voice.mp3`
   (30-second cut).
2. In `work/video`, run `npm run render` (one minute) or `npm run render:30` (30 seconds).
3. The result is `work/video/out/ember-atlas-demo-60s-voice.mp4` or `…-30s-voice.mp4`. The music is
   turned down automatically.

If a line lands early or late against its scene, change the `from` and `to` times in
`work/video/src/script.ts` (they also drive the captions), run `python3 scripts/srt.py` to refresh the
subtitle files, and render again.

Space Apps asks that AI-generated audio be acknowledged in descriptive text and metadata. If you use
an ElevenLabs voice, say so in the "Use of SI" answer on the project page (see `AI-USE.md`).

## Music credit (required by its licence)
"Lightless Dawn" by Kevin MacLeod (incompetech.com), licensed under Creative Commons: By
Attribution 4.0. The credit is shown on the last frames of each video; also put it in the project's
references.
