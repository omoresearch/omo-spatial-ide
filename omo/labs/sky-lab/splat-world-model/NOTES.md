# splat-world-model — notes

Strategy: real photogrammetric/generative Gaussian-splat city (Skyfall-GS NYC tiles, Apache-2.0) rendered by Spark 2.4 inside
three.js r180, and a normal three.js mesh penthouse in front of it. Spark sorts the splats together with the meshes in one pass.

Pipeline
1. tools_ply2splat.py: 3DGS PLY (SH1, 104 B/splat) -> .splat (32 B/splat). Drops splats with opacity < 0.04. 213 MB -> 57 MB.
2. tools_dusk_relight.py: bakes a dusk grade + lit windows into the splat colours (source .splat kept unchanged).
3. index.html: 3 tiles (7.76 M splats total), room at 300 m, scripted tour, WASD + drag-look. 60 fps on an RTX 5060 Ti.

Judge scores (vision, 4-shot sheet): round 1 = 5, round 2 = 6, round 3 = 5, round 4 = 5. Paired A/B of round 2 vs round 4: 6.5 vs 8 (round 4 kept).
Final look-down shot alone: 5.

Close vs far (study/close-vs-far-sheet.png)
- ~450 m away, 300 m up (the penthouse view): reads as a real city at a glance. Soft facades, some fuzzy trees, speckle.
- 150-200 m: still a city, but towers smear, there are floaters and needle splats on trees.
- 40-100 m: breaks down into blobs. Not usable.
- street level: abstract haze.
So for this source data, splats work only as a distant backdrop. That suits a penthouse, but the look-down view shows the smear.
- Monitor text stays crisp (study/e-monitor-closeup.png; vision transcribed it line by line) because the monitors are normal meshes with a CanvasTexture.

Generating our own NYC splat locally: not attempted (disk ~4 GB free, rule: no weights > 1 GB).
- FlashWorld (github.com/imlixinyang/FlashWorld): Wan-5B based, about 51 GB VRAM by default, 30 GB with T5 offload,
  24 GB with more offload, slow < 10 GB mode. Weights tens of GB. Weights licence is non-commercial share-alike.
  On this PC (2 x 16 GB) it would need the heavy-offload mode.
- Lyra / Lyra 2.0 (github.com/nv-tlabs/lyra): Cosmos / WAN-14B video diffusion + 3DGS decoder. Tested only on A100/H100 (80 GB);
  full model offload flags exist for smaller GPUs. Weights are many tens of GB. NVIDIA Open Model License.
