"""Seamless (wraps in x AND y) top-down night aerial tile of a Manhattan street grid, made locally with segmind/tiny-sd.
Same MultiDiffusion idea as gen_pano.py, but windows wrap on both axes and one prompt is used everywhere.
Projected in the scene onto a ground plane ~300 m below the camera, so steep downward views get true perspective."""
import os, sys, time, json
import torch, numpy as np
from PIL import Image
from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, '..', 'models', 'tiny-sd')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'ground')
SEED, S1, CFG = int(os.environ.get('SEED', 3)), int(os.environ.get('S1', 1024)), float(os.environ.get('CFG', 7.0))
dev, dt = 'cuda', torch.float16
pipe = StableDiffusionPipeline.from_pretrained(MODEL, torch_dtype=dt, safety_checker=None, requires_safety_checker=False).to(dev)
pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True, algorithm_type='dpmsolver++')
unet, vae, sched = pipe.unet, pipe.vae, pipe.scheduler
PROMPT = os.environ.get('PROMPT', 'RAW photo, satellite view looking straight down on Manhattan at night, orthographic top-down aerial photograph, dense city blocks and flat rooftops, rooftop water tanks, avenues glowing with orange street lights, white and red car light trails on the streets, 8k, highly detailed, sharp focus')
NEG = 'text, watermark, logo, letters, people, blurry, cartoon, painting, illustration, cgi, perspective, horizon, sky, skyline, tilt, fisheye, frame, border, low quality'


@torch.no_grad()
def emb(t):
    ids = pipe.tokenizer(t, padding='max_length', max_length=77, truncation=True, return_tensors='pt').input_ids.to(dev)
    return pipe.text_encoder(ids)[0]


EC, EN = emb(PROMPT), emb(NEG)
gw = torch.exp(-(torch.linspace(-1, 1, 64) ** 2) / 0.5)
GW = (gw[:, None] * gw[None, :]).to(dev, dt)


@torch.no_grad()
def md(lat, ts, st, batch=12):
    _, C, lh, lw = lat.shape
    wins = [(y, x) for y in range(0, lh, st) for x in range(0, lw, st)]
    for i, t in enumerate(ts):
        eps = torch.zeros_like(lat); cnt = torch.zeros((1, 1, lh, lw), device=dev, dtype=dt)
        for b in range(0, len(wins), batch):
            ch = wins[b:b + batch]
            tiles = torch.cat([lat.roll((-y, -x), (2, 3))[:, :, :64, :64] for (y, x) in ch])
            inp = sched.scale_model_input(torch.cat([tiles, tiles]), t)
            enc = torch.cat([EC.expand(len(ch), -1, -1), EN.expand(len(ch), -1, -1)])
            c, u = unet(inp, t, encoder_hidden_states=enc).sample.chunk(2)
            e = u + CFG * (c - u)
            for k, (y, x) in enumerate(ch):
                pe = torch.zeros_like(lat); pe[:, :, :64, :64] = e[k:k + 1] * GW
                pc = torch.zeros_like(cnt); pc[:, :, :64, :64] = GW
                eps += pe.roll((y, x), (2, 3)); cnt += pc.roll((y, x), (2, 3))
        lat = sched.step(eps / cnt, t, lat).prev_sample
        print(f'  step {i + 1}/{len(ts)}', flush=True)
    return lat


@torch.no_grad()
def dec(lat):
    p = 16
    l2 = lat.roll((p, p), (2, 3)); l2 = torch.cat([l2, l2[:, :, :2 * p]], 2); l2 = torch.cat([l2, l2[:, :, :, :2 * p]], 3)
    img = vae.decode(l2 / vae.config.scaling_factor).sample[:, :, p * 8:p * 8 + lat.shape[2] * 8, p * 8:p * 8 + lat.shape[3] * 8]
    return Image.fromarray(((img / 2 + 0.5).clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy() * 255).round().astype(np.uint8))


@torch.no_grad()
def enc(pil):
    a = torch.from_numpy(np.asarray(pil).astype(np.float32) / 127.5 - 1).permute(2, 0, 1)[None].to(dev, dt)
    p = 128
    a2 = torch.cat([a[:, :, -p:], a, a[:, :, :p]], 2); a2 = torch.cat([a2[:, :, :, -p:], a2, a2[:, :, :, :p]], 3)
    vae.enable_tiling()
    return (vae.encode(a2).latent_dist.mean * vae.config.scaling_factor)[:, :, p // 8:-p // 8, p // 8:-p // 8]


t0 = time.time(); g = torch.Generator(dev).manual_seed(SEED)
sched.set_timesteps(30, device=dev)
lat = torch.randn((1, 4, S1 // 8, S1 // 8), generator=g, device=dev, dtype=dt) * sched.init_noise_sigma
lat = md(lat, sched.timesteps, 16)
im1 = dec(lat); im1.save(OUT + '-pass1.png')
up = im1.resize((S1 * 2, S1 * 2), Image.BICUBIC)
l0 = enc(up); vae.disable_tiling()
sched.set_timesteps(30, device=dev); start = int(30 * 0.6); ts = sched.timesteps[start:]
lat = sched.add_noise(l0, torch.randn(l0.shape, generator=g, device=dev, dtype=dt), ts[:1]); sched._step_index = None; sched.set_begin_index(start)
lat = md(lat, ts, 32)
vae.enable_tiling()
im2 = dec(lat); im2.convert('RGB').save(OUT + '.jpg', quality=92)
json.dump({'model': 'segmind/tiny-sd', 'seed': SEED, 'size': im2.size, 'prompt': PROMPT, 'negative': NEG, 'cfg': CFG, 'pass2_strength': 0.4, 'seconds': round(time.time() - t0, 1)}, open(OUT + '.json', 'w'), indent=1)
print('done', im2.size, f'{time.time() - t0:.1f}s')
