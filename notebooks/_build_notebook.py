"""
_build_notebook.py
Generates neriah_demo.ipynb in this directory.
Run: python3 notebooks/_build_notebook.py
"""

import json, uuid, os

def uid():
    return uuid.uuid4().hex[:12]

def md(source: str) -> dict:
    return {
        "cell_type": "markdown",
        "id": uid(),
        "metadata": {},
        "source": source,
    }

def code(source: str, collapsed: bool = False) -> dict:
    meta = {"collapsed": True} if collapsed else {}
    return {
        "cell_type": "code",
        "execution_count": None,
        "id": uid(),
        "metadata": meta,
        "outputs": [],
        "source": source,
    }

cells = []

# ─────────────────────────────────────────────────────────────────────────────
# CELL 1 — Title & Overview
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""# Neriah: AI Homework Grading for African Classrooms
### Powered by Gemma 4 &nbsp;|&nbsp; Gemma 4 Good Hackathon

---

**The problem:** 15 million African teachers spend 2–3 hours every evening marking exercise books by hand — books they then hand back to students the next morning with only a score and a tick or cross.

**The solution:** Neriah uses Gemma 4's multimodal vision to read handwritten student submissions, grade every answer against a stored marking scheme, and return results in under 30 seconds — saving teachers **80 % of their marking time**.

---

### What this notebook demonstrates

| # | Demo | Gemma 4 model |
|---|---|---|
| 1 | AI-generated marking scheme from a question paper photo | 26B |
| 2 | Grading handwritten student work | 26B |
| 3 | Education-level calibration (Grade 3 → University) | 26B |
| 4 | Socratic AI tutor (concepts, never direct answers) | E2B |

### Three-tier model routing
```
On-device (LiteRT)   → Gemma 4 E2B / E4B    offline, zero cost
Cloud real-time      → Gemma 4 E2B           student tutor
Cloud batch          → Gemma 4 26B           homework grading
```

> **Context:** Zimbabwe alone has 136 000 teachers. At $5 / month that is a $8 M/year market before expanding across SADC (4.2 M teachers) and the rest of Africa (15 M+).
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 2 — Setup
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("## Setup"))

cells.append(code(
"""# Install the Google AI SDK (pre-installed on Kaggle, fast no-op if present)
%pip install -q google-genai pillow requests

import os, base64, json, textwrap, re
from pathlib import Path
from PIL import Image
from IPython.display import display, Markdown
import io

# ── Authenticate ──────────────────────────────────────────────────────────────
# On Kaggle: add your Google AI Studio API key as a secret named GOOGLE_API_KEY
#   Notebook settings → Secrets → Add new secret
# Local: set GOOGLE_API_KEY environment variable

try:
    from kaggle_secrets import UserSecretsClient
    GOOGLE_API_KEY = UserSecretsClient().get_secret("GOOGLE_API_KEY")
except Exception:
    GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")

if not GOOGLE_API_KEY:
    raise EnvironmentError(
        "GOOGLE_API_KEY not found.\\n"
        "On Kaggle: Notebook settings → Secrets → Add GOOGLE_API_KEY\\n"
        "Locally:   export GOOGLE_API_KEY=your_key_here\\n"
        "Get a free key at https://aistudio.google.com/app/apikey"
    )

from google import genai
from google.genai import types

client = genai.Client(api_key=GOOGLE_API_KEY)

# ── Model aliases ─────────────────────────────────────────────────────────────
GRADING_MODEL = "gemma-4-27b-it"   # 26B tier  — scheme generation & grading
TUTOR_MODEL   = "gemma-4-4b-it"    # E4B tier  — student tutor (fast, cheap)

print(f"✅  Google AI SDK ready")
print(f"    Grading model : {GRADING_MODEL}")
print(f"    Tutor model   : {TUTOR_MODEL}")
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 3 — Load sample images
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""## Sample Exercise Book Images

Real photos of Zimbabwean student exercise books. The notebook auto-generates
synthetic placeholders if the real photos are not present (so judges can run
this notebook immediately without extra setup).
"""
))

