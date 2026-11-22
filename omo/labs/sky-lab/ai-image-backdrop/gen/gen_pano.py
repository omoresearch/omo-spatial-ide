"""Local 360-degree Manhattan-at-dusk panorama with segmind/tiny-sd (SD1.5 distilled) on the local GPU.

MultiDiffusion over a horizontally-wrapping latent: every 64x64 latent window is denoised as a normal 512px SD
image, the noise predictions are blended (gaussian weights) into one full-size eps map, and one scheduler step is
taken on the full latent (so a multistep solver keeps a consistent state). Prompts are blended per window by
elevation (sky -> skyline -> streets below) and by azimuth (sunset glow to the west).
Pass 1: 4096x1024 from noise.  Pass 2: 2x bicubic upscale -> 8192x2048, img2img refine at strength S2.
Output: equirect band covering 360 deg x 90 deg (pixel aspect 1:1 in degrees).
"""
import math, os, sys, time, json
import torch, numpy as np
from PIL import Image
from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, '..', 'models', 'tiny-sd')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'pano')
SEED = int(os.environ.get('SEED', 7))
W1, H1 = int(os.environ.get('W1', 4096)), int(os.environ.get('H1', 1024))
STEPS1, STEPS2, S2 = int(os.environ.get('STEPS1', 30)), int(os.environ.get('STEPS2', 30)), float(os.environ.get('S2', 0.42))
CFG = float(os.environ.get('CFG', 7.0))
UPSCALE = int(os.environ.get('UPSCALE', 2))
dev, dt = 'cuda', torch.float16

pipe = StableDiffusionPipeline.from_pretrained(MODEL, torch_dtype=dt, safety_checker=None, requires_safety_checker=False).to(dev)
pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True, algorithm_type='dpmsolver++')
pipe.vae.enable_tiling()
unet, vae, sched = pipe.unet, pipe.vae, pipe.scheduler

Q = 'RAW photo, 8k uhd, dslr, highly detailed, sharp focus, award winning architectural photography'
P = {
    'sky_warm': f'{Q}, twilight sky over New York, deep blue sky fading to warm orange and pink sunset glow, soft wispy clouds, clean gradient sky',
    'sky_cool': f'{Q}, blue hour sky over New York, deep indigo and violet twilight sky, faint soft clouds, clean gradient sky',
    'sky_line_warm': f'{Q}, Manhattan skyline at dusk seen from a penthouse, distant skyscrapers silhouetted against orange sunset glow, Hudson river, New Jersey on the horizon',
    'sky_line_cool': f'{Q}, Manhattan skyline at blue hour seen from a penthouse, distant skyscrapers with glowing windows against deep blue sky, hazy horizon',
    'city': f'{Q}, aerial view of Manhattan at dusk from the top of a supertall skyscraper, dense skyscrapers and rooftops with thousands of warm glowing windows, city lights',
    'streets': f'{Q}, looking straight down from a supertall skyscraper at New York city streets at night, avenues with car light trails, rooftops, street lights, dense city grid',
}
NEG = 'text, watermark, logo, signature, letters, people, person, blurry, cartoon, painting, illustration, cgi, deformed, low quality, jpeg artifacts, frame, border, window frame, interior, airplane, birds, fisheye'


@torch.no_grad()
def emb(text):
    ids = pipe.tokenizer(text, padding='max_length', max_length=77, truncation=True, return_tensors='pt').input_ids.to(dev)
    return pipe.text_encoder(ids)[0]


E = {k: emb(v) for k, v in P.items()}
EN = emb(NEG)
WEST = math.radians(float(os.environ.get('WEST_DEG', 90)))  # azimuth (deg from u=0) where the sunset glows


def prompt_for(cy, cx, lh, lw):
    """Blend prompt embeddings for a window centred at latent (cy, cx). Elevation: top=+20deg, bottom=-70deg."""
    v = cy / lh  # 0 top .. 1 bottom
    lon = cx / lw * 2 * math.pi
    warm = max(0.0, math.cos(lon - WEST)) ** 1.5
    sky = E['sky_warm'] * warm + E['sky_cool'] * (1 - warm)
    line = E['sky_line_warm'] * warm + E['sky_line_cool'] * (1 - warm)
    # piecewise-linear bands over v
    keys = [(0.0, sky), (0.22, sky), (0.36, line), (0.55, E['city']), (0.85, E['streets']), (1.0, E['streets'])]
    for (a, ea), (b, eb) in zip(keys, keys[1:]):
        if v <= b:
            f = 0 if b == a else (v - a) / (b - a)
            return ea * (1 - f) + eb * f
    return keys[-1][1]


def gauss(n, s=0.5):
    x = torch.linspace(-1, 1, n)
    return torch.exp(-(x ** 2) / (2 * s * s))


GW = (gauss(64)[:, None] * gauss(64)[None, :]).to(dev, dt)


