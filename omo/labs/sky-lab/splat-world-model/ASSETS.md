# Assets — splat-world-model

| File | What | Source URL | Licence |
|---|---|---|---|
| vendor/spark.module.js | Spark 2.4.0 Gaussian-splat renderer for three.js (ESM; the Rust/WASM sort + decode module is inlined in this file, so there is no separate .wasm) | `npm pack @sparkjsdev/spark` (2.4.0), https://github.com/sparkjsdev/spark | MIT (vendor/SPARK-LICENSE), by World Labs |
| assets/NYC_004.splat | Skyfall-GS tile NYC_004 (Lower Manhattan waterfront + towers), converted from the original PLY to .splat (DC colour only, splats with opacity < 0.04 dropped) | https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/NYC_004_final.ply | Apache-2.0 (model card) |
| assets/NYC_219.splat | Skyfall-GS tile NYC_219 (dense low-rise NYC block), same conversion | https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/NYC_219_final.ply | Apache-2.0 |
| assets/NYC_010.splat | Skyfall-GS tile NYC_010 (dense low-rise NYC block), same conversion | https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/NYC_010_final.ply | Apache-2.0 |
| assets/NYC_*_dusk.splat | Derived from the files above by tools_dusk_relight.py: dusk colour grade, warm rim light, about 3.5% of facade splats recoloured as lit windows, about 1% street splats as sodium lights. The non-dusk .splat files are kept unchanged as the source. | derived | Apache-2.0 (derivative; this change is recorded here) |
| three.js r180 | served by the harness at /three/ | the harness | MIT |

Everything else (room, furniture, plants, art, terminal text, sky gradient, distant city-light points) is made in code inside index.html. There are no image files.

Notes on the splat data
- Skyfall-GS (Lee et al., arXiv 2510.15869) makes these tiles from **satellite images** plus diffusion refinement, not from a drone or street capture. Each tile is about 800 m x 800 m of real New York. The tiles are not adjacent: the neighbours placed beside NYC_004 are a layout for the view, not true geography.
- The original PLYs (213–325 MB each) were deleted after conversion to save disk (the disk had about 4–8 GB free). To get them again: `curl -L -o X.ply https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/NYC_004_final.ply`, then `python3 tools_ply2splat.py X.ply X.splat`.