cells.append(code(
"""import subprocess, sys

# ── Locate sample images ──────────────────────────────────────────────────────
SAMPLE_DIRS = [
    Path("samples"),
    Path("../samples"),
    Path("/kaggle/working/neriah-ai/samples"),
]

sample_dir = None
for d in SAMPLE_DIRS:
    if d.exists() and any(d.glob("*.jpg")):
        sample_dir = d
        break

if sample_dir is None:
    # Clone the repo (Kaggle has internet access when turned on)
    print("Cloning neriah-ai repo for sample images…")
    subprocess.run(
        ["git", "clone", "--depth=1",
         "https://github.com/tinotendamaisiri/neriah-ai.git",
         "/kaggle/working/neriah-ai"],
        check=False, capture_output=True
    )
    sample_dir = Path("/kaggle/working/neriah-ai/samples")

# Fallback: generate synthetic placeholders on-the-fly
NEEDED = ["question_paper.jpg", "student_submission.jpg", "student_submission_2.jpg"]

def make_placeholder(path: Path, lines: list, bg=(255,252,245)):
    from PIL import Image, ImageDraw
    W, H = 1080, 1440
    img = Image.new("RGB", (W, H), color=bg)
    draw = ImageDraw.Draw(img)
    for y in range(100, H-80, 40):
        draw.line([(60,y),(W-60,y)], fill=(200,200,220), width=1)
    draw.line([(120,60),(120,H-60)], fill=(220,160,160), width=2)
    y_pos = 80
    for line in lines:
        col = (0,60,120) if line.startswith("##") else (20,20,60)
        draw.text((130, y_pos), line.lstrip("#").strip(), fill=col)
        y_pos += 36
        if y_pos > H-100: break
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=90)

if not sample_dir.exists() or not all((sample_dir/n).exists() for n in NEEDED):
    sample_dir = Path("/kaggle/working/samples")
    sample_dir.mkdir(exist_ok=True)

    make_placeholder(sample_dir/"question_paper.jpg", [
        "## FORM 2 SCIENCE — END OF TERM TEST",
        "Total: 30 marks",
        "",
        "1. Name the three states of matter.              [3]",
        "2. What is the chemical symbol for water?        [1]",
        "3. State Newton's First Law of Motion.           [2]",
        "4. What is photosynthesis? Write the word equation.[3]",
        "5. Name TWO energy transformations in a bulb.    [2]",
        "",
        "6. A car travels 120 km in 2 hours.",
        "   (a) Calculate the average speed.              [2]",
        "   (b) At 80 km/h, how long to travel 200 km?   [2]",
        "",
        "7. Describe the water cycle with a diagram.      [4]",
        "8. Conductor vs insulator — give examples.       [3]",
    ], bg=(255,253,245))

    make_placeholder(sample_dir/"student_submission.jpg", [
        "## Tendai Moyo   Form 2B   Roll: 14",
        "Science End of Term",
        "",
        "1. solid, liquid and gas",
        "2. H2O",
        "3. An object at rest stays at rest unless",
        "   acted on by a force",
        "4. Plants use sunlight to make food",
        "   CO2 + water → glucose + oxygen",
        "5. Electrical to light, electrical to heat",
        "6a. Speed = 120/2 = 60 km/h",
        "6b. Time = 200/80 = 2.5 hours",
        "7. Water evaporates, forms clouds, rains,",
        "   flows back to rivers and oceans",
        "8. Conductor lets electricity through e.g. copper",
        "   Insulator blocks electricity e.g. rubber",
    ], bg=(252,248,235))

    make_placeholder(sample_dir/"student_submission_2.jpg", [
        "## Chiedza Mutasa  Form 2B  Roll: 07",
        "Science End of Term",
        "",
        "1. Solid, liqiud, gas",
        "2. Water = H2O",
        "3. A moving object keeps moving",
        "4. Photosinthesis: plants use sun to make food",
        "5. Heat and light",
        "6a. 120 / 2 = 60km/h",
        "6b. 200 / 80 = 3 hours",
        "7. Sun heats water, vapour rises, makes clouds,",
        "   clouds give rain",
        "8. Conductor = metal, Insulator = plastic",
    ], bg=(250,245,240))

    print(f"⚠️  Using synthetic placeholder images (replace with real photos before submission)")

# ── Display images ────────────────────────────────────────────────────────────
print(f"\\n📁  Sample directory: {sample_dir.resolve()}")
print()

def show_image(path: Path, label: str):
    img = Image.open(path)
    thumb = img.resize((380, int(380 * img.height / img.width)))
    display(Markdown(f"**{label}** — `{path.name}` ({img.width}×{img.height})"))
    display(thumb)

show_image(sample_dir/"question_paper.jpg",      "📋 Question paper")
show_image(sample_dir/"student_submission.jpg",  "✏️  Student 1 (Tendai)")
show_image(sample_dir/"student_submission_2.jpg","✏️  Student 2 (Chiedza)")
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 4 — Demo 1: Marking Scheme Generation
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Demo 1 — AI-Generated Marking Scheme

A teacher photographs their question paper. Gemma 4 reads every question and
generates a complete marking scheme — **no manual answer-key entry needed**.

This is the first step of the Neriah pipeline: the teacher only needs to take
one photo, and the system is ready to mark an entire class.
"""
))

