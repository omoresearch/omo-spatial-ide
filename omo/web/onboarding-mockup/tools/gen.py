"""Generate Omo Space landing images via Harry's ChatGPT subscription (Codex OAuth), no API key.
Request names gpt-image-2.6-sunburst (ChatGPT Images 2.6, Sunburst = the high-quality tier).
Usage: venv/bin/python gen.py prompts.json [only_id ...]"""
import importlib, sys, json, base64, time, pathlib
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, "~/.hermes/hermes-agent")
codex = importlib.import_module("plugins.image_gen.openai-codex")
MODEL = "gpt-image-2.6-sunburst"
codex.API_MODEL = MODEL
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "images" / "originals"
STYLE = pathlib.Path(ROOT / "tools" / "style.txt").read_text().strip()
prompts = json.load(open(sys.argv[1]))
only = set(sys.argv[2:])
tok, url = codex._read_codex_credential()
assert tok, "no Codex OAuth credential"
manifest_path = ROOT / "images" / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

def run(item):
    pid, prompt = item["id"], item["prompt"] + "\n\n" + STYLE
    for attempt in range(3):
        try:
            t = time.time()
            p = codex._post_image_request(tok, prompt=prompt, size=item.get("size", "1536x1024"),
                                          quality="high", input_images=None, base_url=url)
            raw = base64.b64decode(p["data"][0]["b64_json"])
            v = 1
            while (OUT / f"{pid}-v{v}.png").exists(): v += 1
            f = OUT / f"{pid}-v{v}.png"
            f.write_bytes(raw)
            meta = {k: v2 for k, v2 in p.items() if k != "data"}
            meta["data_fields"] = [{k: v2 for k, v2 in d.items() if k != "b64_json"} for d in p["data"]]
            return pid, {"file": str(f), "requested_model": MODEL, "route": "openai-codex (ChatGPT subscription OAuth)",
                         "pixels": codex._png_pixel_size(raw), "seconds": round(time.time() - t, 1),
                         "server_fields": meta, "prompt": prompt}
        except Exception as e:
            err = str(e); time.sleep(5)
    return pid, {"error": err}

items = [i for i in prompts if not only or i["id"] in only]
with ThreadPoolExecutor(4) as ex:
    for pid, res in ex.map(run, items):
        print(pid, res.get("file"), res.get("pixels"), res.get("seconds"), res.get("error", ""), flush=True)
        if "file" in res:
            manifest.setdefault(pid, []).append(res)
manifest_path.write_text(json.dumps(manifest, indent=2, default=str))