@torch.no_grad()
def multidiffuse(lat, timesteps, sy, sx, batch=12):
    _, C, lh, lw = lat.shape
    ys = list(range(0, lh - 64 + 1, sy))
    if ys[-1] != lh - 64:
        ys.append(lh - 64)
    xs = list(range(0, lw, sx))
    wins = [(y, x) for y in ys for x in xs]
    conds = [prompt_for(y + 32, x + 32, lh, lw) for (y, x) in wins]
    for i, t in enumerate(timesteps):
        t0 = time.time()
        eps = torch.zeros_like(lat)
        cnt = torch.zeros((1, 1, lh, lw), device=dev, dtype=dt)
        for b in range(0, len(wins), batch):
            chunk = wins[b:b + batch]
            tiles = []
            for (y, x) in chunk:
                idx = torch.arange(x, x + 64, device=dev) % lw
                tiles.append(lat[:, :, y:y + 64, :].index_select(3, idx))
            tiles = torch.cat(tiles)
            inp = sched.scale_model_input(torch.cat([tiles, tiles]), t)
            enc = torch.cat([torch.cat(conds[b:b + batch]), EN.expand(len(chunk), -1, -1)])
            out = unet(inp, t, encoder_hidden_states=enc).sample
            c, u = out.chunk(2)
            e = u + CFG * (c - u)
            for k, (y, x) in enumerate(chunk):
                idx = torch.arange(x, x + 64, device=dev) % lw
                eps[:, :, y:y + 64, :].index_add_(3, idx, (e[k:k + 1] * GW))
                cnt[:, :, y:y + 64, :].index_add_(3, idx, GW[None, None].expand(1, 1, 64, 64).contiguous())
        eps = eps / cnt
        lat = sched.step(eps, t, lat).prev_sample
        print(f'  step {i + 1}/{len(timesteps)} {time.time() - t0:.2f}s', flush=True)
    return lat


@torch.no_grad()
def decode(lat):
    pad = 16
    lw = lat.shape[3]
    l2 = torch.cat([lat[:, :, :, lw - pad:], lat, lat[:, :, :, :pad]], 3)
    img = vae.decode(l2 / vae.config.scaling_factor).sample
    img = img[:, :, :, pad * 8: -pad * 8]
    img = (img / 2 + 0.5).clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()
    return Image.fromarray((img * 255).round().astype(np.uint8))


@torch.no_grad()
def encode(pil):
    a = torch.from_numpy(np.asarray(pil).astype(np.float32) / 127.5 - 1).permute(2, 0, 1)[None].to(dev, dt)
    pad = 128
    a2 = torch.cat([a[:, :, :, -pad:], a, a[:, :, :, :pad]], 3)
    lat = vae.encode(a2).latent_dist.mean * vae.config.scaling_factor
    return lat[:, :, :, pad // 8: -pad // 8]


t_all = time.time()
g = torch.Generator(dev).manual_seed(SEED)
print(f'pass 1: {W1}x{H1}, {STEPS1} steps')
sched.set_timesteps(STEPS1, device=dev)
lat = torch.randn((1, 4, H1 // 8, W1 // 8), generator=g, device=dev, dtype=dt) * sched.init_noise_sigma
lat = multidiffuse(lat, sched.timesteps, 16, 16)
img1 = decode(lat)
img1.save(OUT + '-pass1.png')
print('pass1 saved', img1.size, f'{time.time() - t_all:.1f}s')

if UPSCALE > 1:
    W2, H2 = W1 * UPSCALE, H1 * UPSCALE
    print(f'pass 2: {W2}x{H2}, strength {S2}')
    up = img1.resize((W2, H2), Image.BICUBIC)
    lat0 = encode(up)
    sched.set_timesteps(STEPS2, device=dev)
    start = int(STEPS2 * (1 - S2))
    ts = sched.timesteps[start:]
    noise = torch.randn(lat0.shape, generator=g, device=dev, dtype=dt)
    lat = sched.add_noise(lat0, noise, ts[:1])
    sched._step_index = None
    sched.set_begin_index(start)
    lat = multidiffuse(lat, ts, 32, 32)
    img2 = decode(lat)
    img2.save(OUT + '-pass2.png')
    img2.convert('RGB').save(OUT + '.jpg', quality=92)
    print('pass2 saved', img2.size)
else:
    img1.convert('RGB').save(OUT + '.jpg', quality=92)
json.dump({'model': 'segmind/tiny-sd', 'seed': SEED, 'W1': W1, 'H1': H1, 'steps1': STEPS1, 'steps2': STEPS2, 'strength2': S2,
           'cfg': CFG, 'upscale': UPSCALE, 'west_deg': math.degrees(WEST), 'prompts': P, 'negative': NEG,
           'band_elevation_deg': [20, -70], 'seconds': round(time.time() - t_all, 1)}, open(OUT + '.json', 'w'), indent=1)
print('done', f'{time.time() - t_all:.1f}s')