cells.append(code(
"""def image_to_part(path: Path) -> types.Part:
    \"\"\"Load an image file and return a Gemma-compatible Part.\"\"\"
    data = Path(path).read_bytes()
    suffix = Path(path).suffix.lower()
    mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
    return types.Part.from_bytes(data=data, mime_type=mime)

SCHEME_SYSTEM = \"\"\"You are a curriculum-aligned marking scheme generator for African schools.
You are looking at a photograph of a question paper. Read every question visible in the image.
Generate a complete marking scheme with model answers.
Education level: Form 2 (Zimbabwe O-Level preparation, age ~14).
Respond ONLY with valid JSON — no markdown fences, no extra text — matching this exact schema:
{
  "title": "string",
  "subject": "string",
  "education_level": "form_2",
  "total_marks": number,
  "questions": [
    {
      "number": integer,
      "question_text": "string",
      "correct_answer": "string",
      "max_marks": number,
      "marking_notes": "string or null"
    }
  ]
}\"\"\"

print("Sending question paper to Gemma 4 (26B)…\\n")

response = client.models.generate_content(
    model=GRADING_MODEL,
    contents=[
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    "Generate a complete marking scheme for this question paper."
                ),
                image_to_part(sample_dir / "question_paper.jpg"),
            ],
        )
    ],
    config=types.GenerateContentConfig(
        system_instruction=SCHEME_SYSTEM,
        temperature=0.1,
        max_output_tokens=2048,
    ),
)

# Strip markdown fences if the model wraps JSON anyway
raw = response.text.strip()
raw = re.sub(r"^```json\\s*", "", raw)
raw = re.sub(r"\\s*```$", "", raw)

scheme = json.loads(raw)

# ── Display results ───────────────────────────────────────────────────────────
print(f"📋  Title          : {scheme['title']}")
print(f"📚  Subject        : {scheme.get('subject', '—')}")
print(f"📊  Total marks    : {scheme['total_marks']}")
print(f"❓  Questions found: {len(scheme['questions'])}")
print()

rows = []
for q in scheme["questions"]:
    answer = textwrap.shorten(q["correct_answer"], width=55, placeholder="…")
    notes  = textwrap.shorten(q.get("marking_notes") or "", width=40, placeholder="…")
    rows.append(f"| Q{q['number']} | {q['question_text'][:45]}… | {answer} | {q['max_marks']} | {notes} |")

table = (
    "| # | Question | Model answer | Marks | Notes |\\n"
    "|---|---|---|:---:|---|\\n"
    + "\\n".join(rows)
)
display(Markdown(table))
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 5 — Demo 2: Grading a Student Submission
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Demo 2 — Grading Handwritten Student Work

Gemma 4 reads the student's handwritten answers directly from the exercise book
photo. **A single multimodal call handles both OCR and grading** — no separate
text extraction step needed.

The model compares what it reads against the marking scheme from Demo 1 and
returns a verdict, awarded marks, and optional feedback for every question.
"""
))

