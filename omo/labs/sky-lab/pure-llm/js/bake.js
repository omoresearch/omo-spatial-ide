// GPU texture baker: renders procedural GLSL material functions into mip-mapped render targets.
// Each material source defines: vec3 albedo(vec2 uv); float rough(vec2 uv); float height(vec2 uv);
import * as THREE from 'three';
import { NOISE } from './shaders.js';

const quad = new THREE.PlaneGeometry(2, 2);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export function makeBaker(renderer) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  function pass(src, mode, w, h, srgb, strength) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, anisotropy: aniso,
    });
    const mat = new THREE.ShaderMaterial({
      defines: { MODE: mode },
      uniforms: { uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uStrength: { value: strength } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
      fragmentShader: `varying vec2 vUv; uniform vec2 uTexel; uniform float uStrength;\n${NOISE}\n${src}\n
      void main(){ vec2 uv=vUv;
      #if MODE==0
        gl_FragColor=vec4(clamp(albedo(uv),0.,1.),1.);
      #elif MODE==1
        gl_FragColor=vec4(1.,clamp(rough(uv),0.02,1.),0.,1.);
      #else
        float hL=height(uv-vec2(uTexel.x,0.)), hR=height(uv+vec2(uTexel.x,0.));
        float hD=height(uv-vec2(0.,uTexel.y)), hU=height(uv+vec2(0.,uTexel.y));
        vec3 n=normalize(vec3((hL-hR)*uStrength,(hD-hU)*uStrength,1.));
        gl_FragColor=vec4(n*.5+.5,1.);
      #endif
      }`,
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(quad, mat);
    const prevTM = renderer.toneMapping;
    renderer.setRenderTarget(rt);
    renderer.render(mesh, cam);
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTM;
    mat.dispose();
    return rt.texture;
  }
  return function bake(src, { w = 1024, h = 1024, normal = 0, rough = true } = {}) {
    const out = { map: pass(src, 0, w, h, true, 0) };
    if (rough) out.roughnessMap = pass(src, 1, w, h, false, 0);
    if (normal > 0) out.normalMap = pass(src, 2, w, h, false, normal);
    return out;
  };
}

// ---------------------------------------------------------------- material sources
export const SRC = {
  // wide-plank oak, tile = 4.8 m
  oak: `
  void plank(vec2 p, out vec2 lp, out float pid, out float sd){
    float rowW=0.24; float row=floor(p.y/rowW); float rr=mod(row,20.);
    float o=hash11(rr*7.13+1.)*4.8; float L=1.6;
    float xs=mod(p.x+o,4.8); float idx=floor(xs/L);
    lp=vec2(xs-idx*L, p.y-row*rowW); pid=hash12(vec2(rr,idx)+3.1);
    sd=min(min(lp.x,L-lp.x),min(lp.y,rowW-lp.y));
  }
  float grain(vec2 lp,float pid){
    float warp=fbm(vec2(lp.x*0.55,lp.y*4.)+pid*37.);
    float ph=lp.y*46.+warp*7.+sin(lp.x*1.7+pid*6.)*1.3;
    float rings=pow(abs(sin(ph)),7.);
    float fib=fbm(vec2(lp.x*2.5,lp.y*160.)+pid*11.);
    float fleck=smoothstep(.78,.95,fbm(vec2(lp.x*9.,lp.y*60.)+pid*3.));
    return clamp(rings*.55+fib*.45-fleck*.15,0.,1.);
  }
  vec3 albedo(vec2 uv){ vec2 p=uv*4.8; vec2 lp; float pid,sd; plank(p,lp,pid,sd);
    float g=grain(lp,pid);
    vec3 base=mix(vec3(0.40,0.25,0.135),vec3(0.52,0.35,0.20),hash12(vec2(pid*13.,1.)));
    base*=0.85+0.3*hash12(vec2(pid*17.,2.));
    vec3 c=mix(base,base*vec3(0.58,0.50,0.44),g);
    c*=0.93+0.07*fbm(p*3.);
    float seam=1.-smoothstep(0.0006,0.0026,sd);
    return mix(c,c*0.25,seam);
  }
  float rough(vec2 uv){ vec2 p=uv*4.8; vec2 lp; float pid,sd; plank(p,lp,pid,sd);
    return 0.42+0.18*grain(lp,pid)+0.1*(fbm(p*6.)-.5)+ (1.-smoothstep(0.,0.003,sd))*0.4; }
  float height(vec2 uv){ vec2 p=uv*4.8; vec2 lp; float pid,sd; plank(p,lp,pid,sd);
    return smoothstep(0.,0.004,sd)*1.0 - grain(lp,pid)*0.12 + fbm(p*2.)*0.2; }
  `,
  // walnut, tile 1.6 m
  walnut: `
  float g2(vec2 p){ float w=fbm(vec2(p.x*0.6,p.y*3.)); float ph=p.y*34.+w*8.+0.8*sin(p.x*2.1);
    float cath=abs(p.y-0.8-0.25*sin(p.x*1.2)-0.1*fbm(p*2.)); float ph2=cath*60.;
    float r=pow(abs(sin(mix(ph,ph2,smoothstep(.4,.05,cath)))),5.);
    return clamp(r*.6+fbm(vec2(p.x*3.,p.y*140.))*.4,0.,1.); }
  vec3 albedo(vec2 uv){ vec2 p=uv*1.6; float g=g2(p);
    vec3 b=vec3(0.115,0.058,0.032)*(0.9+0.2*fbm(p*1.5));
    return mix(b*1.25,b*0.55,g); }
  float rough(vec2 uv){ return 0.36+0.14*g2(uv*1.6); }
  float height(vec2 uv){ return -g2(uv*1.6)*0.3; }
  `,
  // fluted walnut panelling, tile 1.6 m, 32 flutes
  flute: `
  vec3 albedo(vec2 uv){ vec2 p=uv*1.6; float g=pow(abs(sin(p.y*30.+fbm(vec2(p.x*.6,p.y*3.))*8.)),5.);
    vec3 b=vec3(0.11,0.056,0.031)*(0.9+0.2*fbm(p*1.5)); float f=fract(uv.x*32.);
    float groove=smoothstep(0.08,0.,abs(f-0.5)-0.42); return mix(b*1.2,b*0.6,g)*(1.-groove*0.5); }
  float rough(vec2 uv){ return 0.45; }
  float height(vec2 uv){ float f=fract(uv.x*32.); return sqrt(max(1.-pow(f*2.-1.,2.),0.)); }
  `,
  // calacatta-like marble, non tiling, mapped once (4m x 2m)
  marble: `
  vec3 albedo(vec2 uv){ vec2 p=uv*vec2(4.,2.)*0.9;
    vec2 q=p+vec2(fbm(p*1.3+3.),fbm(p*1.3+7.))*1.4;
    float v=abs(sin((q.x*0.9+q.y*1.7+fbm(q*2.2)*2.6)*2.0));
    float vein=1.-smoothstep(0.0,0.05+0.06*fbm(q*4.),v);
    float v2=abs(sin((q.x*2.6-q.y*1.1+fbm(q*4.5)*3.)*3.1));
    float fine=1.-smoothstep(0.,0.018,v2);
    vec3 base=vec3(0.80,0.785,0.75)*(0.95+0.05*fbm(p*9.));
    vec3 c=mix(base,vec3(0.30,0.29,0.28),vein*0.8);
    c=mix(c,vec3(0.55,0.46,0.34),fine*0.45*smoothstep(.3,.7,fbm(q*1.5)));
    return c; }
  float rough(vec2 uv){ return 0.08+0.05*fbm(uv*40.); }
  float height(vec2 uv){ return 0.; }
  `,
  // travertine-ish stone for coffee table (tile 1 m)
  travertine: `
  vec3 albedo(vec2 uv){ vec2 p=uv*1.0; float b=fbm(vec2(p.x*1.5,p.y*14.)+fbm(p*3.)*1.5);
    float pore=smoothstep(.72,.8,fbm(vec2(p.x*6.,p.y*40.)));
    vec3 c=mix(vec3(0.56,0.47,0.36),vec3(0.68,0.6,0.48),b); return c*(1.-pore*0.35); }
  float rough(vec2 uv){ return 0.5; }
  float height(vec2 uv){ return -smoothstep(.72,.8,fbm(vec2(uv.x*6.,uv.y*40.)))*0.3; }
  `,
  // boucle fabric, tile 0.25 m (period-safe tiled noise)
  boucle: `
  float hb(vec2 uv){ vec2 p=uv*90.; return tfbm(p,vec2(90.))*0.8+ tnoise(uv*360.,vec2(360.))*0.5; }
  vec3 albedo(vec2 uv){ float h=hb(uv); return vec3(0.70,0.66,0.60)*(0.72+0.45*h); }
  float rough(vec2 uv){ return 0.95; }
  float height(vec2 uv){ return hb(uv); }
  `,
  // tight woven mesh for task chairs, tile 0.1 m
  weave: `
  float hw(vec2 uv){ vec2 p=uv*80.; vec2 c=floor(p); vec2 f=fract(p)-.5; float o=mod(c.x+c.y,2.);
    float a=cos(f.y*3.14159)*(0.6+0.4*cos(f.x*3.14159)); float b=cos(f.x*3.14159)*(0.6+0.4*cos(f.y*3.14159));
    return mix(a,b,o)+tnoise(uv*40.,vec2(40.))*0.2; }
  vec3 albedo(vec2 uv){ return vec3(0.045,0.047,0.052)*(0.75+0.5*hw(uv)); }
  float rough(vec2 uv){ return 0.8; }
  float height(vec2 uv){ return hw(uv); }
  `,
  // wool rug mapped once over 3.6 x 2.6 m
  rug: `
  vec3 albedo(vec2 uv){ vec2 p=uv*vec2(3.6,2.6); vec2 e=min(p,vec2(3.6,2.6)-p); float edge=min(e.x,e.y);
    float wool=fbm(p*60.)*0.5+fbm(p*220.)*0.5;
    vec3 field=vec3(0.50,0.45,0.38); vec3 band=vec3(0.24,0.20,0.17);
    float b=smoothstep(0.17,0.16,edge)*smoothstep(0.10,0.11,edge);
    float lines=smoothstep(0.012,0.0,abs(fract((p.x+p.y*0.0)*1.4)-.5)-0.47)*smoothstep(0.25,0.3,edge);
    vec3 c=mix(field,band,b); c=mix(c,c*0.82,lines*0.6);
    c*=0.82+0.3*wool; c*=0.95+0.1*fbm(p*2.);
    return c; }
  float rough(vec2 uv){ return 1.; }
  float height(vec2 uv){ vec2 p=uv*vec2(3.6,2.6); return fbm(p*60.)*0.5+fbm(p*220.)*0.5; }
  `,
  // plaster / microcement, tile 3 m
  plaster: `
  vec3 albedo(vec2 uv){ vec2 p=uv*3.; float n=tfbm(uv*8.,vec2(8.))*0.6+tfbm(uv*40.,vec2(40.))*0.4;
    return vec3(0.74,0.72,0.69)*(0.93+0.09*n); }
  float rough(vec2 uv){ return 0.88+0.08*tfbm(uv*20.,vec2(20.)); }
  float height(vec2 uv){ return tfbm(uv*60.,vec2(60.))*0.15; }
  `,
  concrete: `
  vec3 albedo(vec2 uv){ float n=tfbm(uv*6.,vec2(6.))*0.6+tfbm(uv*50.,vec2(50.))*0.4;
    float pore=smoothstep(.75,.82,tnoise(uv*300.,vec2(300.)));
    return vec3(0.42,0.41,0.40)*(0.85+0.25*n)*(1.-pore*0.3); }
  float rough(vec2 uv){ return 0.8; }
  float height(vec2 uv){ return -smoothstep(.75,.82,tnoise(uv*300.,vec2(300.)))*0.4+tfbm(uv*30.,vec2(30.))*0.2; }
  `,
  // brushed bronze, tile 1 m, vertical brushing
  bronze: `
  vec3 albedo(vec2 uv){ float s=tnoise(vec2(uv.x*900.,uv.y*6.),vec2(900.,6.)); return vec3(0.42,0.30,0.20)*(0.9+0.15*s); }
  float rough(vec2 uv){ float s=tnoise(vec2(uv.x*900.,uv.y*6.),vec2(900.,6.)); return 0.28+0.18*s; }
  float height(vec2 uv){ return tnoise(vec2(uv.x*900.,uv.y*6.),vec2(900.,6.)); }
  `,
  // broad leaf: uv.x across, uv.y along
  leaf: `
  vec3 albedo(vec2 uv){ float x=uv.x-.5; float y=uv.y;
    float rib=exp(-pow(x/0.012,2.));
    float lat=abs(fract((y-abs(x)*0.75)*11.)-.5); float vein=(1.-smoothstep(0.0,0.05,lat))*smoothstep(0.02,0.08,abs(x))*(1.-smoothstep(.4,.5,abs(x)));
    vec3 base=mix(vec3(0.030,0.085,0.022),vec3(0.06,0.14,0.035),fbm(uv*vec2(6.,12.)));
    base*=0.85+0.3*smoothstep(0.5,0.,abs(x));
    vec3 c=mix(base,vec3(0.16,0.26,0.07),vein*0.45); c=mix(c,vec3(0.35,0.42,0.16),rib*0.8);
    return c; }
  float rough(vec2 uv){ return 0.42; }
  float height(vec2 uv){ float x=uv.x-.5; float lat=abs(fract((uv.y-abs(x)*0.75)*11.)-.5);
    return -exp(-pow(x/0.015,2.))*0.6 - (1.-smoothstep(0.,0.05,lat))*0.3; }
  `,
  // sansevieria blade
  snake: `
  vec3 albedo(vec2 uv){ float x=abs(uv.x-.5);
    float band=smoothstep(.45,.6,sin((uv.y*38.+fbm(uv*vec2(4.,20.))*5.+x*4.))*.5+.5);
    vec3 c=mix(vec3(0.02,0.07,0.03),vec3(0.10,0.18,0.08),band);
    c=mix(c,vec3(0.45,0.42,0.10),smoothstep(0.43,0.47,x)); return c; }
  float rough(vec2 uv){ return 0.35; }
  float height(vec2 uv){ return 0.; }
  `,
  // abstract colour-field canvas (mapped once)
  painting: `
  float rectf(vec2 p, vec2 c, vec2 s, float soft){ vec2 d=abs(p-c)-s; float o=length(max(d,0.))+min(max(d.x,d.y),0.);
    return 1.-smoothstep(-soft,soft,o+ (fbm(p*9.)-.5)*0.03); }
  vec3 albedo(vec2 uv){ vec2 p=uv;
    vec3 c=vec3(0.30,0.08,0.05);
    c=mix(c,vec3(0.62,0.26,0.07),rectf(p,vec2(.5,.68),vec2(.40,.22),0.03));
    c=mix(c,vec3(0.13,0.04,0.06),rectf(p,vec2(.5,.27),vec2(.40,.14),0.03));
    c*=0.88+0.2*fbm(p*vec2(30.,6.));
    float canvas=tnoise(uv*vec2(700.,500.),vec2(700.,500.)); c*=0.94+0.08*canvas; return c; }
  float rough(vec2 uv){ return 0.8; }
  float height(vec2 uv){ return tnoise(uv*vec2(700.,500.),vec2(700.,500.)); }
  `,
};
