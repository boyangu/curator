"""Cloud GPU executor for curator-mir (Modal).

Deploy once from apps/mir:   uv run --extra cloud modal deploy modal_app.py
Weights download into a persistent Volume on first use; the container runs the
same curator_mir code as the desktop (batch.run_batch), with CUDA torch.
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libsndfile1", "ffmpeg")
    .pip_install(
        "torch==2.11.0", "torchaudio==2.11.0", "transformers==4.53.2", "muq==0.1.0",
        "einops", "librosa", "nnAudio", "tqdm", "easydict", "x-clip",
        "numpy<3", "soundfile", "av", "soxr", "huggingface-hub", "safetensors",
    )
    .env({"HF_HOME": "/models/hf"})
    .add_local_python_source("curator_mir")
)
app = modal.App("curator-mir", image=image)
weights = modal.Volume.from_name("curator-mir-models", create_if_missing=True)


@app.cls(gpu="L4", volumes={"/models": weights}, timeout=3600, scaledown_window=120)
class MirGpu:
    @modal.enter()
    def start(self):
        from curator_mir.engine import Engine

        self.engine = Engine(device="cuda", max_loaded=3)

    @modal.method()
    def embed_batch(self, items: list[dict], models: list[str]) -> list[dict]:
        from curator_mir.batch import run_batch

        out = run_batch(self.engine, items, models)
        weights.commit()  # persist any weights fetched on this run
        return out
