# ai-image-backdrop — assets and licences

## AI model (run locally on this PC's GPUs, no paid API)
- segmind/tiny-sd — https://huggingface.co/segmind/tiny-sd
  - Licence: CreativeML OpenRAIL-M (distilled from SG161222/Realistic_Vision_V4.0, an SD 1.5 fine-tune). Free use incl. commercial, with the OpenRAIL use restrictions.
  - Files used: unet (647 MB), text_encoder (246 MB), vae (167 MB), configs + tokenizer. Total 1013 MB in `models/tiny-sd/`.
  - Why this one: the existing ComfyUI install (~/ai/comfy/ComfyUI) has empty model folders (the Qwen-Image 2.1 weights, ~17 GB, are no longer on disk), and nothing else on disk is an image model. tiny-sd was the only photoreal model that fits the 1.5 GB lane budget. sd-turbo (fp16 unet + text encoder + vae, about 2.6 GB) and Qwen-Image 2.1 int8 (about 17.3 GB) would not fit.
- Runtime: the existing ComfyUI venv (torch 2.14 + cu130, transformers 5.17), plus `diffusers==0.43.0` (Apache-2.0) installed with --no-deps into `.pydeps/` (39 MB). Nothing was installed system-wide.

## Generated images (outputs of the model above, made in this lane)
- `pano.jpg` (8192x2048, 360 x 90 degree equirect band, seed 21). Byte-identical copy of `gen/pano_s21.jpg` (md5 eeabff8c17f05e77affebf0fd24921da). The source PNGs `gen/pano_s21-pass1.png` and `gen/pano_s21-pass2.png` are kept, with the prompt and settings in `gen/pano_s21.json`.
- `gen/pano_s7*` is the alternative seed. It was used in rounds 1-5, then lost a side-by-side A/B test.
- `gen/ground*.jpg` are top-down street tiles. They were rejected because vision scored them 3-4/10 (they read as building fronts, not a view from above). They are not used in the scene.
- Method (`gen/gen_pano.py`): MultiDiffusion over a horizontally wrapping latent, using 64x64 latent windows with gaussian blending. The prompt blends by elevation (sky, then skyline, then city, then streets) and by azimuth (sunset to the west). Pass 1 is 4096x1024 at 30 steps. Pass 2 is a 2x upscale plus img2img at strength 0.42 to 8192x2048. Each panorama takes about 285 s on one RTX 5060 Ti. Two seeds ran in parallel, one per GPU.

## Code / 3D
- three.js r180 is served by the harness at /three/ (MIT). Addons used: RoundedBoxGeometry, RectAreaLightUniformsLib, EffectComposer, RenderPass, GTAOPass, UnrealBloomPass, OutputPass.
- The interior is fully procedural and written for this lane. Wood, marble, rug and art textures are drawn with canvas. Terminal text is a CanvasTexture in DejaVu Sans Mono (a system font). No third-party meshes or textures.
