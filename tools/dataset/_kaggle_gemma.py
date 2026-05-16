"""Kaggle-side Gemma 4 wrapper for the dataset extractors.

Production routing stays on Vertex AI (``shared/gemma_client.py``).
This module is for the **one-time data-extraction step** that runs
inside a Kaggle notebook so we don't burn Vertex quota / spend to
build the fine-tune dataset.

Both extractors accept an injectable ``caller``:

- ``from_syllabuses.GemmaCaller   = Callable[[str], str]``
- ``from_exercise_books.VisionCaller = Callable[[bytes, str], str]``

We expose two factory functions here that return objects matching
those signatures, backed by a HuggingFace ``transformers`` model
that Kaggle hosts for free under "Models".

Typical Kaggle-notebook usage:

    !pip install -q -U transformers accelerate pillow
    from tools.dataset._kaggle_gemma import (
        make_text_caller, make_vision_caller,
    )
    from tools.dataset.from_syllabuses     import build_examples as syl_examples, iter_chunks
    from tools.dataset.from_exercise_books import build_examples as eb_examples,  iter_images
    from tools.dataset.format              import write_examples

    text_call   = make_text_caller(model_id="google/gemma-4-9b-it")
    vision_call = make_vision_caller(model_id="google/gemma-4-9b-it")  # whichever variant Kaggle hosts

    with open("/kaggle/working/syllabuses.jsonl", "w") as f:
        write_examples(f, syl_examples(iter_chunks(Path("/kaggle/input/zim-syllabuses")),
                                       caller=text_call))
    with open("/kaggle/working/exercise_books.jsonl", "w") as f:
        write_examples(f, eb_examples(iter_images(Path("/kaggle/input/<dataset-slug>")),
                                      caller=vision_call,
                                      subject="Mathematics", education_level="Grade 4"))

The factories defer the ``transformers``/``torch`` import to call
time so the rest of the dataset module (and our test suite) stays
lightweight on machines without a Kaggle-grade GPU.
"""

from __future__ import annotations

import io
import logging
from typing import Callable


logger = logging.getLogger(__name__)


# ─── Defaults ────────────────────────────────────────────────────────────────

# Kaggle's "Models" tab hosts these for free; pin via env / arg if you
# bump versions. Vision model is named separately because the IT and
# multimodal checkpoints aren't always the same.
_DEFAULT_TEXT_MODEL = "google/gemma-4-9b-it"
_DEFAULT_VISION_MODEL = "google/gemma-4-9b-it"

# Per-call generation cap. Long-tailed enough for Q/A and graded
# verdict JSON; tune in the notebook if you need bigger outputs.
_DEFAULT_MAX_NEW_TOKENS = 2048


# ─── Text caller ─────────────────────────────────────────────────────────────


def make_text_caller(
    *,
    model_id: str = _DEFAULT_TEXT_MODEL,
    max_new_tokens: int = _DEFAULT_MAX_NEW_TOKENS,
    dtype: str = "bfloat16",
) -> Callable[[str], str]:
    """Return a function compatible with ``GemmaCaller`` that runs
    Gemma 4 on the local Kaggle GPU.

    ``dtype`` is "bfloat16" by default; Kaggle's T4 falls back to
    "float16" if bf16 is unsupported — the loader detects and warns.
    """
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch_dtype = _resolve_dtype(dtype)
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(
        model_id, torch_dtype=torch_dtype, device_map="auto",
    )
    model.eval()

    def _call(prompt: str) -> str:
        messages = [{"role": "user", "content": prompt}]
        inputs = tokenizer.apply_chat_template(
            messages,
            return_tensors="pt",
            add_generation_prompt=True,
        ).to(model.device)
        with torch.inference_mode():
            outputs = model.generate(
                inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
            )
        new_tokens = outputs[0][inputs.shape[-1]:]
        return tokenizer.decode(new_tokens, skip_special_tokens=True).strip()

    return _call


# ─── Vision caller ───────────────────────────────────────────────────────────


def make_vision_caller(
    *,
    model_id: str = _DEFAULT_VISION_MODEL,
    max_new_tokens: int = _DEFAULT_MAX_NEW_TOKENS,
    dtype: str = "bfloat16",
) -> Callable[[bytes, str], str]:
    """Return a function compatible with ``VisionCaller`` that runs
    Gemma 4 multimodal on the local Kaggle GPU.

    The HF ``transformers`` API for vision-capable IT models is the
    same chat-template path as text; we just inject an image
    placeholder turn.

    Kaggle's vision Gemma may live under a different model id than
    the text-only one. Pass it via ``model_id`` if so.
    """
    import torch
    from PIL import Image
    from transformers import AutoModelForCausalLM, AutoProcessor

    torch_dtype = _resolve_dtype(dtype)
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(
        model_id, torch_dtype=torch_dtype, device_map="auto",
    )
    model.eval()

    def _call(image_bytes: bytes, prompt: str) -> str:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)
        with torch.inference_mode():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
            )
        new_tokens = outputs[0][inputs["input_ids"].shape[-1]:]
        return processor.decode(new_tokens, skip_special_tokens=True).strip()

    return _call


# ─── Helpers ────────────────────────────────────────────────────────────────


_VALID_DTYPES = ("bfloat16", "float16", "float32")


def _resolve_dtype(name: str):
    """Return a torch dtype, falling back to fp16 on cards that don't
    support bf16. Kaggle T4 is fp16-only; A100/L4 do bf16.

    Name validation happens before the torch import so the error
    message is the same on dev machines without torch installed."""
    if name not in _VALID_DTYPES:
        raise ValueError(f"unknown dtype: {name}")

    import torch

    if name == "bfloat16":
        if hasattr(torch.cuda, "is_bf16_supported") and torch.cuda.is_bf16_supported():
            return torch.bfloat16
        logger.warning("[kaggle_gemma] bf16 unsupported on this GPU — falling back to fp16")
        return torch.float16
    if name == "float16":
        return torch.float16
    return torch.float32