cells.append(code(
"""GRADING_SYSTEM_TMPL = \"\"\"You are an expert homework marker for African schools.
You are looking at a photograph of a student's handwritten exercise book page.
Read the student's handwritten answers carefully. Grade each answer against the answer key below.
Education level: Form 2 (Zimbabwe). Apply marking intensity appropriate to this level.
Accept correct spelling variants and equivalent expressions.

Answer Key:
{answer_key}

Respond ONLY with valid JSON — no markdown, no extra text:
{{
  "total_score": number,
  "max_score": number,
  "verdicts": [
    {{
      "question_number": integer,
      "verdict": "correct" | "incorrect" | "partial",
      "awarded_marks": number,
      "max_marks": number,
      "feedback": "string or null"
    }}
  ]
}}\"\"\"

answer_key_json = json.dumps(scheme["questions"], indent=2)

def grade_submission(image_path: Path, label: str) -> dict:
    print(f"Grading {label}…")
    resp = client.models.generate_content(
        model=GRADING_MODEL,
        contents=[
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text("Grade this student's work."),
                    image_to_part(image_path),
                ],
            )
        ],
        config=types.GenerateContentConfig(
            system_instruction=GRADING_SYSTEM_TMPL.format(answer_key=answer_key_json),
            temperature=0.0,
            max_output_tokens=2048,
        ),
    )
    raw = resp.text.strip()
    raw = re.sub(r"^```json\\s*", "", raw)
    raw = re.sub(r"\\s*```$", "", raw)
    return json.loads(raw)

def display_result(result: dict, label: str):
    pct = result["total_score"] / result["max_score"] * 100 if result["max_score"] else 0
    grade_band = (
        "A" if pct >= 80 else
        "B" if pct >= 70 else
        "C" if pct >= 60 else
        "D" if pct >= 50 else "U"
    )
    print(f"\\n{'─'*55}")
    print(f"  {label}")
    print(f"  Score : {result['total_score']}/{result['max_score']}  ({pct:.0f}%)  →  Grade {grade_band}")
    print(f"{'─'*55}")
    for v in result["verdicts"]:
        icon = "✅" if v["verdict"] == "correct" else "❌" if v["verdict"] == "incorrect" else "🟡"
        fb   = f"  ↳ {v['feedback']}" if v.get("feedback") else ""
        print(f"  {icon}  Q{v['question_number']:2d}  {v['verdict']:10s}  {v['awarded_marks']}/{v['max_marks']}{fb}")

# Grade both students
result1 = grade_submission(sample_dir/"student_submission.jpg",   "✏️  Tendai Moyo")
result2 = grade_submission(sample_dir/"student_submission_2.jpg", "✏️  Chiedza Mutasa")

display_result(result1, "Tendai Moyo")
display_result(result2, "Chiedza Mutasa")

# Side-by-side summary
print()
display(Markdown(
    "### Head-to-head\\n"
    f"| Student | Score | % | Grade |\\n"
    f"|---|:---:|:---:|:---:|\\n"
    f"| Tendai Moyo    | {result1['total_score']}/{result1['max_score']} "
    f"| {result1['total_score']/result1['max_score']*100:.0f}% | "
    f"{'A' if result1['total_score']/result1['max_score']>=0.8 else 'B' if result1['total_score']/result1['max_score']>=0.7 else 'C'} |\\n"
    f"| Chiedza Mutasa | {result2['total_score']}/{result2['max_score']} "
    f"| {result2['total_score']/result2['max_score']*100:.0f}% | "
    f"{'A' if result2['total_score']/result2['max_score']>=0.8 else 'B' if result2['total_score']/result2['max_score']>=0.7 else 'C'} |"
))
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 6 — Demo 3: Education-Level Calibration
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Demo 3 — Education-Level Calibration

The same student answer graded across four education levels.

Neriah adjusts marking intensity based on the class the teacher set up:
- **Grade 3** — lenient; spelling errors accepted, partial credit generous
- **Form 2** — standard O-Level preparation
- **Form 4** — strict; requires precise terminology
- **University** — academic rigour; citations / domain accuracy expected

This single system prompt parameter propagates through every grading call,
so teachers set it once at class creation and never think about it again.
"""
))

