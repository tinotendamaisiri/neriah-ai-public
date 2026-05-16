"""create_placeholders.py
Generate synthetic placeholder images for the Neriah demo notebook.
These are used when real exercise book photos are not yet available.
Replace with real photos before final submission.
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.dirname(__file__)
W, H = 1080, 1440  # portrait A4-ish


def make_image(lines: list[str], filename: str, bg: tuple = (255, 252, 245)) -> None:
    img = Image.new("RGB", (W, H), color=bg)
    draw = ImageDraw.Draw(img)

    # Ruled lines
    for y in range(100, H - 80, 40):
        draw.line([(60, y), (W - 60, y)], fill=(200, 200, 220), width=1)

    # Left margin line
    draw.line([(120, 60), (120, H - 60)], fill=(220, 160, 160), width=2)

    # Text
    y_pos = 80
    for line in lines:
        size = 22 if not line.startswith("##") else 28
        color = (20, 20, 60) if not line.startswith("##") else (0, 60, 120)
        text = line.lstrip("#").strip()
        draw.text((130, y_pos), text, fill=color)
        y_pos += size + 14
        if y_pos > H - 100:
            break

    path = os.path.join(OUT_DIR, filename)
    img.save(path, "JPEG", quality=90)
    print(f"Created {path}")


# ── Question paper ────────────────────────────────────────────────────────────
make_image(
    [
        "## FORM 2 SCIENCE — END OF TERM TEST",
        "Date: April 2026          Total: 30 marks",
        "",
        "SECTION A: Short Answers (15 marks)",
        "",
        "1. Name the three states of matter.              [3]",
        "",
        "2. What is the chemical symbol for water?         [1]",
        "",
        "3. State Newton's First Law of Motion.            [2]",
        "",
        "4. What is photosynthesis? Write the word equation.[3]",
        "",
        "5. Name TWO types of energy transformation        [2]",
        "   that occur in a light bulb.",
        "",
        "SECTION B: Structured Questions (15 marks)",
        "",
        "6. A car travels 120 km in 2 hours.",
        "   (a) Calculate the average speed.               [2]",
        "   (b) If the car then travels at 80 km/h,",
        "       how long will it take to travel 200 km?    [2]",
        "",
        "7. Describe the water cycle with a diagram.       [4]",
        "",
        "8. Explain the difference between a conductor",
        "   and an insulator. Give one example of each.    [3]",
    ],
    "question_paper.jpg",
    bg=(255, 253, 245),
)

# ── Student submission 1 ──────────────────────────────────────────────────────
make_image(
    [
        "## Tendai Moyo        Form 2B        Roll: 14",
        "Science — End of Term Test",
        "",
        "1. The three states of matter are:",
        "   solid, liquid and gas",
        "",
        "2. The chemical symbol for water is H2O",
        "",
        "3. Newton's First Law: An object at rest stays",
        "   at rest unless acted upon by a force",
        "",
        "4. Photosynthesis is when plants make food",
        "   using sunlight.",
        "   Carbon dioxide + water → glucose + oxygen",
        "",
        "5. Electrical energy to light energy",
        "   Electrical energy to heat energy",
        "",
        "6. (a) Speed = distance / time",
        "       Speed = 120 / 2 = 60 km/h",
        "",
        "   (b) Time = distance / speed",
        "       Time = 200 / 80 = 2.5 hours",
        "",
        "7. [diagram drawn — water evaporates from",
        "    ocean, forms clouds, rains, flows back]",
        "   Water evaporates from rivers and oceans.",
        "   It forms clouds and falls as rain.",
        "",
        "8. A conductor allows electricity to pass.",
        "   Example: copper wire",
        "   An insulator does not allow electricity.",
        "   Example: rubber",
    ],
    "student_submission.jpg",
    bg=(252, 248, 235),
)

# ── Student submission 2 ──────────────────────────────────────────────────────
make_image(
    [
        "## Chiedza Mutasa      Form 2B        Roll: 07",
        "Science — End of Term Test",
        "",
        "1. Solid, liqiud, gas",
        "",
        "2. Water = H2O",
        "",
        "3. A moving object keeps moving",
        "   and a still one stays still",
        "",
        "4. Photosinthesis: plants use sun to make food",
        "   CO2 + H2O + sunlight → food + O2",
        "",
        "5. Heat and light",
        "",
        "6. (a) 120 ÷ 2 = 60km per hour",
        "",
        "   (b) 200 ÷ 80 = 3 hours  [sic]",
        "",
        "7. Sun heats water. Water becomes vapour.",
        "   Vapour rises, cools, makes clouds.",
        "   Clouds give rain. Rain fills rivers.",
        "",
        "8. Conductor = lets electricity through e.g. metal",
        "   Insulator = blocks electricity e.g. plastic",
    ],
    "student_submission_2.jpg",
    bg=(250, 245, 240),
)

print("\nPlaceholder images created. Replace with real exercise book photos before submission.")
