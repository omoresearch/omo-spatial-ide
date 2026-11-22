# Downloads CC0 assets from Poly Haven (api.polyhaven.com) into ./assets and writes assets/manifest.json
import json, os, urllib.request, sys
UA={"User-Agent":"omo-sky-lab/1.0 (research)"}
def get(url): return urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=60).read()
def files(id): return json.loads(get(f"https://api.polyhaven.com/files/{id}"))
man={"hdri":{},"models":{},"textures":{}}
def save(url,path):
    os.makedirs(os.path.dirname(path),exist_ok=True)
    if not os.path.exists(path): open(path,'wb').write(get(url))
    return path
for id,res in [("sunset_jhbcentral","2k"),("sunset_jhbcentral","4k")]:
    f=files(id)['hdri'][res]['hdr']; p=save(f['url'],f"assets/hdri/{id}_{res}.hdr"); man['hdri'][f"{id}_{res}"]={"path":p,"src":f['url']}
MODELS=sys.argv[1].split(',')
for id in MODELS:
    g=files(id)['gltf']['1k']['gltf']; d=f"assets/models/{id}"
    save(g['url'],f"{d}/{id}.gltf")
    for rel,v in g.get('include',{}).items(): save(v['url'],f"{d}/{rel}")
    man['models'][id]={"path":f"{d}/{id}.gltf","src":f"https://polyhaven.com/a/{id}"}
    print('model',id)
TEX=sys.argv[2].split(',')
for id in TEX:
    f=files(id); man['textures'][id]={"src":f"https://polyhaven.com/a/{id}","maps":{}}
    for m in ['Diffuse','nor_gl','arm','Rough']:
        if m in f and '1k' in f[m]:
            u=f[m]['1k']['jpg']['url']; p=save(u,f"assets/tex/{id}/{os.path.basename(u)}"); man['textures'][id]['maps'][m]=p
    print('tex',id)
json.dump(man,open('assets/manifest.json','w'),indent=1)