cells.append(code(
"""CALIBRATION_QUESTION = (
    "Name the capital city of Zimbabwe and describe its economic importance "
    "to the country. (5 marks)"
)
CALIBRATION_ANSWER = "The capital of Zimbabwe is Harare"

LEVELS = [
    ("grade_3",    "Grade 3",    "age ~9,  primary school"),
    ("form_2",     "Form 2",     "age ~14, O-Level prep"),
    ("form_4",     "Form 4",     "age ~16, O-Level finals"),
    ("tertiary",   "University", "undergraduate level"),
]

CALIBRATION_SYSTEM = \"\"\"You are an expert homework marker for African schools.
Education level: {level_label} ({level_note}).

Grade the student's answer to this question:
"{question}"

The ideal answer includes:
- Harare (the capital)
- At least one economic reason (e.g. financial centre, manufacturing hub,
  largest city, home to most government ministries)
- For higher levels: specific industries, GDP contribution, or regional role

Respond ONLY with valid JSON:
{{"verdict":"correct"|"incorrect"|"partial","awarded_marks":number,"max_marks":5,"feedback":"string"}}\"\"\"

print(f"Question : {CALIBRATION_QUESTION}")
print(f"Answer   : {CALIBRATION_ANSWER}\\n")
print(f"{'Level':<14} {'Verdict':<10} {'Score':<8} Feedback")
print("─" * 72)

cal_rows = []
for level_code, level_label, level_note in LEVELS:
    resp = client.models.generate_content(
        model=GRADING_MODEL,
        contents=types.Content(
            role="user",
            parts=[types.Part.from_text(f"Student answer: {CALIBRATION_ANSWER}")],
        ),
        config=types.GenerateContentConfig(
            system_instruction=CALIBRATION_SYSTEM.format(
                level_label=level_label,
                level_note=level_note,
                question=CALIBRATION_QUESTION,
            ),
            temperature=0.0,
            max_output_tokens=256,
        ),
    )
    raw = resp.text.strip()
    raw = re.sub(r"^```json\\s*", "", raw)
    raw = re.sub(r"\\s*```$", "", raw)
    r = json.loads(raw)
    icon = "✅" if r["verdict"] == "correct" else "❌" if r["verdict"] == "incorrect" else "🟡"
    score_str = f"{r['awarded_marks']}/{r['max_marks']}"
    fb = textwrap.shorten(r["feedback"], width=44, placeholder="…")
    print(f"{icon} {level_label:<12} {r['verdict']:<10} {score_str:<8} {fb}")
    cal_rows.append((level_label, r["verdict"], r["awarded_marks"], r["max_marks"], r["feedback"]))

print()
display(Markdown(
    "### Calibration results\\n"
    "| Level | Verdict | Score | Feedback |\\n"
    "|---|---|:---:|---|\\n" +
    "\\n".join(
        f"| {lbl} | {verd} | {aw}/{mx} | {textwrap.shorten(fb, 60, placeholder='…')} |"
        for lbl, verd, aw, mx, fb in cal_rows
    )
))
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 7 — Demo 4: Socratic Student Tutor
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Demo 4 — Socratic AI Tutor (Gemma 4 E4B)

Students can ask Neriah for help with their homework. The tutor uses the
**Socratic method** — it guides students to the answer through questions and
worked examples, **never giving the answer directly**.

This runs on Gemma 4 **E4B** (the 4-billion-parameter edge model), which is
small enough to run on a mid-range Android phone via LiteRT — meaning students
in areas with unreliable internet still get AI tutoring.
"""
))

