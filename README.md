# Neriah AI

Neriah AI is an AI-powered homework marking platform for African classrooms. Teachers provide homework questions; Gemma 4 generates the marking scheme automatically. Students submit handwritten work through the mobile app, WhatsApp, or email. Gemma 4 marks each submission against that scheme and builds a weakness profile per student from the results. That weakness profile then drives two adaptive learning tools: a Socratic tutor that guides without giving answers, and Neriah Play, an arcade-mode study game that generates 100 questions from the student's own curriculum and dynamically adjusts game speed based on performance (+5% on correct, -5% on wrong). Teachers get a dashboard to review AI grades, approve results, and query their class data in natural language. Marking creates the data; the data powers the adaptation.

Built for the Gemma 4 Good Hackathon on Kaggle (deadline May 18, 2026).

## What's in this submission

This repo IS the submission. The hackathon entry is the working product, not a walkthrough notebook: a Cloud Functions backend (`functions/` + `shared/`), a React Native + Expo mobile app (`app/mobile/`), the dataset-extraction pipelines that power the on-device fine-tune (`tools/dataset/`), and a pytest suite that locks the contracts (`tests/`). Build and run instructions are in the `Running locally` section below.

### Core tech (the parts the hackathon is judging)

- **Two-tier Gemma 4 inference.** Cloud uses Vertex AI Gemma 4 26B for grading and the teacher assistant. On-device uses LiteRT-LM with Gemma 4 E2B (`react-native-litert-lm` 0.3.4, vendored Bazel rebuild from main) for offline grading and the student tutor. A router (`shared/router.py`, `app/mobile/src/services/router.ts`) picks cloud-first with on-device fallback.
- **Single multimodal grading call.** No separate OCR step. `functions/mark.py` sends the page image straight to Gemma 4 with the answer key, gets back per-question verdicts, awarded marks, and feedback in one round trip.
- **Curriculum RAG.** 30 Zimbabwean syllabus PDFs (Primary, O-Level, A-Level) chunked, embedded via Vertex `text-embedding-004`, and stored in a Firestore vector collection. Pulled into every grading and tutor prompt via `shared/vector_db.py`.
- **Neriah Play.** Student-side arcade study mode. The student drops in notes, three-tier same-domain generator in `shared/play_generator.py` produces 100 multiple-choice questions, four `@shopify/react-native-skia` games render the quiz as gameplay (Lane Runner, Stacker, Blaster, Snake). Bidirectional speed (+5% on correct, -5% on wrong) keeps tension calibrated to the player.
- **Socratic tutor.** `functions/tutor.py` runs a no-direct-answers prompt with hints and follow-up questions, grounded in the student's weakness profile (`shared/weakness_tracker.py`) and the curriculum RAG.
- **Three submission channels share one backend.** Mobile app, WhatsApp Cloud API state machine, and a Zoho IMAP poller all funnel into the same grading pipeline.
- **Offline resilience.** Resumable model downloads with `savable()` snapshots and 50-attempt exponential backoff. Pre-graded marking on the offline path, replayed when online. Optimistic mutation queue with revert-on-error.
- **Dataset extraction pipelines.** `tools/dataset/` reads from the training archive (approved teacher-graded submissions), syllabuses (Gemma 4 26B distilled into Q/A pairs), exercise-book photos (per-question verdicts), and student-built play lessons. Output is Unsloth-compatible JSONL for Kaggle TPU fine-tuning. Includes a privacy scrubber (`tools/dataset/scrub.py`) with 26 tests locking idempotency, audit-log caps, and zero false positives on curriculum text.

### Tech stack

- **Backend:** Google Cloud Functions Gen2 (Python 3.11), Flask app, Firestore Native mode, Cloud Storage, Vertex AI
- **Mobile:** React Native 0.83.6, Expo SDK 55, TypeScript 5.9.2, `react-native-litert-lm` 0.3.4, `@shopify/react-native-skia` 2.6.2, `@react-native-ml-kit/text-recognition` for offline OCR
- **AI:** Vertex AI Gemma 4 26B (cloud), LiteRT-LM Gemma 4 E2B (on-device), `text-embedding-004`
- **Auth:** Twilio Verify (US) + Programmable SMS (international), JWT (365-day, `token_version` invalidation), bcrypt PIN with 5-attempt lockout

## Repo layout

```
neriah-ai/
├── functions/ + shared/               ← Cloud Functions backend (Flask blueprints)
├── app/mobile/                        ← React Native + Expo app
│   ├── src/play/                      ← Neriah Play (PlayNavigator, runtime, scenes)
│   └── src/services/litert.ts         ← On-device Gemma 4 wrapper
├── tools/dataset/                     ← Fine-tune extractor pipelines
├── tests/                             ← pytest suite (~500 tests)
├── syllabuses/                        ← 30 ZIMSEC curriculum PDFs (public)
├── samples/                           ← Demo input images
└── scripts/                           ← One-shot ops (RAG indexer, syllabus chunker)
```

## Running locally

### Backend
```bash
pip install -r requirements.txt
gcloud auth application-default login
functions-framework --target neriah --debug
```

### Mobile
```bash
cd app/mobile
npm install
npx expo prebuild
npx expo run:ios       # arm64 device only, no simulator
npx expo run:android   # arm64-v8a only
```

iOS uses CPU backend (GPU executor has fixed-shape prefill incompatible with free-form Gemma prompts). Android uses GPU for vision, CPU for text. Both pull `gemma-4-E2B-it.litertlm` (2.58 GB) from HuggingFace on first launch.

### Tests
```bash
pytest                                         # full suite, ~500 tests
pytest tests/test_play_generator.py -v         # core: three-tier MCQ generator
pytest tests/test_dataset_*.py -v              # dataset extraction pipelines
```

## On-device fine-tune roadmap

Phase 1 (in progress): build a privacy-scrubbed JSONL training set from the training archive, syllabuses, and graded exercise books. Output goes to a public HuggingFace repo. Phase 2: Unsloth fine-tune on Kaggle free TPU. Phase 3: convert to `.litertlm`, host on HuggingFace, hot-swap on phones via a Firestore-backed config endpoint (no app rebuild required). See `tools/dataset/` for the extractor surface.

## Hackathon submission

Gemma 4 Good Hackathon on Kaggle, deadline May 18 2026. Prize categories targeted: Main Track, Future of Education, Digital Equity, LiteRT.

## License

Licensed under CC-BY 4.0. See `LICENSE` for the full legal text. Syllabus PDFs in `syllabuses/` are reproduced from publicly distributed Zimbabwean curriculum documents.
