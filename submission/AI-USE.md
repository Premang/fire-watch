# Use of artificial intelligence (disclosure for the Space Apps submission)

*Draft. The team should edit this so it matches exactly how they worked.*

- **Code and analysis.** We built the data pipeline (Python) and the web application (TypeScript and
  React) with AI coding assistants.
  - Anthropic's Claude, used through Claude Code, wrote and ran most of the code, the tests and the
    data processing under our direction.
  - OpenAI's GPT model, used through the Codex CLI, served as an independent reviewer. It critiqued
    the harmonization design, the validation, the code and the user experience. Its reviews are kept
    in `submission/astra-review-*.md`, and each accepted change is logged in `OVERNIGHT-LOG.md`.
- **Data.** Every number, map and chart in the app comes from NASA FIRMS satellite observations,
  processed by the open pipeline in `ember-atlas/scripts/global/`. No AI-generated or synthetic data
  is presented as an observation. The method is deterministic statistics (ratios, shrinkage,
  percentiles), not a machine-learning model.
- **Text.** AI helped draft parts of the interface text and this submission; we reviewed and edited
  them.
- **Images.** The app itself contains no AI-generated images.
  - **One AI-generated picture is used, in the demo video only:** the operator and the room in the
    opening shot (about four seconds). It was made with OpenAI's image generation through the Codex
    CLI, from a text prompt and a screenshot of our own site, then split into layers for the camera
    move. The shot carries a visible on-screen mark, "AI-generated image (SI): operator and room", as
    the Space Apps rules require. The prompts are kept in `work/video/assets/operator/`.
  - The picture on the operator's monitor is not generated: it is the real site, placed onto the
    screen in the video project.
  - The 3D fire view (in the app and in the video) is not generative AI either. It is computed by our
    own code from terrain, imagery and satellite detections; the flames and smoke are a simulation,
    and both the page and the video say so.
  - Everything else in the video is screenshots and recordings of the working app.
- **Audio.** The music is a licensed track by a human composer (see `DATA-CITATIONS.md`). The narration in both demo
  videos is an AI-generated voice (ElevenLabs, model Eleven v4, library voice "Marcus K - Calm Documentary Narrator"),
  reading a script written for this project. Say so in the video's description and in the "Use of SI" answer.
- **Checks.**
  - Validation results come from held-out years and held-out regions, computed by the pipeline.
  - 192 automated tests (190 pass, 2 skipped) cover the analytics, the tile format, the near-real-time
    logic and the 3D view's data handling.