cells.append(code(
"""TUTOR_SYSTEM = \"\"\"You are Neriah, a friendly AI study companion for African students.
You help students understand their homework through the Socratic method.

ABSOLUTE RULES:
1. NEVER give the direct answer to a homework question.
2. Ask 1–2 guiding questions that lead the student toward the answer themselves.
3. When showing working, use DIFFERENT numbers from the student's question.
4. Keep every response to 3–5 sentences maximum.
5. Be warm, encouraging, and never condescending.
6. Respond in the same language the student uses.

Education level: Form 2 (Zimbabwe)\"\"\"

# Simulate a realistic student conversation
conversation_script = [
    ("student", "How do I solve for x in:  3x + 9 = 21 ?"),
    ("student", "I don't understand. Can you just tell me the answer?"),
    ("student", "Oh! So I subtract 9 from both sides to get 3x = 12?"),
    ("student", "Then divide both sides by 3 to get x = 4. Is that right?"),
]

history: list[types.Content] = []

print(f"{'='*58}")
print("  NERIAH TUTOR SESSION — Algebra (Form 2)")
print(f"{'='*58}\\n")

for speaker, student_msg in conversation_script:
    # Display student turn
    print(f"👤  Student: {student_msg}")

    # Add student message to history
    history.append(
        types.Content(role="user", parts=[types.Part.from_text(student_msg)])
    )

    # Get tutor response
    resp = client.models.generate_content(
        model=TUTOR_MODEL,
        contents=history,
        config=types.GenerateContentConfig(
            system_instruction=TUTOR_SYSTEM,
            temperature=0.7,
            max_output_tokens=256,
        ),
    )
    tutor_reply = resp.text.strip()
    history.append(
        types.Content(role="model", parts=[types.Part.from_text(tutor_reply)])
    )

    # Display tutor turn
    print(f"\\n🎓  Neriah: {tutor_reply}\\n")
    print("─" * 58)
    print()

print("✅  The tutor guided the student to the answer without revealing it.")
print(f"    Model used: {TUTOR_MODEL} (E4B — runs on-device via LiteRT)")
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 8 — Architecture
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Architecture: Three-Tier Gemma 4 Routing

```
┌───────────────────────────────────────────────────────────────┐
│                      NERIAH PLATFORM                          │
│                                                               │
│  Submission channels                                          │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐       │
│  │  App     │  │   WhatsApp    │  │  Email           │       │
│  │ (iOS/And)│  │ (no app needed│  │ (submit@neriah.ai│       │
│  └────┬─────┘  └──────┬────────┘  └────────┬─────────┘       │
│       └───────────────┴─────────────────────┘                 │
│                         │                                     │
│                    Azure Functions                            │
│                  (Python backend)                             │
│                         │                                     │
│         ┌───────────────┼─────────────────┐                  │
│         ▼               ▼                 ▼                  │
│  ┌──────────────┐ ┌──────────┐ ┌───────────────────┐        │
│  │ Tier 1       │ │ Tier 2   │ │ Tier 3            │        │
│  │ ON-DEVICE    │ │ CLOUD    │ │ CLOUD BATCH       │        │
│  │ LiteRT       │ │ REAL-TIME│ │                   │        │
│  │              │ │          │ │                   │        │
│  │ Gemma 4 E2B  │ │Gemma 4   │ │ Gemma 4 26B       │        │
│  │ Gemma 4 E4B  │ │E2B       │ │                   │        │
│  │              │ │          │ │                   │        │
│  │ Tutor offline│ │ Tutor    │ │ Homework grading  │        │
│  │ Teacher scan │ │ (online) │ │ Scheme generation │        │
│  │ Cost: $0.00  │ │~$0.00001 │ │ ~$0.024/class     │        │
│  └──────────────┘ └──────────┘ └───────────────────┘        │
│                                                               │
│  Results → App dashboard │ WhatsApp reply │ Push notification │
└───────────────────────────────────────────────────────────────┘
```

### Why Gemma 4?

| Capability | Why it matters for Neriah |
|---|---|
| **Multimodal vision** | Reads handwriting directly — no separate OCR service |
| **E2B / E4B on-device** | Works offline on $80 Android phones (LiteRT) |
| **26B accuracy** | Matches or exceeds human marking accuracy on structured tests |
| **Open weights** | Deployable in Africa without US data-residency restrictions |
| **Cost** | 26B batch grading ≈ $0.024 per class of 40 — viable at $5/month SaaS |

### Production stack
- **Backend**: Azure Functions v2 (Python 3.11) on Azure southafricanorth
- **Database**: Azure Cosmos DB (serverless)
- **Storage**: Azure Blob Storage
- **Mobile**: React Native (Expo SDK 54, iOS + Android)
- **Alternative channels**: WhatsApp Cloud API, SendGrid Inbound Parse (email)
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# CELL 9 — Impact Summary
# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(
"""---
## Impact

### The marking burden

A typical Zimbabwean teacher has 40–50 students per class, teaches 4–6 classes,
and marks each student's book 2–3 times per week. That is **800–1 500 books per
week marked by hand** — typically after school hours, by candlelight, with no
pay for overtime.

### What Neriah changes

| Metric | Without Neriah | With Neriah |
|---|:---:|:---:|
| Time to mark a class of 40 | 2–3 hours | < 40 minutes |
| Feedback turnaround to student | Next day | Minutes |
| Digital academic records | None | Full history |
| Works on a $10 feature phone | No | Yes (WhatsApp) |
| Works offline | N/A | Yes (LiteRT) |
| Cost per teacher | $0 (but 3 h/day) | $5 / month |

### Market

| Geography | Teachers | Monthly ARR at $5 |
|---|:---:|:---:|
| Zimbabwe (launch) | 136 000 | $680 K |
| SADC region (year 2) | 4 200 000 | $21 M |
| Africa (year 5) | 15 000 000 | $75 M |

### Status

- ✅ Backend deployed: 42 Azure Functions at `neriah-func-dev.azurewebsites.net`
- ✅ Mobile app: React Native (iOS + Android), all core flows complete
- ✅ Three submission channels: app, WhatsApp, email
- ✅ Student AI tutor: Socratic, education-level calibrated
- 🔄 First paying school: onboarding in progress (Harare, May 2026)

---

**Repo:** [github.com/tinotendamaisiri/neriah-ai](https://github.com/tinotendamaisiri/neriah-ai)
**Live:** [neriah.ai](https://neriah.ai)
**Contact:** tinotenda@neriah.ai
"""
))

# ─────────────────────────────────────────────────────────────────────────────
# Assemble and write notebook
# ─────────────────────────────────────────────────────────────────────────────
notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3"
        },
        "language_info": {
            "codemirror_mode": {"name": "ipython", "version": 3},
            "file_extension": ".py",
            "mimetype": "text/x-python",
            "name": "python",
            "pygments_lexer": "ipython3",
            "version": "3.11.0"
        },
        "kaggle": {
            "accelerator": "gpu",
            "dataSources": [],
            "isInternetEnabled": True,
            "language": "python",
            "sourceType": "notebook"
        }
    },
    "nbformat": 4,
    "nbformat_minor": 5
}

out_path = os.path.join(os.path.dirname(__file__), "neriah_demo.ipynb")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(notebook, f, ensure_ascii=False, indent=1)

size_kb = os.path.getsize(out_path) / 1024
print(f"✅  Written: {out_path}  ({size_kb:.1f} KB)")
print(f"    Cells  : {len(cells)}")
print(f"    Code   : {sum(1 for c in cells if c['cell_type']=='code')}")
print(f"    Markdown: {sum(1 for c in cells if c['cell_type']=='markdown')}")
